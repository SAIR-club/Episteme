import { asId, foldEvents, type DimensionId, type NodeId } from '@episteme/core'
import { describe, expect, it } from 'vitest'
import { DIMENSION, NODE, createFixture, dimensions, learnTags, level } from './fixtures.js'

/**
 * Current state is `reduce(events)`.
 *
 * The project's central object is "what the learner currently believes and why", so the
 * reduction has to be the single definition of "currently". Nothing may store a current
 * state that was not produced by folding the history.
 */
describe('state reduction', () => {
  function seedClaim(context: ReturnType<typeof createFixture>, id = 'claim-1'): NodeId {
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

  it('derives the current value of each dimension as the latest recorded one', () => {
    const context = createFixture()
    const claimId = seedClaim(context)

    context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions(
        [DIMENSION.confidence, level('low')],
        [DIMENSION.evidence, level('none')],
      ),
    })
    context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.evidence, level('reproduced')]),
    })

    const state = context.log.stateOf(claimId, context.humanId)
    // Unchanged dimensions keep their earlier value; changed ones take the latest.
    expect(state.get(asId<DimensionId>(DIMENSION.confidence))).toEqual({ level: 'low' })
    expect(state.get(asId<DimensionId>(DIMENSION.evidence))).toEqual({ level: 'reproduced' })
  })

  it('folds in order, so the result does not depend on which event was read first', () => {
    const context = createFixture()
    const claimId = seedClaim(context)

    const first = context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('low')]),
    })
    const second = context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('high')]),
    })

    expect(foldEvents([first, second]).get(asId<DimensionId>(DIMENSION.confidence))).toEqual({
      level: 'high',
    })
    expect(foldEvents([second, first]).get(asId<DimensionId>(DIMENSION.confidence))).toEqual({
      level: 'low',
    })
  })

  it('is unchanged by re-reading, so an internal cache cannot drift from the history', () => {
    const context = createFixture()
    const claimId = seedClaim(context)

    context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('low')]),
    })
    const cached = context.log.stateOf(claimId, context.humanId)

    // Reading again returns the same value, and the value is not a live reference a caller
    // could mutate to corrupt later reads.
    expect(context.log.stateOf(claimId, context.humanId)).toEqual(cached)

    context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('high')]),
    })
    expect(
      context.log.stateOf(claimId, context.humanId).get(asId<DimensionId>('confidence')),
    ).toEqual({ level: 'high' })
  })

  it('reports no state for a node the actor has never recorded anything about', () => {
    const context = createFixture()
    const claimId = seedClaim(context)

    expect(context.log.hasState(claimId, context.humanId)).toBe(false)
    expect(context.log.stateOf(claimId, context.humanId).size).toBe(0)
    expect(context.log.history({ target: claimId, actorId: context.humanId })).toEqual([])
  })

  it('refuses a state change for a node that does not exist', () => {
    const context = createFixture()

    expect(() =>
      context.log.commit({
        target: asId<NodeId>('missing'),
        actorId: context.humanId,
        dimensions: dimensions([DIMENSION.confidence, level('high')]),
      }),
    ).toThrow(/unknown node/i)
  })

  it('refuses an unregistered dimension and an illegal level', () => {
    const context = createFixture()
    const claimId = seedClaim(context)

    expect(() =>
      context.log.commit({
        target: claimId,
        actorId: context.humanId,
        dimensions: dimensions(['mastery', level('0.73')]),
      }),
    ).toThrow(/not registered/i)

    expect(() =>
      context.log.commit({
        target: claimId,
        actorId: context.humanId,
        dimensions: dimensions([DIMENSION.confidence, level('certain')]),
      }),
    ).toThrow(/not valid for dimension/i)
  })

  it('refuses an event that records no change at all', () => {
    const context = createFixture()
    const claimId = seedClaim(context)

    expect(() =>
      context.log.commit({
        target: claimId,
        actorId: context.humanId,
        dimensions: new Map(),
      }),
    ).toThrow(/at least one dimension/i)
  })
})
