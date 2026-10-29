import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LearnSession,
  SuggestionStore,
  type Proposal,
  type Resolution,
  type Suggestion,
} from '@episteme/application'
import { seedTopic } from './fixtures.js'
import { asId, type NodeId } from '@episteme/core'
import { SqliteStorageAdapter } from '@episteme/storage-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { storedRecords, withCompanion, writeStoredRecords } from './stored.js'

/**
 * A decision writes two things in the graph's file: the history, then the drafts. A crash between them must not let it land twice.
 *
 * Each test puts the file into the state a crash would leave, using the draft store's own write-ahead
 * API, then opens a session and holds it to one outcome: a decision whose change reached the graph is
 * completed, one whose change did not is rolled back, and deciding again never commits a second time.
 */

let directory: string
let filePath: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-recovery-'))
  filePath = join(directory, 'learn.db')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

const STATE: Proposal = {
  kind: 'state',
  target: 'q_why_order',
  dimension: 'confidence',
  level: 'high',
}
const CLAIM: Proposal = {
  kind: 'claim',
  label: 'attention needs order injected',
  about: ['c_self_attention', 'c_positional_encoding'],
}
const LINK: Proposal = {
  kind: 'link',
  from: 'c_rope',
  to: 'c_transformer',
  relation: 'refers_to',
}

/** A seeded graph with one pending draft, both written and released. */
async function withDraft(proposal: Proposal): Promise<Suggestion> {
  const session = await LearnSession.open({ filePath })
  await seedTopic(session)
  const result = await session.propose(proposal, {
    proposedBy: 'actor_agent_recovery',
    rationale: 'r',
  })
  await session.close()
  if (!result.ok) throw new Error(result.refusal.message)
  return result.suggestion
}

/** Records a decision as begun and unfinished, as a crash after `begin` would leave it. */
async function leaveUnfinished(resolution: Resolution): Promise<void> {
  await withCompanion(filePath, 'suggestions', async (log) => {
    await (await SuggestionStore.open(log)).begin(resolution)
  })
}

interface Shape {
  events: number
  claims: string[]
  edgesFromRope: number
  pending: number
}

function shapeOf(session: LearnSession): Shape {
  return {
    events: session.eventCount,
    claims: session
      .listNodes()
      .filter((node) => node.type === 'claim')
      .map((node) => node.label),
    edgesFromRope: session.graph.listEdges().filter((edge) => edge.from === 'c_rope').length,
    pending: session.pendingSuggestions().length,
  }
}

describe('a crash after the graph was written and before the draft was removed', () => {
  for (const [kind, proposal] of [
    ['state change', STATE],
    ['claim', CLAIM],
    ['link', LINK],
  ] as const) {
    it(`completes the ${kind} on the next start, once`, async () => {
      const suggestion = await withDraft(proposal)
      const draftsBefore = storedRecords(filePath, 'suggestions')

      // The real decision, run to completion: this is the graph a crash after its write leaves behind.
      const deciding = await LearnSession.open({ filePath })
      const decided = await deciding.decide(suggestion.id, { action: 'accept' }, 'learn-review')
      if (!decided.ok || decided.outcome === 'dismissed') throw new Error('expected a commit')
      const landed = shapeOf(deciding)
      const plannedEdges = deciding.graph
        .listEdges()
        .filter((edge) => edge.id.startsWith(`edge_${decided.operationId}`))
        .map((edge) => edge.id)
      await deciding.close()

      // ...while the drafts are put back to how the crash found them: the draft, and the decision begun.
      await writeStoredRecords(filePath, { logs: { suggestions: draftsBefore } })
      await leaveUnfinished({
        operationId: decided.operationId,
        suggestionId: suggestion.id,
        outcome: 'accepted',
        proposal,
        planned:
          proposal.kind === 'claim'
            ? { nodeId: decided.committed.id, edgeIds: plannedEdges }
            : { edgeIds: plannedEdges },
        channel: 'learn-review',
      })

      const recovered = await LearnSession.open({ filePath })
      expect(recovered.recovered).toEqual([
        {
          operationId: decided.operationId,
          suggestionId: suggestion.id,
          settled: 'completed',
        },
      ])
      expect(shapeOf(recovered)).toEqual({ ...landed, pending: 0 })

      // Deciding again is a no-op: the draft is gone, and nothing is committed twice.
      const again = await recovered.decide(suggestion.id, { action: 'accept' }, 'mcp-elicitation')
      expect(again).toMatchObject({ ok: false, refusal: { code: 'unknown_suggestion' } })
      expect(shapeOf(recovered)).toEqual({ ...landed, pending: 0 })
      await recovered.close()

      // And the settlement itself was written: the next start finds nothing to recover.
      const later = await LearnSession.open({ filePath })
      expect(later.recovered).toEqual([])
      expect(shapeOf(later)).toEqual({ ...landed, pending: 0 })
      await later.close()
    })
  }
})

describe('a crash after the decision was begun and before the graph was written', () => {
  it('rolls the decision back, keeps the draft, and lets it be decided once', async () => {
    const suggestion = await withDraft(CLAIM)
    await leaveUnfinished({
      operationId: 'dec_never_landed',
      suggestionId: suggestion.id,
      outcome: 'accepted',
      proposal: CLAIM,
      planned: { nodeId: 'claim_1', edgeIds: ['edge_dec_never_landed_0'] },
      channel: 'mcp-elicitation',
    })

    const session = await LearnSession.open({ filePath })
    expect(session.recovered).toEqual([
      { operationId: 'dec_never_landed', suggestionId: suggestion.id, settled: 'rolled_back' },
    ])
    expect(shapeOf(session)).toMatchObject({ claims: [], pending: 1 })

    const decided = await session.decide(suggestion.id, { action: 'accept' }, 'learn-review')
    expect(decided.ok).toBe(true)
    expect(shapeOf(session)).toMatchObject({ claims: [CLAIM.label], pending: 0 })
    await session.close()
  })
})

describe('a decision whose graph write failed', () => {
  it('is settled, not repeated, when the same draft is decided again', async () => {
    const suggestion = await withDraft(STATE)
    const session = await LearnSession.open({ filePath })

    // The graph's save fails once, as a full disk would, after the decision was recorded in the drafts.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- kept to be put back, and called with its own `this`
    const realSave = SqliteStorageAdapter.prototype.save
    SqliteStorageAdapter.prototype.save = () => Promise.reject(new Error('injected: disk full'))
    try {
      await expect(
        session.decide(suggestion.id, { action: 'accept' }, 'learn-review'),
      ).rejects.toThrow('injected')
    } finally {
      SqliteStorageAdapter.prototype.save = realSave
    }

    // The change is in memory and the decision is on record. Deciding again writes and settles it.
    const again = await session.decide(suggestion.id, { action: 'accept' }, 'learn-review')
    expect(again).toMatchObject({ ok: false, refusal: { code: 'unknown_suggestion' } })
    expect(
      session.log.history({ target: asId<NodeId>('q_why_order'), actorId: session.actorId }),
    ).toHaveLength(1)
    await session.close()

    const reopened = await LearnSession.open({ filePath })
    expect(reopened.recovered).toEqual([])
    expect(reopened.understandingOf('q_why_order')).toEqual([{ id: 'confidence', level: 'high' }])
    expect(reopened.pendingSuggestions()).toEqual([])
    await reopened.close()
  })
})

describe('the drafts', () => {
  it('still reads a version 1 log, which holds only suggestions', async () => {
    const suggestion = await withDraft(STATE)
    const v1 = storedRecords(filePath, 'suggestions').map((body) =>
      body.replace('"schemaVersion":2', '"schemaVersion":1'),
    )
    await writeStoredRecords(filePath, { logs: { suggestions: v1 } })

    const session = await LearnSession.open({ filePath })
    expect(session.pendingSuggestions().map((pending) => pending.id)).toEqual([suggestion.id])
    await session.close()
  })
})
