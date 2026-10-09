import { asId, isEpistemeError, type EdgeId, type NodeId, type NodeTypeId } from '@episteme/core'
import type { EdgeTypeId } from '@episteme/core'
import { describe, expect, it } from 'vitest'
import { DIMENSION, EDGE, NODE, createFixture, dimensions, learnTags, level } from './fixtures.js'

/**
 * A refusal must be a first-class outcome, not an exception that disappears.
 *
 * Two different kinds of rejection are covered here: structural rules Core owns (an
 * unregistered type, a missing endpoint) and domain rules a pack registers (a Thought with
 * no anchor). Both must name what was wrong, because the confirmation flow shows the human
 * why a proposed change was not accepted.
 */
describe('guard rejection', () => {
  function seedConcept(context: ReturnType<typeof createFixture>, id = 'concept-1'): NodeId {
    const nodeId = asId<NodeId>(id)
    context.graph.addNode({
      id: nodeId,
      type: NODE.concept,
      label: 'Self-Attention',
      properties: { text: 'Self-Attention' },
      tags: learnTags('transformer'),
      tier: 'reference',
      source: 'paper:arxiv:1706.03762',
    })
    return nodeId
  }

  it('refuses an unregistered node type', () => {
    const context = createFixture()

    const error = catchError(() =>
      context.graph.addNode({
        id: asId<NodeId>('bad'),
        type: asId<NodeTypeId>('lecture'),
        label: 'A lecture',
        properties: { text: 'A lecture' },
        tier: 'reference',
        source: 'session:1',
      }),
    )

    expect(isEpistemeError(error)).toBe(true)
    expect(error).toMatchObject({ code: 'unregistered_node_type' })
  })

  it('refuses a node that omits a property its type declares', () => {
    const context = createFixture()

    expect(() =>
      context.graph.addNode({
        id: asId<NodeId>('no-text'),
        type: NODE.concept,
        label: 'Nameless',
        properties: {},
        tier: 'reference',
        source: 'session:1',
      }),
    ).toThrow(/requires property "text"/i)
  })

  it('refuses an unregistered edge type and a non-existent endpoint', () => {
    const context = createFixture()
    const conceptId = seedConcept(context)

    expect(() =>
      context.graph.addEdge({
        id: asId<EdgeId>('e-unknown-type'),
        type: asId<EdgeTypeId>('likes'),
        from: conceptId,
        to: conceptId,
      }),
    ).toThrow(/not registered/i)

    expect(() =>
      context.graph.addEdge({
        id: asId<EdgeId>('e-missing-target'),
        type: EDGE.refersTo,
        from: conceptId,
        to: asId<NodeId>('ghost'),
      }),
    ).toThrow(/does not exist/i)
  })

  it('refuses an edge whose endpoints violate the type\u2019s declared direction', () => {
    const context = createFixture()
    const conceptId = seedConcept(context)

    // `supports` must terminate at a claim; pointing it at a concept is meaningless.
    expect(() =>
      context.graph.addEdge({
        id: asId<EdgeId>('e-wrong-shape'),
        type: EDGE.supports,
        from: conceptId,
        to: conceptId,
      }),
    ).toThrow(/does not accept source type|does not accept target type/i)
  })

  it('refuses a Thought with no anchor, and explains why', () => {
    const context = createFixture()

    const error = catchError(() =>
      context.graph.addNode({
        id: asId<NodeId>('loose-thought'),
        type: NODE.thought,
        label: 'Attention is basically a lookup table.',
        properties: { text: 'Attention is basically a lookup table.', anchors: [] },
        tags: learnTags('transformer'),
        tier: 'thought',
        source: 'session:1',
      }),
    )

    expect(error).toMatchObject({ code: 'guard_rejected', guard: 'learn/thought-requires-source' })
  })

  it('refuses a Thought whose anchor does not exist, but allows a self-anchored one', () => {
    const context = createFixture()

    expect(() =>
      context.graph.addNode({
        id: asId<NodeId>('thought-dangling'),
        type: NODE.thought,
        label: 'Derived from nothing.',
        properties: { text: 'Derived from nothing.', anchors: ['does-not-exist'] },
        tags: learnTags('transformer'),
        tier: 'thought',
        source: 'session:1',
      }),
    ).toThrow(/anchor node\(s\) not found/i)

    // A Thought written directly is its own source of truth for the exploration.
    const anchored = context.graph.addNode({
      id: asId<NodeId>('thought-self'),
      type: NODE.thought,
      label: 'Self-anchored thought.',
      properties: { text: 'Self-anchored thought.', anchors: ['thought-self'] },
      tags: learnTags('transformer'),
      tier: 'thought',
      source: 'session:1',
    })
    expect(anchored.id).toBe('thought-self')
  })

  it('refuses an unregistered tag namespace and a tag with no namespace', () => {
    const context = createFixture()

    expect(() =>
      context.graph.addNode({
        id: asId<NodeId>('bad-tag'),
        type: NODE.concept,
        label: 'Tagged wrongly',
        properties: { text: 'Tagged wrongly' },
        tags: ['mood:curious'],
        tier: 'reference',
        source: 'session:1',
      }),
    ).toThrow(/tag namespace "mood" is not registered/i)

    expect(() =>
      context.graph.addNode({
        id: asId<NodeId>('bare-tag'),
        type: NODE.concept,
        label: 'Tagged bare',
        properties: { text: 'Tagged bare' },
        tags: ['transformer'],
        tier: 'reference',
        source: 'session:1',
      }),
    ).toThrow(/has no namespace/i)
  })

  it('offers refusals as values so a suggestion can be shown and dismissed, not thrown', () => {
    const context = createFixture()

    const preview = context.graph.previewNode({
      id: asId<NodeId>('suggested-thought'),
      type: NODE.thought,
      label: 'A suggested thought.',
      properties: { text: 'A suggested thought.', anchors: [] },
      tags: learnTags('transformer'),
      tier: 'thought',
      source: 'agent:suggestion',
    })

    expect(preview.ok).toBe(false)
    if (preview.ok) throw new Error('expected a refusal')
    expect(preview.refusal.guard).toBe('learn/thought-requires-source')
    expect(preview.refusal.message).toMatch(/anchor/i)

    // A refused suggestion leaves no trace in the graph.
    expect(context.graph.getNode(asId<NodeId>('suggested-thought'))).toBeUndefined()
  })

  it('accepts a well-formed mutation and returns it as a value', () => {
    const context = createFixture()
    const conceptId = seedConcept(context)

    const preview = context.graph.previewEdge({
      id: asId<EdgeId>('e-ok'),
      type: EDGE.refersTo,
      from: conceptId,
      to: conceptId,
    })

    expect(preview.ok).toBe(true)
    if (!preview.ok) throw new Error('expected acceptance')
    expect(preview.mutation.kind).toBe('edge.add')

    // A preview validates without writing.
    expect(context.graph.getEdge(asId<EdgeId>('e-ok'))).toBeUndefined()
  })

  it('refuses a duplicate registration rather than silently replacing a definition', () => {
    const context = createFixture()

    expect(() =>
      context.registries.nodeTypes.register({ id: NODE.concept, label: 'Concept again' }),
    ).toThrow(/already registered/i)
  })

  it('refuses an unregistered guard dimension through the commit path', () => {
    const context = createFixture()
    const conceptId = seedConcept(context)

    expect(() =>
      context.log.commit({
        target: conceptId,
        actorId: context.humanId,
        dimensions: dimensions([DIMENSION.confidence, level('very-high')]),
      }),
    ).toThrow(/not valid for dimension/i)
  })
})

function catchError(run: () => unknown): unknown {
  try {
    run()
    return undefined
  } catch (error) {
    return error
  }
}
