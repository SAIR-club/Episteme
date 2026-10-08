import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startService, type EpistemeService } from '@episteme/service'
import { LearnSession, type DecisionResult, type Suggestion } from '@episteme/application'
import { seedTopic } from '@episteme/application/seed'
import { asId, type NodeId } from '@episteme/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { answer, mcpWire } from './mcp-wire.js'

/**
 * Every mutation of one session runs after the one before it.
 *
 * A mutation that awaits a write would otherwise let a second one start on the same state. These tests start
 * the competing mutations together and hold the session to "exactly one decision wins": one result commits
 * or dismisses, every other finds the draft already decided, and the history holds exactly one outcome.
 */

const STATE = {
  kind: 'state',
  target: 'q_why_order',
  dimension: 'confidence',
  level: 'medium',
} as const

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-serial-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function openSeeded(): Promise<LearnSession> {
  const session = await LearnSession.open({ filePath: join(directory, 'learn.jsonl') })
  await seedTopic(session)
  return session
}

async function pending(session: LearnSession): Promise<Suggestion> {
  const result = await session.propose(STATE, {
    proposedBy: 'actor_agent_race',
    rationale: 'r',
  })
  if (!result.ok) throw new Error(result.refusal.message)
  return result.suggestion
}

function eventsOn(session: LearnSession, target: string): number {
  return session.log.history({ target: asId<NodeId>(target), actorId: session.actorId }).length
}

const winners = (results: readonly DecisionResult[]) => results.filter((result) => result.ok)

describe('decisions on one draft, started together', () => {
  it('let exactly one of several accepts commit', async () => {
    const session = await openSeeded()
    const suggestion = await pending(session)

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        session.decide(
          suggestion.id,
          { action: 'accept' },
          index % 2 === 0 ? 'learn-review' : 'mcp-elicitation',
        ),
      ),
    )

    expect(winners(results)).toHaveLength(1)
    for (const loser of results.filter((result) => !result.ok)) {
      expect(loser).toMatchObject({ refusal: { code: 'unknown_suggestion' } })
    }
    expect(eventsOn(session, 'q_why_order')).toBe(1)
    expect(session.pendingSuggestions()).toEqual([])
    await session.close()
  })

  it('let accept and dismiss agree: whichever wins, the history matches it', async () => {
    const session = await openSeeded()
    const suggestion = await pending(session)

    const [accepted, dismissed] = await Promise.all([
      session.decide(suggestion.id, { action: 'accept' }, 'mcp-elicitation'),
      session.decide(suggestion.id, { action: 'dismiss' }, 'learn-review'),
    ])

    expect(winners([accepted, dismissed])).toHaveLength(1)
    // Queued first, so the accept wins, and the dismissal finds nothing left to dismiss.
    expect(accepted).toMatchObject({ ok: true, outcome: 'accepted' })
    expect(dismissed).toMatchObject({ ok: false, refusal: { code: 'unknown_suggestion' } })
    expect(eventsOn(session, 'q_why_order')).toBe(1)
    await session.close()
  })

  it('let one of a modify and an accept win, never both', async () => {
    const session = await openSeeded()
    const suggestion = await pending(session)

    const results = await Promise.all([
      session.decide(
        suggestion.id,
        { action: 'modify', proposal: { ...STATE, level: 'low' } },
        'learn-review',
      ),
      session.decide(suggestion.id, { action: 'accept' }, 'mcp-elicitation'),
    ])

    expect(winners(results)).toHaveLength(1)
    expect(session.understandingOf('q_why_order')).toEqual([{ id: 'confidence', level: 'low' }])
    expect(eventsOn(session, 'q_why_order')).toBe(1)
    await session.close()
  })
})

describe('the Learn queue and the MCP form, deciding the same draft at once', () => {
  let server: EpistemeService

  afterEach(async () => {
    await server.close()
  })

  it('records exactly one decision', async () => {
    server = await startService({ port: 0, graph: join(directory, 'learn.jsonl') })
    const agent = mcpWire(() => server.mcpUrl, {
      name: 'Race Host',
      version: '1',
      capabilities: { elicitation: { form: {} } },
    })
    const state = async () =>
      (await (await fetch(`${server.url}/api/v1/state`)).json()) as {
        events: number
        suggestions: { id: string }[]
      }

    const asked = await agent.call('propose', { ...STATE, rationale: 'r' })
    const [draft] = (await state()).suggestions
    const before = (await state()).events

    const [viaLearn, viaMcp] = await Promise.all([
      fetch(`${server.url}/api/v1/suggestions/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: draft?.id, action: 'accept' }),
      }),
      agent.call(
        'propose',
        { ...STATE, rationale: 'r' },
        {
          requestState: asked.requestState,
          inputResponses: answer('accept', { decision: 'modify', level: 'high' }),
        },
      ),
    ])

    const learnWon = viaLearn.status === 200
    const mcpWon = viaMcp.structuredContent?.['status'] === 'modified'
    expect([learnWon, mcpWon].filter(Boolean)).toHaveLength(1)
    if (!mcpWon) expect(viaMcp.structuredContent?.['status']).toBe('not_pending')
    if (!learnWon) expect(viaLearn.status).toBe(422)

    const after = await state()
    expect(after.events).toBe(before + 1)
    expect(after.suggestions).toEqual([])
  })
})

describe('the queue itself', () => {
  it('carries on after a failed mutation', async () => {
    const session = await openSeeded()
    await expect(session.record('no_such_node', { confidence: 'high' })).rejects.toThrow()
    await session.record('q_why_order', { confidence: 'high' })
    expect(session.understandingOf('q_why_order')).toEqual([{ id: 'confidence', level: 'high' }])
    await session.close()
  })

  it('gives distinct ids to additions started together', async () => {
    const session = await openSeeded()
    const nodes = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        session.addNode({ label: `claim ${index}`, kind: 'claim' }),
      ),
    )
    expect(new Set(nodes.map((node) => node.nodeId)).size).toBe(4)
    await session.close()
  })

  it('refuses every change after the session is closed', async () => {
    const session = await openSeeded()
    const suggestion = await pending(session)
    await session.close()

    await expect(session.record('q_why_order', { confidence: 'high' })).rejects.toThrow(/closed/)
    await expect(
      session.decide(suggestion.id, { action: 'accept' }, 'learn-review'),
    ).rejects.toThrow(/closed/)
    await expect(session.addNode({ label: 'late', kind: 'claim' })).rejects.toThrow(/closed/)
  })

  it('waits for changes already under way before it closes', async () => {
    const session = await openSeeded()
    const recording = session.record('q_why_order', { confidence: 'high' })
    const closing = session.close()
    await Promise.all([recording, closing])

    const reopened = await LearnSession.open({ filePath: join(directory, 'learn.jsonl') })
    expect(reopened.understandingOf('q_why_order')).toEqual([{ id: 'confidence', level: 'high' }])
    await reopened.close()
  })
})
