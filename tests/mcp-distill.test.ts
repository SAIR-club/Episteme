import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startService, type EpistemeService } from '@episteme/service'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mcpWire } from './mcp-wire.js'

/**
 * The MCP `distill` tool (ADR 0009): an agent hands over material, Episteme distils it with its own distiller,
 * and everything found waits in the learner's review queue. It is never put to the learner as a form, and it
 * records nothing.
 */

const MATERIAL = [
  '[00:05] 学生：为什么 Transformer 需要位置编码？',
  '[00:12] 老师：因为自注意力本身不区分词的顺序。',
  '[00:40] 学生：我明白了。',
].join('\n')

let directory: string
let server: EpistemeService

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-mcp-distil-'))
  server = await startService({ port: 0, graph: join(directory, 'learn.jsonl') })
})

afterEach(async () => {
  await server.close()
  await rm(directory, { recursive: true, force: true })
})

interface Surface {
  events: number
  suggestions: {
    id: string
    proposedBy: string
    requestedBy?: string
    proposal: { kind: string; nodeType?: string }
  }[]
  nodes: { label: string }[]
}
const surface = async (): Promise<Surface> =>
  (await (await fetch(`${server.url}/api/v1/state`)).json()) as Surface

describe('distill over MCP', () => {
  it('puts what it finds in the review queue, records nothing, and notes who asked', async () => {
    const agent = mcpWire(() => server.mcpUrl, { name: 'Notes Agent', version: '1' })
    const before = await surface()

    const result = await agent.call('distill', { title: '位置编码', text: MATERIAL })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent?.['status']).toBe('pending')
    expect(result.structuredContent?.['episodes']).toBe(1)

    const after = await surface()
    expect(after.events).toBe(before.events)
    expect(after.nodes).toHaveLength(before.nodes.length)
    expect(after.suggestions.length).toBe(
      (result.structuredContent?.['suggestions'] as unknown[]).length,
    )
    for (const suggestion of after.suggestions) {
      expect(suggestion.proposedBy).toBe('actor_agent_rule-based-distiller')
      expect(suggestion.requestedBy).toBe('actor_agent_notes-agent')
    }
  })

  it('never asks the learner through the host, even one that can show a form', async () => {
    const agent = mcpWire(() => server.mcpUrl, {
      name: 'Form Host',
      version: '1',
      capabilities: { elicitation: { form: {} } },
    })
    const result = await agent.call('distill', { text: MATERIAL })
    expect(result.resultType).not.toBe('input_required')
    expect(result.structuredContent?.['status']).toBe('pending')
  })

  it('refuses material too long to read, before keeping anything', async () => {
    const agent = mcpWire(() => server.mcpUrl, { name: 'Notes Agent', version: '1' })
    const result = await agent.call('distill', { text: 'x'.repeat(20_001) })
    expect(result.isError).toBe(true)
    expect((await surface()).suggestions).toEqual([])
  })

  it('leaves the decision to the learner, through the same path as everything else', async () => {
    const agent = mcpWire(() => server.mcpUrl, { name: 'Notes Agent', version: '1' })
    await agent.call('distill', { text: MATERIAL })
    const question = (await surface()).suggestions.find(
      (suggestion) =>
        suggestion.proposal.kind === 'node' && suggestion.proposal.nodeType === 'question',
    )

    const decided = await fetch(`${server.url}/api/v1/suggestions/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: question?.id, action: 'accept' }),
    })
    expect(decided.status).toBe(200)
    expect((await surface()).nodes.map((node) => node.label)).toContain(
      '为什么 Transformer 需要位置编码？',
    )
  })
})
