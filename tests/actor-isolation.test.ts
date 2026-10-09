import { asId, type DimensionId, type NodeId } from '@episteme/core'
import { describe, expect, it } from 'vitest'
import { DIMENSION, NODE, createFixture, dimensions, learnTags, level } from './fixtures.js'

/**
 * Understanding belongs to an actor, not to a node.
 *
 * The same claim carries different state for the learner and for the agent that suggested
 * it — and, more importantly, for two different learners. If state were stored on the node,
 * one person's history would silently become another person's starting point, which is both
 * a correctness failure and a privacy failure.
 */
describe('actor-state isolation', () => {
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

  it('keeps two actors\u2019 state about one node independent', () => {
    const context = createFixture()
    const claimId = seedClaim(context, 'claim-1')

    context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('high')]),
    })
    context.log.commit({
      target: claimId,
      actorId: context.agentId,
      dimensions: dimensions([DIMENSION.confidence, level('low')]),
    })

    expect(
      context.log.stateOf(claimId, context.humanId).get(asId<DimensionId>('confidence')),
    ).toEqual({ level: 'high' })
    expect(
      context.log.stateOf(claimId, context.agentId).get(asId<DimensionId>('confidence')),
    ).toEqual({ level: 'low' })
  })

  it('does not let one actor\u2019s change overwrite another\u2019s history', () => {
    const context = createFixture()
    const claimId = seedClaim(context, 'claim-1')

    const human = context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('low')]),
    })
    context.log.commit({
      target: claimId,
      actorId: context.agentId,
      dimensions: dimensions([DIMENSION.confidence, level('high')]),
    })

    // The agent's event did not become a continuation of the human's path.
    expect(context.log.history({ target: claimId, actorId: context.humanId })).toEqual([human])
    expect(context.log.getEvent(human.id)).toEqual(human)
  })

  it('gives an agent its own branch so it can never commit onto a human path', () => {
    const context = createFixture()
    const claimId = seedClaim(context, 'claim-1')

    context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('low')]),
    })

    const agentBranch = context.log.currentBranch(context.agentId)
    const humanBranch = context.log.currentBranch(context.humanId)

    expect(agentBranch.id).not.toBe(humanBranch.id)
    expect(agentBranch.actorId).toBe(context.agentId)
    expect(humanBranch.actorId).toBe(context.humanId)
  })

  it('reports no state for an actor that has recorded nothing, even when another has', () => {
    const context = createFixture()
    const claimId = seedClaim(context, 'claim-1')

    context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('high')]),
    })

    expect(context.log.hasState(claimId, context.humanId)).toBe(true)
    expect(context.log.hasState(claimId, context.agentId)).toBe(false)
    expect(context.log.stateOf(claimId, context.agentId).size).toBe(0)
  })

  it('scopes open ends to the actor who owns them', () => {
    const context = createFixture()
    const claimId = seedClaim(context, 'claim-1')

    context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('low')]),
    })
    context.log.commit({
      target: claimId,
      actorId: context.agentId,
      dimensions: dimensions([DIMENSION.confidence, level('high')]),
    })

    expect(context.log.tips(context.humanId)).toHaveLength(1)
    expect(context.log.tips(context.agentId)).toHaveLength(1)
    expect(context.log.tips().length).toBe(2)
  })

  it('records authorship separately from whose understanding changed', () => {
    const context = createFixture()
    const claimId = seedClaim(context, 'suggested-claim')

    // The agent authors the node; the human's understanding of it is what moves.
    context.graph.addNode({
      id: asId<NodeId>('agent-authored'),
      type: NODE.concept,
      label: 'Positional Encoding',
      properties: { text: 'Positional Encoding' },
      tags: learnTags('transformer'),
      tier: 'reference',
      source: 'agent:suggestion',
      actorId: context.agentId,
    })
    const event = context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('medium')]),
    })

    expect(context.graph.getNode(asId<NodeId>('agent-authored'))?.actorId).toBe(context.agentId)
    expect(event.actorId).toBe(context.humanId)
    expect(context.log.stateOf(claimId, context.agentId).size).toBe(0)
  })
})
