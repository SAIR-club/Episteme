import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearnSession, type Proposal } from '@episteme/application'
import { seedTopic } from '@episteme/application/seed'
import { asId, isEpistemeError, type EdgeId, type NodeId } from '@episteme/core'
import { EDGE, NODE, learnTags } from '@episteme/domain-learn'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFixture, type EpistemeContext } from './fixtures.js'

/**
 * An id names one node or one edge for good.
 *
 * Core used to accept an addition over an existing id, and the storage replaced the old record in place: the
 * node or edge it named disappeared without a revocation, and the next save dropped it from the file. Edge
 * ids derived from the event count made that reachable, because accepting two links adds no event in
 * between. Core now refuses a repeated id, and the application no longer derives ids from anything that
 * repeats.
 */

function concept(context: EpistemeContext, id: string, label = id): void {
  context.graph.addNode({
    id: asId<NodeId>(id),
    type: NODE.concept,
    label,
    properties: { text: label },
    tags: learnTags('ids'),
    tier: 'reference',
  })
}

function thrown(work: () => unknown): unknown {
  try {
    work()
  } catch (error) {
    return error
  }
  throw new Error('expected a refusal')
}

describe('Core', () => {
  it('refuses a node whose id is taken, and keeps the one that has it', () => {
    const context = createFixture()
    concept(context, 'c_one', 'the original')

    const error = thrown(() => concept(context, 'c_one', 'a replacement'))
    expect(isEpistemeError(error) && error.code).toBe('duplicate_id')
    expect(context.graph.getNode(asId<NodeId>('c_one'))?.label).toBe('the original')
  })

  it('keeps a revoked node’s id taken', () => {
    const context = createFixture()
    concept(context, 'c_one')
    context.graph.revokeNode('c_one')

    const error = thrown(() => concept(context, 'c_one'))
    expect(isEpistemeError(error) && error.code).toBe('duplicate_id')
  })

  it('refuses an edge whose id is taken, and keeps the one that has it', () => {
    const context = createFixture()
    concept(context, 'c_one')
    concept(context, 'c_two')
    concept(context, 'c_three')
    const add = (to: string) =>
      context.graph.addEdge({
        id: asId<EdgeId>('e_one'),
        type: EDGE.prerequisite,
        from: asId<NodeId>('c_one'),
        to: asId<NodeId>(to),
      })
    add('c_two')

    const error = thrown(() => add('c_three'))
    expect(isEpistemeError(error) && error.code).toBe('duplicate_id')
    expect(context.graph.getEdge(asId<EdgeId>('e_one'))?.to).toBe('c_two')
  })

  it('answers a preview over a taken id with a refusal, not an exception', () => {
    const context = createFixture()
    concept(context, 'c_one')
    const preview = context.graph.previewNode({
      id: asId<NodeId>('c_one'),
      type: NODE.concept,
      label: 'x',
      properties: { text: 'x' },
      tags: learnTags('ids'),
      tier: 'reference',
    })
    expect(preview).toMatchObject({ ok: false, refusal: { code: 'duplicate_id' } })
  })
})

describe('the application', () => {
  let directory: string
  let filePath: string
  let session: LearnSession

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'episteme-ids-'))
    filePath = join(directory, 'learn.jsonl')
    session = await LearnSession.open({ filePath })
    await seedTopic(session)
  })

  afterEach(async () => {
    await session.close()
    await rm(directory, { recursive: true, force: true })
  })

  async function accept(proposal: Proposal) {
    const proposed = await session.propose(proposal, {
      proposedBy: 'actor_agent_ids',
      rationale: 'r',
    })
    if (!proposed.ok) throw new Error(proposed.refusal.message)
    return session.decide(proposed.suggestion.id, { action: 'accept' }, 'learn-review')
  }

  const between = (from: string, to: string) =>
    session.graph.listEdges().filter((edge) => edge.from === from && edge.to === to)

  it('keeps both of two links accepted between the same nodes, with no event in between', async () => {
    await accept({ kind: 'link', from: 'c_rope', to: 'c_transformer', relation: 'refers_to' })
    await accept({ kind: 'link', from: 'c_rope', to: 'c_transformer', relation: 'prerequisite' })

    const edges = between('c_rope', 'c_transformer')
    expect(edges.map((edge) => edge.type).sort()).toEqual(['prerequisite', 'refers_to'])
    expect(new Set(edges.map((edge) => edge.id)).size).toBe(2)

    // And both survive a save and a reload: nothing was replaced in place.
    await session.close()
    session = await LearnSession.open({ filePath })
    expect(between('c_rope', 'c_transformer')).toHaveLength(2)
  })

  it('refuses to propose a link that already exists', async () => {
    const refused = await session.propose(
      // Seeded: RoPE already refers to positional encoding.
      { kind: 'link', from: 'c_rope', to: 'c_positional_encoding', relation: 'refers_to' },
      { proposedBy: 'actor_agent_ids', rationale: 'r' },
    )
    expect(refused).toMatchObject({ ok: false, refusal: { code: 'duplicate_edge' } })
  })

  it('refuses the second of two identical drafts once the first is accepted, and keeps it pending', async () => {
    const link: Proposal = {
      kind: 'link',
      from: 'c_rope',
      to: 'c_transformer',
      relation: 'refers_to',
    }
    const first = await session.propose(link, { proposedBy: 'actor_agent_a', rationale: 'r' })
    const second = await session.propose(link, { proposedBy: 'actor_agent_b', rationale: 'r' })
    if (!first.ok || !second.ok) throw new Error('both drafts should be kept')

    await session.decide(first.suggestion.id, { action: 'accept' }, 'learn-review')
    const late = await session.decide(second.suggestion.id, { action: 'accept' }, 'learn-review')

    expect(late).toMatchObject({ ok: false, refusal: { code: 'duplicate_edge' } })
    expect(between('c_rope', 'c_transformer')).toHaveLength(1)
    expect(session.pendingSuggestions().map((pending) => pending.id)).toEqual([
      second.suggestion.id,
    ])
  })

  it('links a claim once to each node it names, however often it names it', async () => {
    const result = await accept({
      kind: 'claim',
      label: 'RoPE rotates by position',
      about: ['c_rope', 'c_positional_encoding', 'c_rope'],
    })
    if (!result.ok || result.outcome === 'dismissed') throw new Error('expected a claim')

    const targets = session.graph
      .listEdges()
      .filter((edge) => edge.from === result.committed.id)
      .map((edge) => edge.to)
    expect(targets.sort()).toEqual(['c_positional_encoding', 'c_rope'])
  })

  it('stores a claim’s named nodes once, as proposed', async () => {
    const proposed = await session.propose(
      { kind: 'claim', label: 'x', about: ['c_rope', 'c_rope'] },
      { proposedBy: 'actor_agent_ids', rationale: 'r' },
    )
    expect(proposed.ok && proposed.suggestion.proposal).toEqual({
      kind: 'claim',
      label: 'x',
      about: ['c_rope'],
    })
  })

  it('gives every link a distinct id, even between the same nodes', async () => {
    const one = await session.link('c_rope', 'c_transformer')
    const two = await session.link('c_rope', 'c_transformer', EDGE.prerequisite)
    expect(one.edgeId).not.toBe(two.edgeId)
  })

  it('refuses a node id the learner reuses', async () => {
    await expect(
      session.addNode({ label: 'again', kind: 'concept', id: 'c_rope' }),
    ).rejects.toThrow(/already exists/)
    expect(session.graph.getNode(asId<NodeId>('c_rope'))?.label).toContain('RoPE')
  })
})
