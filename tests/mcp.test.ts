import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startLearnServer, type LearnServer } from '@episteme/app-learn/server'
import { LearnSession } from '@episteme/application'
import { agentActorFor, createMcpEndpoint } from '@episteme/mcp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mcpWire, type ToolResult, type WireOptions } from './mcp-wire.js'

/**
 * The MCP surface (ADR 0008), over a real socket on the Learn host, in raw JSON-RPC — including the Host and
 * Origin checks that keep a localhost endpoint from being reached by a web page.
 */

const CLIENT = { name: 'Test Agent', version: '1.0.0' }

let directory: string
let server: LearnServer
const wire = mcpWire(() => server.mcpUrl, CLIENT)
const { rpc } = wire
const call = (name: string, args: Record<string, unknown>, options: WireOptions = {}) =>
  wire.call(name, args, {}, options)

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-mcp-'))
  server = await startLearnServer({ port: 0, filePath: join(directory, 'learn.jsonl') })
})

afterEach(async () => {
  await server.close()
  await rm(directory, { recursive: true, force: true })
})

async function events(): Promise<number> {
  const state = (await (await fetch(`${server.url}/api/state`)).json()) as { events: number }
  return state.events
}

describe('what an agent can do', () => {
  it('offers recall, propose and reflect, and nothing that confirms or writes', async () => {
    const { body } = await rpc('tools/list')
    const tools = (body['result'] as { tools: { name: string }[] }).tools.map((tool) => tool.name)
    expect(tools.sort()).toEqual(['propose', 'recall', 'reflect'])
  })

  it('has no way to call a tool that is not offered', async () => {
    const { body } = await rpc('tools/call', { name: 'record', arguments: {} })
    const failed = body['error'] !== undefined || (body['result'] as ToolResult).isError === true
    expect(failed).toBe(true)
  })
})

describe('recall', () => {
  it('says plainly when nothing has been recorded', async () => {
    const recalled = await call('recall', { question: '为什么 Transformer 必须被告知序列顺序？' })
    expect(recalled.isError).toBeUndefined()
    expect(recalled.structuredContent?.['known']).toEqual([])
    expect(recalled.content?.[0]?.text).toContain('recorded nothing')
  })

  it('returns what the human recorded, and whether it can be built on', async () => {
    await fetch(`${server.url}/api/record`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: 'q_why_order',
        dimensions: { confidence: 'high', articulation: 'high' },
      }),
    })

    const recalled = await call('recall', { question: '为什么 Transformer 必须被告知序列顺序？' })
    const known = recalled.structuredContent?.['known'] as { nodeId: string; settled: boolean }[]
    expect(known).toContainEqual(expect.objectContaining({ nodeId: 'q_why_order', settled: true }))
    expect(recalled.content?.[0]?.text).toContain('settled: build on it')
  })
})

describe('propose', () => {
  it('keeps a proposal pending, attributed to the agent, without changing anything', async () => {
    const before = await events()
    const proposed = await call('propose', {
      kind: 'state',
      target: 'q_why_order',
      dimension: 'confidence',
      level: 'medium',
      rationale: 'they explained it correctly but hesitated',
    })

    expect(proposed.isError).toBeUndefined()
    const suggestion = proposed.structuredContent?.['suggestion'] as { proposedBy: string }
    expect(proposed.structuredContent?.['status']).toBe('pending')
    expect(suggestion.proposedBy).toBe('actor_agent_test-agent')
    expect(await events()).toBe(before)

    const reflected = await call('reflect', {})
    expect(reflected.structuredContent?.['pendingSuggestions']).toBe(1)
  })

  it('refuses what could never be accepted, with the reason, as a tool result', async () => {
    const refused = await call('propose', {
      kind: 'state',
      target: 'c_missing',
      dimension: 'confidence',
      level: 'high',
      rationale: 'r',
    })
    expect(refused.isError).toBe(true)
    expect(refused.structuredContent).toMatchObject({ status: 'refused', code: 'unknown_node' })
  })

  it('says which fields a kind of proposal is missing', async () => {
    const refused = await call('propose', { kind: 'link', from: 'c_rope', rationale: 'r' })
    expect(refused.isError).toBe(true)
    expect(refused.content?.[0]?.text).toContain('link needs to, relation')
  })

  it('marks an agent that sent no identity as unidentified rather than inventing one', async () => {
    const proposed = await call(
      'propose',
      { kind: 'claim', label: '位置编码补上了顺序信息', rationale: 'r' },
      { legacy: true },
    )
    const suggestion = proposed.structuredContent?.['suggestion'] as { proposedBy: string }
    expect(suggestion.proposedBy).toBe('actor_agent_unidentified')
  })
})

describe('reflect', () => {
  it('reflects the learner’s progress back without changing it', async () => {
    const before = await events()
    const reflected = await call('reflect', {})
    expect(reflected.structuredContent?.['progress']).toMatchObject({ touched: 0 })
    expect(await events()).toBe(before)
  })
})

describe('the network boundary', () => {
  it('rejects a request from a web page on another origin', async () => {
    const { status } = await rpc('tools/list', {}, { headers: { origin: 'https://evil.example' } })
    expect(status).toBe(403)
  })

  it('rejects a request addressed to a host name other than localhost', async () => {
    const session = await LearnSession.open()
    const endpoint = createMcpEndpoint(session)
    const response = await endpoint.fetch(
      new Request('http://rebound.example/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: 'rebound.example' },
        body: '{}',
      }),
    )
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
    await endpoint.close()
    await session.close()
  })
})

describe('agent identity', () => {
  it('is derived from the client name, and never claims to be the human', () => {
    expect(agentActorFor('Claude Code')).toBe('actor_agent_claude-code')
    expect(agentActorFor(undefined)).toBe('actor_agent_unidentified')
    expect(agentActorFor('   ')).toBe('actor_agent_unidentified')
    expect(agentActorFor('human')).not.toBe('actor_human')
  })
})
