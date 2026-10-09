import {
  asId,
  retrieve,
  termsOf,
  retrieveRelevantContext,
  retrieveWith,
  type ActorId,
  type EdgeId,
  type NodeId,
} from '@episteme/core'
import { DeterministicEmbeddingAdapter, InMemoryEmbeddingCache } from '@episteme/core'
import { describe, expect, it } from 'vitest'
import {
  DIMENSION,
  EDGE,
  NODE,
  createFixture,
  dimensions,
  embeddingRetriever,
  learnTags,
  level,
  lexicalRetriever,
  type EpistemeContext,
} from './fixtures.js'

const CLAIM_LABEL = 'Self-attention alone does not encode sequence order.'

function seed(context: EpistemeContext): void {
  const concept = (id: string, label: string, topic: string) =>
    context.graph.addNode({
      id: asId<NodeId>(id),
      type: NODE.concept,
      label,
      properties: { text: label },
      tags: learnTags(topic),
      tier: 'reference',
      source: 'reference:x',
    })

  concept('c_transformer', 'Transformer', 'transformer')
  concept('c_attention', 'Self-Attention', 'transformer')
  concept('c_positional', 'Positional Encoding', 'transformer')
  concept('c_rope', 'RoPE', 'rope')

  context.graph.addNode({
    id: asId<NodeId>('claim_order'),
    type: NODE.claim,
    label: CLAIM_LABEL,
    properties: { text: CLAIM_LABEL },
    tags: learnTags('transformer'),
    tier: 'thought',
    source: 'session:1',
  })
  context.graph.addEdge({
    id: asId<EdgeId>('e_claim_attention'),
    type: EDGE.refersTo,
    from: asId<NodeId>('claim_order'),
    to: asId<NodeId>('c_attention'),
  })
}

describe('deterministic retrieval', () => {
  it('reduces a question to comparable terms without inventing words', () => {
    expect(termsOf('Why does the Transformer need positional encoding?')).toEqual([
      'transformer',
      'need',
      'positional',
      'encoding',
    ])
    // De-duplicated and order-stable, so retrieval is reproducible.
    expect(termsOf('rope RoPE rope')).toEqual(['rope'])
    // Single characters and stop words carry no signal here.
    expect(termsOf('a I of and the')).toEqual([])
  })

  it('finds nodes by label and by tag, and explains which term matched', () => {
    const context = createFixture()
    seed(context)

    const byLabel = retrieve(context.graph, { text: 'How does RoPE work?' })
    expect(byLabel.matches.map((entry) => entry.node.id)).toContain('c_rope')
    const rope = byLabel.matches.find((entry) => entry.node.id === 'c_rope')
    expect(rope?.matchedTerms).toEqual(['rope'])
    expect(rope?.origin).toBe('match')

    // A tag match counts too: `attention` is in the claim's label and in the concept's label.
    const byTerm = retrieve(context.graph, { text: 'attention' })
    expect(byTerm.matches.map((entry) => entry.node.id).sort()).toEqual(
      ['c_attention', 'claim_order'].sort(),
    )
  })

  it('accepts explicit anchors and treats a tag filter as intent rather than a hint', () => {
    const context = createFixture()
    seed(context)

    const anchored = retrieve(context.graph, { nodeIds: [asId<NodeId>('c_transformer')] })
    expect(anchored.matches.map((entry) => entry.node.id)).toEqual(['c_transformer'])

    // A filter-only query means "these are the ones I want", so tag-carrying nodes are the
    // result rather than being scored against zero search terms.
    const viaTag = retrieve(context.graph, { tags: ['topic:rope'] })
    expect(viaTag.matches.map((entry) => entry.node.id)).toEqual(['c_rope'])
  })

  it('walks out from a match so a question reaches what the match relates to', () => {
    const context = createFixture()
    seed(context)

    // "sequence order" occurs only in the claim's label, so it matches exactly one node.
    const shallow = retrieve(context.graph, { text: 'sequence order', depth: 0 })
    expect(shallow.matches.map((entry) => entry.node.id)).toEqual(['claim_order'])
    expect(shallow.neighbors).toHaveLength(0)

    // The concept the claim refers to is never named by the question, so traversal is the only
    // thing that can bring it back.
    const deep = retrieve(context.graph, { text: 'sequence order', depth: 1 })
    expect(deep.matches.map((entry) => entry.node.id)).toEqual(['claim_order'])
    expect(deep.neighbors.map((entry) => entry.node.id)).toEqual(['c_attention'])
    for (const entry of deep.neighbors) {
      expect(entry.origin).toBe('neighbor')
    }
  })

  it('is deterministic and order-stable across repeated calls', () => {
    const context = createFixture()
    seed(context)

    const first = retrieve(context.graph, { text: 'transformer positional encoding', depth: 1 })
    const second = retrieve(context.graph, { text: 'transformer positional encoding', depth: 1 })

    expect(second.nodeIds).toEqual(first.nodeIds)
  })

  it('honours limits, minimum score and node type filters', () => {
    const context = createFixture()
    seed(context)

    expect(retrieve(context.graph, { tags: ['topic:*'], limit: 2 }).matches).toHaveLength(2)
    // Requiring two distinct matching terms excludes a node that only matches one.
    expect(retrieve(context.graph, { text: 'transformer', minScore: 2 }).matches).toHaveLength(0)
    expect(
      retrieve(context.graph, { tags: ['topic:*'], nodeTypes: [NODE.claim] }).matches.map(
        (entry) => entry.node.id,
      ),
    ).toEqual(['claim_order'])
  })

  it('never returns a draft or a revoked node as a match', () => {
    const context = createFixture()
    seed(context)
    context.graph.addNode({
      id: asId<NodeId>('draft_rope'),
      type: NODE.evidence,
      label: 'RoPE transcript',
      properties: { kind: 'chat_transcript', text: 'raw' },
      tags: learnTags('rope'),
      tier: 'draft',
      source: 'session:1',
    })

    expect(retrieve(context.graph, { text: 'RoPE' }).nodeIds).not.toContain('draft_rope')

    context.graph.revokeNode(asId<NodeId>('c_rope'))
    expect(retrieve(context.graph, { text: 'RoPE' }).nodeIds).not.toContain('c_rope')
  })
})

describe('learner context retrieval', () => {
  it('joins the graph to one actor\u2019s understanding, and only that actor\u2019s', async () => {
    const context = createFixture()
    seed(context)

    context.log.commit({
      target: asId<NodeId>('claim_order'),
      actorId: context.humanId,
      dimensions: dimensions(
        [DIMENSION.confidence, level('high')],
        [DIMENSION.conflict, level('open')],
      ),
      source: 'session:1',
    })

    const forHuman = await retrieveRelevantContext(context.graph, context.log, CLAIM_LABEL, {
      actorId: context.humanId,
      depth: 1,
    })
    const forAgent = await retrieveRelevantContext(context.graph, context.log, CLAIM_LABEL, {
      actorId: asId<ActorId>('actor_agent'),
      depth: 1,
    })

    // The shared node is retrieved for both; the understanding exists for only one.
    expect(forHuman.known.map((entry) => entry.nodeId)).toContain('claim_order')
    expect(forAgent.known).toHaveLength(0)

    const known = forHuman.known.find((entry) => entry.nodeId === 'claim_order')
    expect(known?.settled).toBe(true)
    expect(known?.openConflicts).toEqual(['open'])
    expect(forHuman.summary).toContain('confidence=high')
    expect(forHuman.summary).toContain('unresolved: open')
    expect(forAgent.summary).toBe('')
  })

  it('reports nothing recorded when the learner has no state, and never invents it', async () => {
    const context = createFixture()
    seed(context)

    const empty = await retrieveRelevantContext(context.graph, context.log, 'Why does RoPE work?', {
      actorId: context.humanId,
      depth: 2,
    })

    expect(empty.known).toHaveLength(0)
    expect(empty.summary).toBe('')
    // Retrieval still found the relevant part of the graph — it just has nothing to say about
    // this learner yet, which is a different statement from "nothing was found".
    expect(empty.nodes.length).toBeGreaterThan(0)
  })

  it('carries context to the agent as data, not as a sentence to re-parse', async () => {
    const context = createFixture()
    seed(context)
    context.log.commit({
      target: asId<NodeId>('claim_order'),
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('high')]),
    })

    const retrieved = await retrieveRelevantContext(context.graph, context.log, CLAIM_LABEL, {
      actorId: context.humanId,
      depth: 1,
    })

    expect(retrieved.terms.length).toBeGreaterThan(0)
    expect(retrieved.query.text).toBe(CLAIM_LABEL)
  })

  it('reaches retrieval through the Retriever seam without changing what it returns', async () => {
    const context = createFixture()
    seed(context)
    context.log.commit({
      target: asId<NodeId>('claim_order'),
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('high')]),
    })

    const retriever = lexicalRetriever(context.graph)
    expect(retriever.name).toBe('lexical-graph')

    const throughSeam = await retrieveWith(retriever, context.graph, context.log, CLAIM_LABEL, {
      actorId: context.humanId,
      depth: 1,
    })
    const throughEntryPoint = await retrieveRelevantContext(
      context.graph,
      context.log,
      CLAIM_LABEL,
      {
        actorId: context.humanId,
        depth: 1,
      },
    )

    // Same strategy, so the same answer — the interface is a seam, not a behaviour change.
    expect(throughSeam.nodes.map((node) => node.id)).toEqual(
      throughEntryPoint.nodes.map((node) => node.id),
    )
    expect(throughSeam.summary).toBe(throughEntryPoint.summary)
    // And the context says how it was obtained, so a view can be honest about it.
    expect(throughSeam.retriever).toBe('lexical-graph')
  })

  it('reaches semantic retrieval through the seam and still joins actor state', async () => {
    const context = createFixture()
    seed(context)
    context.log.commit({
      target: asId<NodeId>('claim_order'),
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('high')]),
    })

    const retriever = embeddingRetriever(
      context.graph,
      new DeterministicEmbeddingAdapter(),
      new InMemoryEmbeddingCache(),
    )
    expect(retriever.name).toBe('embedding')
    expect(retriever.signals).toEqual(['semantic'])

    const retrieved = await retrieveWith(retriever, context.graph, context.log, CLAIM_LABEL, {
      actorId: context.humanId,
      depth: 1,
    })

    expect(retrieved.retriever).toBe('embedding')
    expect(retrieved.nodes.length).toBeGreaterThan(0)
    // Actor isolation is inherited from the join, not re-implemented per retriever.
    expect(retrieved.known.length).toBeGreaterThan(0)
  })
})
