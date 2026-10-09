import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BLANK_TOPIC } from '@episteme/application/topic-file'
import { learnProfile, startService, type EpistemeService } from '@episteme/service'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mcpWire, type McpWire } from './mcp-wire.js'

/**
 * The Phase 4 loop, across two agents and one service (#15):
 *
 *   Agent A proposes understanding → the person reviews it → Agent B recalls it, after a restart too.
 *
 * Two MCP clients with different names stand for two agents in two different hosts. They share nothing but
 * the service, so whatever Agent B recalls of Agent A's proposal reached it only through the person's
 * decision and the graph the service owns. The person decides over REST, as the Workspace does.
 *
 * This is the executable definition of the loop. Later work extends it rather than redefining it.
 */

const ACCEPTED_CLAIM =
  'Self-attention ignores word order, so positional encoding adds each token position to its embedding'
const DISMISSED_CLAIM = 'Positional encoding is only ever learned by gradient descent'
const QUESTION = 'Why does self-attention need positional encoding for word order?'

let directory: string
let graph: string
let service: EpistemeService
let agentA: McpWire
let agentB: McpWire

/** Starts the service on the test's graph with nothing seeded, so everything in it came through the loop. */
async function start(): Promise<void> {
  service = await startService({ port: 0, graph, profile: learnProfile(BLANK_TOPIC) })
}

async function restart(): Promise<void> {
  await service.close()
  await start()
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${service.apiUrl}${path}`)
  expect(response.status).toBe(200)
  return (await response.json()) as T
}

/** The person's decision, sent the way the Workspace sends it. */
async function decide(id: string, action: 'accept' | 'dismiss'): Promise<Record<string, unknown>> {
  const response = await fetch(`${service.apiUrl}/suggestions/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, action }),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as Record<string, unknown>
}

interface Pending {
  readonly id: string
  readonly proposedBy: string
  readonly proposal: Record<string, unknown>
}

interface Recalled {
  readonly known: readonly {
    readonly nodeId: string
    readonly label: string
    readonly dimensions: readonly { readonly id: string; readonly level: string }[]
  }[]
  readonly ranked: readonly { readonly nodeId: string; readonly label: string }[]
}

async function propose(agent: McpWire, args: Record<string, unknown>): Promise<string> {
  const result = await agent.call('propose', args)
  expect(result.isError).toBeUndefined()
  expect(result.structuredContent?.['status']).toBe('pending')
  return (result.structuredContent?.['suggestion'] as Pending).id
}

async function recall(agent: McpWire): Promise<Recalled> {
  const result = await agent.call('recall', { question: QUESTION })
  expect(result.isError).toBeUndefined()
  return result.structuredContent as unknown as Recalled
}

async function toolNames(agent: McpWire): Promise<readonly string[]> {
  const { body } = await agent.rpc('tools/list')
  const tools = (body['result'] as { tools: { name: string }[] }).tools
  return tools.map((tool) => tool.name).sort()
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-cross-agent-'))
  graph = join(directory, 'learn.jsonl')
  await start()
  // Each wire reads the service's address when it calls, so both survive a restart on a new port.
  agentA = mcpWire(() => service.mcpUrl, { name: 'agent-a', version: '1' })
  agentB = mcpWire(() => service.mcpUrl, { name: 'agent-b', version: '1' })
})

afterEach(async () => {
  await service.close()
  await rm(directory, { recursive: true, force: true })
})

describe('understanding one agent proposed, recalled by another', () => {
  it('reaches the second agent only through the person’s decision, and survives a restart', async () => {
    // 1. Agent A proposes. Nothing reaches the graph or the history, so Agent B finds nothing.
    const kept = await propose(agentA, {
      kind: 'claim',
      label: ACCEPTED_CLAIM,
      rationale: 'the learner explained it this way in our session',
    })
    const dropped = await propose(agentA, {
      kind: 'claim',
      label: DISMISSED_CLAIM,
      rationale: 'the learner wondered about this',
    })

    const pending = await get<{ suggestions: Pending[] }>('/suggestions')
    expect(pending.suggestions.map((suggestion) => suggestion.id)).toEqual([kept, dropped])
    expect(new Set(pending.suggestions.map((suggestion) => suggestion.proposedBy))).toEqual(
      new Set(['actor_agent_agent-a']),
    )
    const before = await get<{ nodes: unknown[]; events: number }>('/state')
    expect(before.nodes).toEqual([])
    expect(before.events).toBe(0)
    expect(await recall(agentB)).toMatchObject({ known: [], ranked: [] })

    // 2. The person accepts one claim and dismisses the other.
    const accepted = await decide(kept, 'accept')
    const claimId = (accepted['result'] as { committed: { id: string } }).committed.id
    await decide(dropped, 'dismiss')

    // 3. Agent A proposes a change of confidence on the claim the person now holds; the person accepts it.
    const confidence = await propose(agentA, {
      kind: 'state',
      target: claimId,
      dimension: 'confidence',
      level: 'high',
      rationale: 'the learner explained it again without help',
    })
    await decide(confidence, 'accept')
    expect((await get<{ suggestions: Pending[] }>('/suggestions')).suggestions).toEqual([])

    // 4. Agent B recalls the accepted claim with the confirmed state, and nothing of the dismissed one.
    const recalled = await recall(agentB)
    expect(recalled.ranked[0]).toMatchObject({ nodeId: claimId, label: ACCEPTED_CLAIM })
    expect(recalled.known).toEqual([
      expect.objectContaining({
        nodeId: claimId,
        label: ACCEPTED_CLAIM,
        dimensions: [{ id: 'confidence', level: 'high' }],
      }),
    ])
    const labels = (await get<{ nodes: { label: string }[] }>('/state')).nodes.map(
      (node) => node.label,
    )
    expect(labels).toEqual([ACCEPTED_CLAIM])
    expect(JSON.stringify(recalled)).not.toContain(DISMISSED_CLAIM)

    // 5. A new process on the same graph gives Agent B the same understanding.
    await restart()
    expect(await recall(agentB)).toEqual(recalled)
    expect((await get<{ suggestions: Pending[] }>('/suggestions')).suggestions).toEqual([])

    // 6. Provenance: the claim names its suggestion; the state change names the suggestion, the proposing
    // agent and the channel, and is confirmed by the service's own human, never by an agent.
    const { nodes } = await get<{ nodes: { nodeId: string; fromSuggestion?: string }[] }>('/state')
    expect(nodes).toEqual([expect.objectContaining({ nodeId: claimId, fromSuggestion: kept })])

    const { events } = await get<{
      events: {
        actorId: string
        source?: string
        dimensions: [string, Record<string, unknown>][]
      }[]
    }>(`/nodes/${encodeURIComponent(claimId)}/history`)
    expect(events).toHaveLength(1)
    const [event] = events
    expect(event?.actorId).toBe('actor_human')
    expect(event?.dimensions).toEqual([
      [
        'confidence',
        { level: 'high', authority: 'confirmed', confirmedBy: 'actor_human', sourceOf: confidence },
      ],
    ])
    expect(event?.source).toContain(`suggestion ${confidence} from actor_agent_agent-a`)
    expect(event?.source).toContain('accepted via learn-review')
  })

  it('gives neither agent a way to decide', async () => {
    const expected = ['distill', 'propose', 'recall', 'reflect']
    expect(await toolNames(agentA)).toEqual(expected)
    expect(await toolNames(agentB)).toEqual(expected)
  })

  it.todo(
    'carries Agent A’s host-extracted candidates with verified quotes through the same loop (#16)',
  )

  it.todo(
    'keeps an agent from deciding its own proposal over REST, as far as ADR 0012 decides (#17)',
  )
})
