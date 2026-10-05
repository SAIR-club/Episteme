import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startLearnServer, type LearnServer } from '@episteme/app-learn/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { answer, mcpWire, type McpWire, type ToolResult } from './mcp-wire.js'

/**
 * The confirmation flow end to end (ADR 0008), across the surfaces that share it.
 *
 * An agent proposes over MCP; the learner decides either in the form the agent's host shows them or in the
 * Learn review queue; both go through one decision path into the graph file. Each test reads the outcome
 * where it finally lives — in what the agent recalls afterwards, in what the Learn surface shows, and in the
 * event history on disk — and some of them restart the host in between, because a decision that does not
 * survive a restart was not made.
 */

let directory: string
let filePath: string
let server: LearnServer

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-flow-'))
  filePath = join(directory, 'learn.jsonl')
  server = await startLearnServer({ port: 0, filePath })
})

afterEach(async () => {
  await server.close()
  await rm(directory, { recursive: true, force: true })
})

/** An agent on a host that can show its user a form. */
function formHost(name: string): McpWire {
  return mcpWire(() => server.mcpUrl, { name, version: '1', capabilities: { elicitation: {} } })
}

/** An agent on a host that cannot. */
function plainHost(name: string): McpWire {
  return mcpWire(() => server.mcpUrl, { name, version: '1' })
}

async function restartHost(): Promise<void> {
  await server.close()
  server = await startLearnServer({ port: 0, filePath })
}

async function learn<T>(path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(
    `${server.url}${path}`,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
  )
  return { status: response.status, body: (await response.json()) as T }
}

interface Surface {
  events: number
  suggestions: { id: string; proposedBy: string }[]
  understanding: Record<string, { id: string; level: string }[]>
}

const surface = async (): Promise<Surface> => (await learn<Surface>('/api/state')).body

interface StoredValue {
  level?: string
  authority?: string
  confirmedBy?: string
  sourceOf?: string
}

/** The state events as they are on disk, after the host has written them. */
async function eventsOnDisk(): Promise<
  { target: string; actorId: string; source?: string; values: Record<string, StoredValue> }[]
> {
  const lines = (await readFile(filePath, 'utf8')).split('\n').filter((line) => line.trim() !== '')
  return lines
    .map(
      (line) =>
        JSON.parse(line) as {
          kind: string
          event?: {
            target: string
            actorId: string
            source?: string
            dimensions: [string, StoredValue][]
          }
        },
    )
    .filter((record) => record.kind === 'event' && record.event !== undefined)
    .map((record) => {
      const event = record.event!
      return {
        target: event.target,
        actorId: event.actorId,
        ...(event.source === undefined ? {} : { source: event.source }),
        values: Object.fromEntries(event.dimensions),
      }
    })
}

const ORDER_CONFIDENCE = {
  kind: 'state',
  target: 'q_why_order',
  dimension: 'confidence',
  level: 'high',
  rationale: 'they derived it from permutation invariance without help',
}

function knownIds(recalled: ToolResult): string[] {
  return ((recalled.structuredContent?.['known'] ?? []) as { nodeId: string }[]).map(
    (entry) => entry.nodeId,
  )
}

describe('an agent proposes, the learner accepts in the host’s form', () => {
  it('becomes the learner’s confirmed understanding, recalled by the agent and kept across a restart', async () => {
    const agent = formHost('Claude Code')
    const question = { question: '为什么 Transformer 必须被告知序列顺序？' }
    expect(knownIds(await agent.call('recall', question))).not.toContain('q_why_order')

    const asked = await agent.call('propose', ORDER_CONFIDENCE)
    expect(asked.resultType).toBe('input_required')
    const done = await agent.call('propose', ORDER_CONFIDENCE, {
      requestState: asked.requestState,
      inputResponses: answer('accept', { decision: 'accept' }),
    })
    expect(done.structuredContent?.['status']).toBe('accepted')

    // The agent now builds on it.
    expect(knownIds(await agent.call('recall', question))).toContain('q_why_order')

    // On disk: the human's event, confirmed by the human, naming the agent and the channel.
    const [event] = await eventsOnDisk()
    expect(event?.target).toBe('q_why_order')
    expect(event?.actorId).toBe('actor_human')
    expect(event?.values['confidence']).toMatchObject({
      level: 'high',
      authority: 'confirmed',
      confirmedBy: 'actor_human',
    })
    expect(event?.source).toContain('actor_agent_claude-code')
    expect(event?.source).toContain('accepted via mcp-elicitation')

    await restartHost()
    const after = await surface()
    expect(after.understanding['q_why_order']).toEqual([{ id: 'confidence', level: 'high' }])
    expect(after.suggestions).toEqual([])
    expect(knownIds(await formHost('Claude Code').call('recall', question))).toContain(
      'q_why_order',
    )
  })
})

describe('an agent without a form proposes, the learner decides in Learn', () => {
  it('records the learner’s own value, and the agent sees the result', async () => {
    const agent = plainHost('Plain Agent')
    const kept = await agent.call('propose', ORDER_CONFIDENCE)
    expect(kept.structuredContent?.['status']).toBe('pending')
    expect((await agent.call('reflect', {})).structuredContent?.['pendingSuggestions']).toBe(1)

    const [pending] = (await surface()).suggestions
    const decided = await learn('/api/suggestions/decide', {
      id: pending?.id,
      action: 'modify',
      proposal: { kind: 'state', target: 'q_why_order', dimension: 'confidence', level: 'low' },
    })
    expect(decided.status).toBe(200)

    const reflected = await agent.call('reflect', {})
    expect(reflected.structuredContent?.['pendingSuggestions']).toBe(0)
    expect(reflected.structuredContent?.['progress']).toMatchObject({ touched: 1 })

    const [event] = await eventsOnDisk()
    expect(event?.values['confidence']).toEqual({ level: 'low', sourceOf: pending?.id })
    expect(event?.source).toContain('modified via learn-review')
  })

  it('records a claim the learner accepted, linked to what it is about', async () => {
    await plainHost('Plain Agent').call('propose', {
      kind: 'claim',
      label: '位置编码给每个词加上了它在序列中的位置',
      about: ['c_positional_encoding'],
      rationale: 'this is how they summarised it',
    })
    const [pending] = (await surface()).suggestions
    await learn('/api/suggestions/decide', { id: pending?.id, action: 'accept' })

    await restartHost()
    const { body } = await learn<{ nodes: { nodeId: string; label: string; type: string }[] }>(
      '/api/state',
    )
    expect(body.nodes.map((node) => node.label)).toContain('位置编码给每个词加上了它在序列中的位置')
  })
})

describe('the two channels meet', () => {
  it('lets the first decision stand: a form answered after the learner dismissed in Learn changes nothing', async () => {
    const agent = formHost('Claude Code')
    const asked = await agent.call('propose', ORDER_CONFIDENCE)
    const [pending] = (await surface()).suggestions
    await learn('/api/suggestions/decide', { id: pending?.id, action: 'dismiss' })

    const late = await agent.call('propose', ORDER_CONFIDENCE, {
      requestState: asked.requestState,
      inputResponses: answer('accept', { decision: 'accept' }),
    })
    expect(late.structuredContent?.['status']).toBe('not_pending')
    expect(await eventsOnDisk()).toEqual([])
  })

  it('keeps a draft the learner left unanswered in the form, for the review queue', async () => {
    const agent = formHost('Claude Code')
    const asked = await agent.call('propose', ORDER_CONFIDENCE)
    await agent.call('propose', ORDER_CONFIDENCE, {
      requestState: asked.requestState,
      inputResponses: answer('cancel'),
    })

    const [pending] = (await surface()).suggestions
    const decided = await learn('/api/suggestions/decide', { id: pending?.id, action: 'accept' })
    expect(decided.status).toBe(200)
    expect((await eventsOnDisk())[0]?.source).toContain('accepted via learn-review')
  })

  it('fails closed when the host restarted between the rounds, and keeps the draft', async () => {
    const asked = await formHost('Claude Code').call('propose', ORDER_CONFIDENCE)
    await restartHost()

    // The new process holds a new key, so the state minted before the restart cannot be verified.
    const { body } = await formHost('Claude Code').rpc('tools/call', {
      name: 'propose',
      arguments: ORDER_CONFIDENCE,
      requestState: asked.requestState,
      inputResponses: answer('accept', { decision: 'accept' }),
    })
    expect((body['error'] as { code: number } | undefined)?.code).toBe(-32602)
    expect(await eventsOnDisk()).toEqual([])
    expect((await surface()).suggestions).toHaveLength(1)
  })
})

describe('provenance is not authority', () => {
  it('records which agent proposed each change, while the confirming human is always the host’s', async () => {
    for (const name of ['Agent One', 'actor_human']) {
      const agent = formHost(name)
      const asked = await agent.call('propose', {
        ...ORDER_CONFIDENCE,
        target: name === 'Agent One' ? 'q_why_order' : 'c_rope',
      })
      await agent.call('propose', ORDER_CONFIDENCE, {
        requestState: asked.requestState,
        inputResponses: answer('accept', { decision: 'accept' }),
      })
    }

    const events = await eventsOnDisk()
    expect(events.map((event) => event.values['confidence']?.confirmedBy)).toEqual([
      'actor_human',
      'actor_human',
    ])
    // A client calling itself "actor_human" is still recorded as an agent.
    expect(events[0]?.source).toContain('actor_agent_agent-one')
    expect(events[1]?.source).toContain('actor_agent_actor-human')
  })

  it('gives an agent no argument through which to name who confirmed', async () => {
    const refused = await formHost('Claude Code').call('propose', {
      ...ORDER_CONFIDENCE,
      confirmedBy: 'actor_human',
    })
    expect(refused.isError).toBe(true)
    expect((await surface()).suggestions).toEqual([])
  })
})
