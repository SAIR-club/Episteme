import { asId, project, type EdgeId, type NodeId } from '@episteme/core'
import { describe, expect, it } from 'vitest'
import { DIMENSION, EDGE, NODE, createFixture, dimensions, learnTags, level } from './fixtures.js'

/**
 * One graph, many views.
 *
 * Learn, Forum and Research must not each grow their own knowledge store. These tests pin
 * down that a view is derived — by scope, actor, topic, state and depth — rather than owned,
 * and that two views over the same graph stay isolated from each other.
 */
describe('projection isolation', () => {
  /** Builds two concept/claim pairs under two different topics. */
  function seedTwoTopics(context: ReturnType<typeof createFixture>) {
    const attention = asId<NodeId>('concept-attention')
    const rope = asId<NodeId>('concept-rope')
    const claimA = asId<NodeId>('claim-attention')
    const claimB = asId<NodeId>('claim-rope')

    context.graph.addNode({
      id: attention,
      type: NODE.concept,
      label: 'Self-Attention',
      properties: { text: 'Self-Attention' },
      tags: learnTags('transformer'),
      tier: 'reference',
      source: 'paper:arxiv:1706.03762',
    })
    context.graph.addNode({
      id: rope,
      type: NODE.concept,
      label: 'RoPE',
      properties: { text: 'RoPE' },
      tags: learnTags('rope'),
      tier: 'reference',
      source: 'paper:arxiv:2104.09864',
    })
    context.graph.addNode({
      id: claimA,
      type: NODE.claim,
      label: 'Attention cannot encode order alone.',
      properties: { text: 'Attention cannot encode order alone.' },
      tags: learnTags('transformer'),
      tier: 'thought',
      source: 'session:1',
    })
    context.graph.addNode({
      id: claimB,
      type: NODE.claim,
      label: 'RoPE rotates queries and keys.',
      properties: { text: 'RoPE rotates queries and keys.' },
      tags: learnTags('rope'),
      tier: 'thought',
      source: 'session:2',
    })
    context.graph.addEdge({
      id: asId<EdgeId>('e-a'),
      type: EDGE.refersTo,
      from: claimA,
      to: attention,
    })
    context.graph.addEdge({
      id: asId<EdgeId>('e-b'),
      type: EDGE.refersTo,
      from: claimB,
      to: rope,
    })
    return { attention, rope, claimA, claimB }
  }

  it('scopes a view to one topic without touching the other', () => {
    const context = createFixture()
    const { attention, rope, claimA, claimB } = seedTwoTopics(context)

    const transformer = project(context.graph, {
      tags: { topic: ['transformer'] },
      depth: 1,
    })
    const ropeView = project(context.graph, { tags: { topic: ['rope'] }, depth: 1 })

    expect(transformer.nodes.map((node) => node.id).sort()).toEqual([attention, claimA].sort())
    expect(ropeView.nodes.map((node) => node.id).sort()).toEqual([rope, claimB].sort())

    // Every edge in a view has both ends inside it, so a view can never imply knowledge it
    // cannot show.
    for (const view of [transformer, ropeView]) {
      const ids = new Set(view.nodes.map((node) => node.id))
      for (const edge of view.edges) {
        expect(ids.has(edge.from)).toBe(true)
        expect(ids.has(edge.to)).toBe(true)
      }
    }
  })

  it('reports why a node is present: seeds versus expansion', () => {
    const context = createFixture()
    const { attention, claimA } = seedTwoTopics(context)

    const view = project(context.graph, {
      nodeTypes: [NODE.claim],
      tags: { topic: ['transformer'] },
      depth: 1,
    })

    expect(view.seeds).toEqual([claimA])
    // The concept matched the topic but not the requested type, so it is not part of a
    // claim-only view — and therefore cannot be reported as either a seed or an expansion.
    expect(view.nodes.map((node) => node.id)).toEqual([claimA])
    expect(view.expanded).toEqual([])
    expect(attention).not.toBe(claimA)
  })

  it('traverses through nodes it does not display, and keeps depth meaningful', () => {
    const context = createFixture()
    const { attention, claimA } = seedTwoTopics(context)
    const chainId = asId<NodeId>('claim-chain')

    context.graph.addNode({
      id: chainId,
      type: NODE.claim,
      label: 'Positional encoding is therefore necessary.',
      properties: { text: 'Positional encoding is therefore necessary.' },
      // Deliberately not tagged with the seed topic, so it can only be reached by traversal.
      tags: learnTags('architecture'),
      tier: 'thought',
      source: 'session:1',
    })
    context.graph.addEdge({
      id: asId<EdgeId>('e-chain'),
      type: EDGE.refersTo,
      from: chainId,
      to: attention,
    })

    // depth 0: the claim itself, even though its neighbour matched the topic too.
    const seedOnly = project(context.graph, {
      nodeTypes: [NODE.claim],
      tags: { topic: ['transformer'] },
      depth: 0,
    })
    expect(seedOnly.nodes.map((node) => node.id)).toEqual([claimA])
    expect(seedOnly.expanded).toEqual([])

    // depth 1: the walk passes through the concept — which is not displayed — and arrives at
    // the second claim, which is. Traversal is unrestricted; the type gate applies to output.
    const oneHop = project(context.graph, {
      nodeTypes: [NODE.claim],
      tags: { topic: ['transformer'] },
      depth: 1,
    })
    expect(oneHop.seeds).toEqual([claimA])
    expect(oneHop.expanded).toEqual([chainId])
    expect(oneHop.nodes.map((node) => node.id).sort()).toEqual([claimA, chainId].sort())
  })

  it('filters by current state rather than by any historical value', () => {
    const context = createFixture()
    const { claimA, claimB } = seedTwoTopics(context)

    context.log.commit({
      target: claimA,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('high')]),
    })
    // claimB was once high, and is now low: a filter for "currently high" must exclude it.
    context.log.commit({
      target: claimB,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('high')]),
    })
    context.log.commit({
      target: claimB,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('low')]),
    })

    const confident = project(context.graph, {
      actor: context.humanId,
      state: { [DIMENSION.confidence]: { level: 'high' } },
      depth: 0,
    })

    expect(confident.nodes.map((node) => node.id)).toEqual([claimA])
  })

  it('keeps one actor\u2019s view from leaking into another\u2019s state filter', () => {
    const context = createFixture()
    const { claimA } = seedTwoTopics(context)

    context.log.commit({
      target: claimA,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('high')]),
    })
    context.log.commit({
      target: claimA,
      actorId: context.agentId,
      dimensions: dimensions([DIMENSION.confidence, level('low')]),
    })

    const humanView = project(context.graph, {
      actor: context.humanId,
      state: { [DIMENSION.confidence]: { level: 'high' } },
      depth: 0,
    })
    const agentView = project(context.graph, {
      actor: context.agentId,
      state: { [DIMENSION.confidence]: { level: 'high' } },
      depth: 0,
    })

    // The same graph, the same filter, two different answers — because the state belongs to
    // the actor, not to the node.
    expect(humanView.nodes.map((node) => node.id)).toEqual([claimA])
    expect(agentView.nodes).toHaveLength(0)
  })

  it('returns everything when no criterion is set, and nothing for an unmatched topic', () => {
    const context = createFixture()
    seedTwoTopics(context)

    expect(project(context.graph).nodes).toHaveLength(4)
    expect(project(context.graph, { tags: { topic: ['quantum'] } }).nodes).toHaveLength(0)
  })
})
