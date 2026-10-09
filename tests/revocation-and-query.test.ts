import { asId, type DimensionId, type EdgeId, type NodeId } from '@episteme/core'
import { describe, expect, it } from 'vitest'
import { DIMENSION, EDGE, NODE, createFixture, dimensions, learnTags, level } from './fixtures.js'

/**
 * Retraction, and finding things.
 *
 * A cognitive system needs a way to withdraw something without pretending it never happened.
 * Deleting the record would erase the fact that the person once understood differently, which
 * is precisely what this project exists to keep — so a revoke hides the *effect* and keeps the
 * *record*.
 */
describe('revocation', () => {
  function seedClaim(context: ReturnType<typeof createFixture>, id = 'claim-1'): NodeId {
    const nodeId = asId<NodeId>(id)
    context.graph.addNode({
      id: nodeId,
      type: NODE.claim,
      label: 'Self-attention alone does not encode sequence order.',
      properties: { text: 'Self-attention alone does not encode sequence order.' },
      tags: learnTags('transformer'),
      tier: 'thought',
      source: 'session:1',
    })
    return nodeId
  }

  it('hides a revoked event from state while keeping the record readable', () => {
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

    const revocation = context.log.revokeStateEvent(second.id, { reason: 'misrecorded' })
    expect(revocation.eventId).toBe(second.id)
    expect(revocation.reason).toBe('misrecorded')

    // The retracted event still exists — the past is not rewritten.
    expect(context.log.getEvent(second.id)).toEqual(second)
    expect(context.log.isRevoked(second.id)).toBe(true)
    expect(context.log.eventCount).toBe(2)

    // But its effect is gone, and it is hidden from the ordinary read.
    expect(
      context.log.stateOf(claimId, context.humanId).get(asId<DimensionId>('confidence')),
    ).toEqual({ level: 'low' })
    expect(
      context.log.history({ target: claimId, actorId: context.humanId }).map((e) => e.id),
    ).toEqual([first.id])
    expect(
      context.log
        .history({ target: claimId, actorId: context.humanId, includeRevoked: true })
        .map((e) => e.id),
    ).toEqual([first.id, second.id])
  })

  it('still folds events committed after a revocation onto the surviving state', () => {
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
    const middle = context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('high')]),
    })
    context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.evidence, level('proven')]),
    })

    context.log.revokeStateEvent(middle.id, { reason: 'overstated' })

    const state = context.log.stateOf(claimId, context.humanId)
    // Confidence falls back to what it was *before* the retracted event; the later, unrelated
    // change survives. Traversal continues through the revoked event so nothing is orphaned.
    expect(state.get(asId<DimensionId>('confidence'))).toEqual({ level: 'low' })
    expect(state.get(asId<DimensionId>('evidence'))).toEqual({ level: 'proven' })
  })

  it('is idempotent, and does not treat a revoked event as an open end', () => {
    const context = createFixture()
    const claimId = seedClaim(context)

    const only = context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('low')]),
    })

    const first = context.log.revokeStateEvent(only.id)
    expect(context.log.revokeStateEvent(only.id)).toEqual(first)
    expect(context.log.tips(context.humanId)).toHaveLength(0)
  })

  it('retracts a node without removing it, and hides it from queries', () => {
    const context = createFixture()
    const claimId = seedClaim(context)
    const concept = context.graph.addNode({
      id: asId<NodeId>('concept-1'),
      type: NODE.concept,
      label: 'Self-Attention',
      properties: { text: 'Self-Attention' },
      tags: learnTags('transformer'),
      tier: 'reference',
      source: 'reference:transformer',
    })

    expect(context.graph.revokeNode(concept.id)).toBe(true)
    // Idempotent: a second retraction reports that nothing changed.
    expect(context.graph.revokeNode(concept.id)).toBe(false)

    expect(context.graph.getNode(concept.id)?.revoked).toBe(true)
    expect(context.graph.getNode(concept.id)?.revokedAt).toBeTypeOf('number')

    // Hidden from queries by default, present when a history or audit view asks for it.
    expect(context.graph.findNodes({ tags: ['topic:transformer'] }).map((n) => n.id)).toEqual([
      claimId,
    ])
    expect(
      context.graph
        .findNodes({ tags: ['topic:transformer'], includeRevoked: true })
        .map((n) => n.id)
        .sort(),
    ).toEqual([claimId, concept.id].sort())
  })
})

describe('findNodes', () => {
  function seed(context: ReturnType<typeof createFixture>): void {
    context.graph.addNode({
      id: asId<NodeId>('concept-attention'),
      type: NODE.concept,
      label: 'Self-Attention',
      properties: { text: 'Self-Attention' },
      tags: learnTags('transformer'),
      tier: 'reference',
      source: 'reference:transformer',
    })
    context.graph.addNode({
      id: asId<NodeId>('concept-rope'),
      type: NODE.concept,
      label: 'RoPE',
      properties: { text: 'RoPE' },
      tags: learnTags('rope'),
      tier: 'reference',
      source: 'reference:rope',
    })
    context.graph.addNode({
      id: asId<NodeId>('claim-rope'),
      type: NODE.claim,
      label: 'RoPE injects relative position.',
      properties: { text: 'RoPE injects relative position.' },
      tags: learnTags('rope'),
      tier: 'thought',
      source: 'session:1',
    })
    context.graph.addNode({
      id: asId<NodeId>('draft-transcript'),
      type: NODE.evidence,
      label: 'Transcript',
      properties: { kind: 'chat_transcript', text: 'raw' },
      tags: learnTags('rope'),
      tier: 'draft',
      source: 'session:1',
    })
  }

  it('selects by type and by tag pattern', () => {
    const context = createFixture()
    seed(context)

    // Drafts are excluded by default: raw material is not understanding.
    expect(context.graph.findNodes({ type: NODE.claim }).map((n) => n.id)).toEqual(['claim-rope'])
    expect(
      context.graph
        .findNodes({ tags: ['topic:rope'] })
        .map((n) => n.id)
        .sort(),
    ).toEqual(['claim-rope', 'concept-rope'].sort())
    expect(context.graph.findNodes({ includeDrafts: true }).map((n) => n.id)).toContain(
      'draft-transcript',
    )
  })

  it('matches a wildcard namespace and AND-s multiple patterns', () => {
    const context = createFixture()
    seed(context)

    expect(context.graph.findNodes({ tags: ['scene:*'] })).toHaveLength(3)
    expect(
      context.graph
        .findNodes({ tags: ['topic:rope', 'state:active'] })
        .map((n) => n.id)
        .sort(),
    ).toEqual(['claim-rope', 'concept-rope'].sort())
    expect(context.graph.findNodes({ tags: ['topic:rope', 'state:revoked'] })).toHaveLength(0)
  })

  it('honours a limit and returns nothing for an unmatched query', () => {
    const context = createFixture()
    seed(context)

    expect(context.graph.findNodes({ limit: 1 })).toHaveLength(1)
    expect(context.graph.findNodes({ tags: ['topic:quantum'] })).toHaveLength(0)
  })

  it('separates incoming from outgoing edges', () => {
    const context = createFixture()
    seed(context)
    context.graph.addEdge({
      id: asId<EdgeId>('e-claim-refers-rope'),
      type: EDGE.refersTo,
      from: asId<NodeId>('claim-rope'),
      to: asId<NodeId>('concept-rope'),
    })

    expect(context.graph.outgoing(asId<NodeId>('claim-rope')).map((e) => e.id)).toEqual([
      'e-claim-refers-rope',
    ])
    expect(context.graph.incoming(asId<NodeId>('claim-rope'))).toHaveLength(0)
    expect(context.graph.incoming(asId<NodeId>('concept-rope')).map((e) => e.id)).toEqual([
      'e-claim-refers-rope',
    ])
  })
})
