import { asId, type DimensionId, type NodeId } from '@episteme/core'
import { describe, expect, it } from 'vitest'
import { DIMENSION, NODE, createFixture, dimensions, learnTags, level } from './fixtures.js'

/**
 * Forking is a first-class operation.
 *
 * "I reached this understanding, and then I went in two different directions from it" is a
 * shape this system must be able to express. That requires interaction history to be a DAG
 * rather than an append-only message list, which is exactly what these tests pin down.
 */
describe('fork preserves ancestry', () => {
  function seedClaim(context: ReturnType<typeof createFixture>, id: string): NodeId {
    const nodeId = asId<NodeId>(id)
    context.graph.addNode({
      id: nodeId,
      type: NODE.claim,
      label: 'Self-attention does not encode sequence order itself.',
      properties: { text: 'Self-attention does not encode sequence order itself.' },
      tags: learnTags('transformer'),
      tier: 'thought',
      source: 'session:1',
    })
    return nodeId
  }

  it('continues from an earlier point without touching the events that led there', () => {
    const context = createFixture()
    const claimId = seedClaim(context, 'claim-1')

    const first = context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions(['confidence', level('low')]),
      reason: 'first reading',
    })

    const { event: forked, branch } = context.log.fork({
      from: first.id,
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions(['confidence', level('medium')]),
      reason: 'tried it on a small example',
    })

    // The new path records where it split off. Its root continues from the fork point so the
    // branch's own read can reach the understanding it started from, while `forkedFrom` records
    // that this is a divergence rather than a continuation.
    expect(forked.forkedFrom).toBe(first.id)
    expect(forked.parent).toBe(first.id)
    expect(context.log.branchAncestry(branch.id)).toEqual([context.log.defaultBranchId, branch.id])

    // The original event is byte-for-byte unchanged.
    expect(context.log.getEvent(first.id)).toEqual(first)

    // Both events remain readable, and the fork did not rewrite history.
    expect(context.log.eventCount).toBe(2)
    const history = context.log.history(
      { target: claimId, actorId: context.humanId },
      { order: 'ascending' },
    )
    expect(history.map((event) => event.id)).toEqual([first.id, forked.id])
  })

  it('lets two different paths start from the same earlier understanding', () => {
    const context = createFixture()
    const claimId = seedClaim(context, 'claim-1')

    const root = context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions(['confidence', level('low')]),
      reason: 'first reading',
    })

    // From the same point, two separate explorations.
    const pathA = context.log.fork({
      from: root.id,
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions(['confidence', level('high')]),
      reason: 'path A: read the derivation',
    })
    const pathB = context.log.fork({
      from: root.id,
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions(['confidence', level('low')], ['conflict', level('open')]),
      reason: 'path B: found a counterexample',
    })

    expect(pathB.event.forkedFrom).toBe(root.id)
    expect(pathB.branch.id).not.toBe(pathA.branch.id)

    // Three lines of inquiry now exist: the original, and the two that diverged from it. Each
    // is an open end in its own right, which is exactly what "I went two ways from here" means.
    const tips = context.log.tips(context.humanId)
    expect(tips.map((event) => event.id).sort()).toEqual(
      [root.id, pathA.event.id, pathB.event.id].sort(),
    )
    expect(tips).toHaveLength(3)

    // Both paths keep the same common ancestor.
    expect(context.log.branchAncestry(pathA.branch.id)).toContain(context.log.defaultBranchId)
    expect(context.log.branchAncestry(pathB.branch.id)).toContain(context.log.defaultBranchId)
  })

  it('allows forking an event that a later event already continued', () => {
    const context = createFixture()
    const claimId = seedClaim(context, 'claim-1')

    const root = context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('low')]),
    })
    const later = context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('high')]),
    })

    // Going back to what was understood *before* the refinement is the point of forking. The
    // new branch reads only its own lineage, so it must not inherit the later change.
    const revisit = context.log.fork({
      from: root.id,
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.conflict, level('open')]),
      reason: 'reconsidering the earlier answer',
    })

    expect(revisit.event.forkedFrom).toBe(root.id)
    // The branch root continues from the fork point so the branch's own read can reach the
    // understanding it started from; `forkedFrom` records *why* it starts there.
    expect(revisit.event.parent).toBe(root.id)

    // On the new line, confidence is whatever it was at the fork point — the later `high` is
    // not inherited, which is what makes going back to an earlier understanding meaningful.
    const onBranch = context.log.stateOf(claimId, context.humanId, { branchId: revisit.branch.id })
    expect(onBranch.get(asId<DimensionId>(DIMENSION.confidence))).toEqual({ level: 'low' })
    expect(onBranch.get(asId<DimensionId>(DIMENSION.conflict))).toEqual({ level: 'open' })

    // The original line still stands as its own line of inquiry.
    const onOrigin = context.log.stateOf(claimId, context.humanId, {
      branchId: context.log.defaultBranchId,
    })
    expect(onOrigin.get(asId<DimensionId>(DIMENSION.confidence))).toEqual({ level: 'high' })
    expect(context.log.getEvent(later.id)).toEqual(later)
  })

  it('commits onto the new path after a fork, and never onto the old one', () => {
    const context = createFixture()
    const claimId = seedClaim(context, 'claim-1')

    const root = context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions(['confidence', level('low')]),
    })
    const { branch } = context.log.fork({
      from: root.id,
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions(['confidence', level('medium')]),
      reason: 'reconsidering',
    })

    const followUp = context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions(['confidence', level('high')]),
      reason: 'now convinced',
    })

    expect(followUp.branchId).toBe(branch.id)
    // The original branch stopped where it was forked; nothing was appended to it.
    expect(
      context.log.eventsOfBranch(context.log.defaultBranchId).map((event) => event.id),
    ).toEqual([root.id])
    // Current state comes from the new path.
    expect(
      context.log.stateOf(claimId, context.humanId).get(asId<DimensionId>('confidence')),
    ).toEqual({ level: 'high' })
  })

  it('refuses to fork another actor\u2019s path', () => {
    const context = createFixture()
    const claimId = seedClaim(context, 'claim-1')

    const humanEvent = context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions(['confidence', level('low')]),
    })

    expect(() =>
      context.log.fork({
        from: humanEvent.id,
        target: claimId,
        actorId: context.agentId,
        dimensions: dimensions(['confidence', level('high')]),
      }),
    ).toThrow(/another actor/i)
  })
})
