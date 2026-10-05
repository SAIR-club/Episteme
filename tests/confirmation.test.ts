import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearnSession, type Proposal, type Suggestion } from '@episteme/application'
import { seedTopic } from '@episteme/app-learn/seed'
import { asId, type DimensionId, type NodeId } from '@episteme/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * The one path from a human decision to the graph (ADR 0008).
 *
 * Every channel calls `decide`, so these are the semantics of accept, modify and dismiss everywhere: accept
 * commits the agent's value as confirmed by this session's human, modify commits the human's own value as
 * authored, and dismiss commits nothing at all.
 */

const AGENT = 'actor_agent_confirm-test'
const CONFIDENCE = asId<DimensionId>('confidence')

let directory: string
let filePath: string
let session: LearnSession

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-confirm-'))
  filePath = join(directory, 'learn.jsonl')
  session = await LearnSession.open({ filePath })
  await seedTopic(session)
})

afterEach(async () => {
  await session.close()
  await rm(directory, { recursive: true, force: true })
})

async function pending(proposal: Proposal): Promise<Suggestion> {
  const result = await session.propose(proposal, {
    proposedBy: AGENT,
    rationale: 'because the learner said so',
  })
  if (!result.ok) throw new Error(result.refusal.message)
  return result.suggestion
}

const STATE: Proposal = {
  kind: 'state',
  target: 'q_why_order',
  dimension: 'confidence',
  level: 'medium',
}

function lastEventOn(target: string) {
  const history = session.log.history({
    target: asId<NodeId>(target),
    actorId: session.actorId,
  })
  return history.at(-1)
}

describe('accept', () => {
  it('commits the agent’s value as confirmed by this session’s human, and names where it came from', async () => {
    const suggestion = await pending(STATE)
    const result = await session.decide(suggestion.id, { action: 'accept' }, 'learn-review')

    expect(result).toMatchObject({ ok: true, outcome: 'accepted', committed: { kind: 'event' } })
    const event = lastEventOn('q_why_order')
    expect(event?.dimensions.get(CONFIDENCE)).toEqual({
      level: 'medium',
      authority: 'confirmed',
      confirmedBy: session.actorId,
      sourceOf: suggestion.id,
    })
    expect(event?.actorId).toBe(session.actorId)
    expect(event?.source).toContain(suggestion.id)
    expect(event?.source).toContain(AGENT)
    expect(event?.source).toContain('learn-review')
    expect(session.understandingOf('q_why_order')).toEqual([{ id: 'confidence', level: 'medium' }])
    expect(session.pendingSuggestions()).toHaveLength(0)
  })

  it('adds an accepted claim, linked to what it is about', async () => {
    const suggestion = await pending({
      kind: 'claim',
      label: '自注意力不区分顺序',
      about: ['c_self_attention', 'c_permutation_invariance'],
    })
    const result = await session.decide(suggestion.id, { action: 'accept' }, 'mcp-elicitation')
    if (!result.ok || result.outcome === 'dismissed') throw new Error('expected a committed claim')

    const claim = session.graph.getNode(asId<NodeId>(result.committed.id))
    expect(claim?.label).toBe('自注意力不区分顺序')
    expect(claim?.source).toContain('mcp-elicitation')
    const targets = session.graph
      .listEdges()
      .filter((edge) => edge.from === claim?.id)
      .map((edge) => edge.to)
    expect(targets.sort()).toEqual(['c_permutation_invariance', 'c_self_attention'])
  })

  it('adds an accepted link', async () => {
    const suggestion = await pending({
      kind: 'link',
      from: 'c_rope',
      to: 'c_permutation_invariance',
      relation: 'refers_to',
    })
    const result = await session.decide(suggestion.id, { action: 'accept' }, 'learn-review')
    if (!result.ok || result.outcome === 'dismissed') throw new Error('expected a committed edge')

    const edge = session.graph.listEdges().find((candidate) => candidate.id === result.committed.id)
    expect(edge).toMatchObject({ from: 'c_rope', to: 'c_permutation_invariance' })
  })

  it('withdraws a claim whose links the graph refuses, and keeps the draft', async () => {
    // A claim may refer to concepts and questions, not to another claim.
    const other = await session.addNode({ label: 'an existing claim', kind: 'claim' })
    const suggestion = await pending({
      kind: 'claim',
      label: 'about a claim',
      about: [other.nodeId],
    })

    const result = await session.decide(suggestion.id, { action: 'accept' }, 'learn-review')
    expect(result.ok).toBe(false)
    expect(session.listNodes().map((node) => node.label)).not.toContain('about a claim')
    expect(session.pendingSuggestions().map((pendingOne) => pendingOne.id)).toEqual([suggestion.id])
  })
})

describe('modify', () => {
  it('commits the human’s own value as authored, not confirmed', async () => {
    const suggestion = await pending(STATE)
    const result = await session.decide(
      suggestion.id,
      { action: 'modify', proposal: { ...STATE, level: 'low' } },
      'learn-review',
    )

    expect(result).toMatchObject({ ok: true, outcome: 'modified' })
    const value = lastEventOn('q_why_order')?.dimensions.get(CONFIDENCE)
    expect(value?.level).toBe('low')
    expect(value?.authority).toBeUndefined()
    expect(value?.confirmedBy).toBeUndefined()
    expect(lastEventOn('q_why_order')?.source).toContain('modified via learn-review')
  })

  it('holds the human’s value to the same checks as the agent’s, and keeps the draft on refusal', async () => {
    const suggestion = await pending(STATE)
    const invalid = await session.decide(
      suggestion.id,
      { action: 'modify', proposal: { ...STATE, level: 'total' } },
      'learn-review',
    )
    const otherKind = await session.decide(
      suggestion.id,
      { action: 'modify', proposal: { kind: 'claim', label: 'something else' } },
      'learn-review',
    )

    expect(invalid).toMatchObject({ ok: false, refusal: { code: 'invalid_dimension_value' } })
    expect(otherKind).toMatchObject({ ok: false, refusal: { code: 'kind_changed' } })
    expect(session.pendingSuggestions()).toHaveLength(1)
    expect(session.understandingOf('q_why_order')).toEqual([])
  })
})

describe('dismiss', () => {
  it('removes the draft and commits nothing', async () => {
    const suggestion = await pending(STATE)
    const events = session.eventCount
    const nodes = session.listNodes().length

    const result = await session.decide(suggestion.id, { action: 'dismiss' }, 'learn-review')

    expect(result).toMatchObject({ ok: true, outcome: 'dismissed' })
    expect(session.eventCount).toBe(events)
    expect(session.listNodes().length).toBe(nodes)
    expect(session.pendingSuggestions()).toHaveLength(0)
  })
})

describe('a decision', () => {
  it('is made once: a decided suggestion cannot be decided again', async () => {
    const suggestion = await pending(STATE)
    await session.decide(suggestion.id, { action: 'accept' }, 'learn-review')
    const again = await session.decide(suggestion.id, { action: 'accept' }, 'mcp-elicitation')
    expect(again).toMatchObject({ ok: false, refusal: { code: 'unknown_suggestion' } })
    expect(
      session.log.history({ target: asId<NodeId>('q_why_order'), actorId: session.actorId }),
    ).toHaveLength(1)
  })

  it('survives a restart, with the draft gone', async () => {
    const suggestion = await pending(STATE)
    await session.decide(suggestion.id, { action: 'accept' }, 'learn-review')
    await session.close()

    session = await LearnSession.open({ filePath })
    expect(session.understandingOf('q_why_order')).toEqual([{ id: 'confidence', level: 'medium' }])
    expect(session.pendingSuggestions()).toHaveLength(0)
  })
})
