import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startService, type EpistemeService } from '@episteme/service'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mcpWire, type McpWire } from './mcp-wire.js'

/**
 * REST and MCP give the same answer to the same question (ADR 0010, decision 4).
 *
 * Both protocols call the same commands and queries in the application layer. These tests hold them to it on
 * the wire, so a route or a tool that starts shaping its own result is caught, and they hold MCP to having no
 * way to decide.
 */

const MATERIAL = [
  '[00:05] 学生：为什么 Transformer 需要位置编码？',
  '[00:12] 老师：因为自注意力本身不区分词的顺序。例如把句子里的词打乱，注意力的输出只是跟着重新排列。',
  '[00:40] 学生：我明白了。',
].join('\n')

let directory: string
let service: EpistemeService
let agent: McpWire

async function rest<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    `${service.apiUrl}${path}`,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
  )
  expect(response.status).toBe(200)
  return (await response.json()) as T
}

/** A result without its revision, which only REST reports. */
function withoutRevision(body: Record<string, unknown>): Record<string, unknown> {
  const { revision: _revision, ...rest } = body
  return rest
}

async function structured(name: string, args: Record<string, unknown>) {
  const result = await agent.call(name, args)
  expect(result.isError).toBeUndefined()
  return result.structuredContent ?? {}
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-contract-'))
  service = await startService({ port: 0, graph: join(directory, 'learn.jsonl') })
  agent = mcpWire(() => service.mcpUrl, { name: 'Contract Agent', version: '1' })
})

afterEach(async () => {
  await service.close()
  await rm(directory, { recursive: true, force: true })
})

describe('the same question over REST and MCP', () => {
  it('recalls the same thing', async () => {
    await rest('/record', { target: 'q_why_order', dimensions: { confidence: 'low' } })
    for (const question of ['why does attention need positions', '自注意力为什么需要位置信息']) {
      const overRest = withoutRevision(await rest('/recall', { question }))
      const overMcp = await structured('recall', { question })
      expect(overRest).toEqual(overMcp)
    }
  })

  it('reflects the same thing', async () => {
    await rest('/record', { target: 'q_why_order', dimensions: { confidence: 'high' } })
    await agent.call('propose', {
      kind: 'state',
      target: 'q_why_order',
      dimension: 'confidence',
      level: 'medium',
      rationale: 'they hedged',
    })
    expect(withoutRevision(await rest('/reflect'))).toEqual(await structured('reflect', {}))
  })

  it('distils the same material into the same suggestions', async () => {
    // Two graphs, one per protocol, so neither run sees the other's suggestions.
    const second = await startService({ port: 0, graph: join(directory, 'second.jsonl') })
    try {
      const overRest = await rest<{ suggestions: { proposal: unknown; excerpt?: string }[] }>(
        '/distill',
        { title: '位置编码', text: MATERIAL },
      )
      const otherAgent = mcpWire(() => second.mcpUrl, { name: 'Contract Agent', version: '1' })
      const overMcp = (await otherAgent.call('distill', { title: '位置编码', text: MATERIAL }))
        .structuredContent as { suggestions: { proposal: unknown; excerpt?: string }[] }

      // Suggestion ids are fresh in each graph, and a candidate refers to another by its id, so the
      // comparison is of what was found and the words it came from.
      const shape = (list: { proposal: unknown; excerpt?: string }[]) =>
        list.map(({ proposal, excerpt }) => {
          const { kind, nodeType, label, relation, dimension, level } = proposal as Record<
            string,
            unknown
          >
          return { kind, nodeType, label, relation, dimension, level, excerpt }
        })
      expect(overRest.suggestions.length).toBeGreaterThan(0)
      expect(shape(overRest.suggestions)).toEqual(shape(overMcp.suggestions))
    } finally {
      await second.close()
    }
  })
})

describe('deciding', () => {
  it('is not something MCP offers, under any name', async () => {
    const { body } = await agent.rpc('tools/list')
    const tools = (body['result'] as { tools: { name: string }[] }).tools.map((tool) => tool.name)
    expect([...tools].sort()).toEqual(['distill', 'propose', 'recall', 'reflect'])
    expect(tools.some((name) => /decide|confirm|accept|dismiss|commit/i.test(name))).toBe(false)
  })
})

describe('revisions', () => {
  it('stay equal while nothing changes, across every read', async () => {
    const state = await rest<{ revision: number }>('/state')
    const suggestions = await rest<{ revision: number }>('/suggestions')
    const reflected = await rest<{ revision: number }>('/reflect')
    const recalled = await rest<{ revision: number }>('/recall', { question: 'positions' })
    await agent.call('recall', { question: 'positions' })

    expect(state.revision % 2).toBe(0)
    for (const read of [suggestions, reflected, recalled])
      expect(read.revision).toBe(state.revision)
    expect((await rest<{ revision: number }>('/state')).revision).toBe(state.revision)
  })

  it('advance across a change from either protocol, and the change reports where it left them', async () => {
    const before = (await rest<{ revision: number }>('/state')).revision

    await agent.call('propose', {
      kind: 'state',
      target: 'q_why_order',
      dimension: 'confidence',
      level: 'medium',
      rationale: 'r',
    })
    const proposed = await rest<{ revision: number; suggestions: { id: string }[] }>('/suggestions')
    expect(proposed.revision).toBeGreaterThan(before)

    const decided = await rest<{ revision: number }>('/suggestions/decide', {
      id: proposed.suggestions[0]?.id,
      action: 'accept',
    })
    expect(decided.revision).toBeGreaterThan(proposed.revision)
    expect(decided.revision % 2).toBe(0)
    expect((await rest<{ revision: number }>('/state')).revision).toBe(decided.revision)
  })
})
