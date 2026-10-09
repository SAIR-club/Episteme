import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DeterministicEmbeddingAdapter,
  InMemoryEmbeddingCache,
  asId,
  contextSummary,
  HybridRetriever,
  LexicalGraphRetriever,
  retrieveRelevantContext,
  toAgentContext,
  type EdgeId,
  type NodeId,
} from '@episteme/core'
import { MockCognitiveAgent } from '@episteme/agent'
import { openLocalStorage } from '@episteme/storage-local'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DIMENSION,
  EDGE,
  NODE,
  askIn,
  dimensions,
  hybridRetriever,
  learnerResponder,
  learnTags,
  level,
  openEpisteme,
} from './fixtures.js'

/**
 * The Phase 2 acceptance test.
 *
 * The claim being proven: Episteme recovers a learner's prior understanding even when the learner asks
 * the same underlying question in different words.
 *
 * The shape is deliberate and was arrived at by being wrong first. An earlier draft used
 * "why can't attention tell which token came first?" — which shares the word `attention` with the stored
 * claim, so the lexical signal genuinely fired (a substring of "self-attention") and the test proved
 * nothing about meaning. The paraphrase now avoids every word of the claim, and the test asserts the
 * lexical miss *first* so the semantic success cannot be explained by an accidental overlap.
 */
const STORED_CLAIM = 'Self-attention does not encode sequence order.'
const CLAIM_ID = asId<NodeId>('claim_order')

/**
 * Shares no token with the stored claim.
 *
 * The only route from this question to that claim is the embedding adapter's lexicon, which maps
 * `first`/`word`/`input` onto the same vocabulary as `sequence`/`order`/`encode`. That is exactly the
 * correspondence a real model supplies for free, written down so the fake's behaviour is inspectable.
 */
const PARAPHRASE = 'Which word comes first in the input?'

function seedGraph(episteme: Awaited<ReturnType<typeof openEpisteme>>): void {
  const concept = (id: string, label: string, topic: string) =>
    episteme.graph.addNode({
      id: asId<NodeId>(id),
      type: NODE.concept,
      label,
      properties: { text: label },
      tags: learnTags(topic),
      tier: 'reference',
      source: 'paper:arxiv:1706.03762',
    })

  concept('c_transformer', 'Transformer', 'transformer')
  concept('c_self_attention', 'Self-Attention', 'transformer')
  concept('c_positional_encoding', 'Positional Encoding', 'transformer')
  concept('c_rope', 'RoPE', 'rope')

  episteme.graph.addNode({
    id: CLAIM_ID,
    type: NODE.claim,
    label: STORED_CLAIM,
    properties: { text: STORED_CLAIM },
    tags: learnTags('transformer'),
    tier: 'thought',
    source: 'session:1',
  })
  episteme.graph.addEdge({
    id: asId<EdgeId>('e_claim_refers_attention'),
    type: EDGE.refersTo,
    from: CLAIM_ID,
    to: asId<NodeId>('c_self_attention'),
  })
}

/** A scrambled twin of the same graph, so a hard negative is not accidentally about something else. */
function seedUnrelatedClaims(episteme: Awaited<ReturnType<typeof openEpisteme>>): void {
  const claim = (id: string, label: string) =>
    episteme.graph.addNode({
      id: asId<NodeId>(id),
      type: NODE.claim,
      label,
      properties: { text: label },
      tags: learnTags('transformer'),
      tier: 'thought',
      source: 'session:1',
    })

  claim('claim_heads', 'How many attention heads should I use?')
  claim('claim_lr', 'What learning rate schedule works best?')
  claim('claim_tokenizer', 'Which tokenizer should I pick for Chinese text?')
}

function makeAgent(): MockCognitiveAgent {
  return new MockCognitiveAgent({ responder: learnerResponder })
}

describe('paraphrase critical loop', () => {
  let directory: string
  let filePath: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'episteme-paraphrase-'))
    filePath = join(directory, 'graph.jsonl')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('recovers prior cognition from differently worded words, and changes the answer', async () => {
    // ── Session 1: the learner records an understanding, then the instance is dropped ──
    const storageA = await openLocalStorage(filePath)
    const session1 = await openEpisteme(storageA)
    seedGraph(session1)

    session1.log.commit({
      target: CLAIM_ID,
      actorId: session1.humanId,
      dimensions: dimensions(
        [DIMENSION.confidence, level('high')],
        [DIMENSION.articulation, level('medium')],
      ),
      reason: 'worked out why attention cannot represent order on its own',
      source: 'session:1',
    })

    await session1.log.persist()
    await storageA.save()
    // A restart means the first owner is gone before the second opens the file.
    await storageA.close()

    // ── Session 2: a second adapter, no shared memory ──
    const session2 = await openEpisteme(await openLocalStorage(filePath))

    // ── The control: with no memory at all ──
    const emptyPath = join(directory, 'never-written.jsonl')
    const cold = await openEpisteme(await openLocalStorage(emptyPath))
    seedGraph(cold)
    seedUnrelatedClaims(cold)
    const withoutMemory = await askIn(cold, makeAgent(), PARAPHRASE)

    // ── What a lexical retriever finds: nothing. This is asserted, not assumed ──
    const lexical = new LexicalGraphRetriever(session2.graph)
    const lexicalResult = await lexical.retrieve({ text: PARAPHRASE, depth: 1 })
    expect(lexicalResult.nodeIds).not.toContain(CLAIM_ID)
    // Stated as data rather than in a comment: not one of the question's terms occurs in the claim.
    expect(lexicalResult.terms.length).toBeGreaterThan(0)
    expect(lexicalResult.matches).toHaveLength(0)

    // ── The semantic path finds it, through the same seam ──
    const adapter = new DeterministicEmbeddingAdapter()
    const cache = new InMemoryEmbeddingCache()
    const hybrid = hybridRetriever(session2.graph, session2.log, adapter, cache)

    const retrieved = await retrieveRelevantContext(session2.graph, session2.log, PARAPHRASE, {
      actorId: session2.humanId,
      depth: 1,
      retriever: hybrid,
    })

    expect(retrieved.retriever).toBe('hybrid')
    expect(retrieved.nodes.map((node) => node.id)).toContain(CLAIM_ID)
    // The prior understanding is joined to it: this actor, this node, this state.
    expect(retrieved.known.map((entry) => entry.nodeId)).toContain(CLAIM_ID)
    expect(retrieved.summary).toContain(STORED_CLAIM)
    expect(retrieved.summary).toContain('confidence=high')

    // ── The answer changes shape, not only wording ──
    const agent = makeAgent()
    const response = await agent.respond({ text: PARAPHRASE }, toAgentContext(retrieved))

    expect(response.usedContext).toBe(true)
    expect(response.text).not.toBe(withoutMemory.response.text)
    // Without memory the agent has to establish the ground; with it, it starts from what is known.
    expect(withoutMemory.response.text).toContain('build the foundation first')
    expect(response.text).toContain('without re-deriving the groundwork')
    expect(response.text).toContain(STORED_CLAIM)
  })

  it('finds the prior cognition by meaning alone, with every other signal switched off', async () => {
    const storage = await openLocalStorage(filePath)
    const episteme = await openEpisteme(storage)
    seedGraph(episteme)
    episteme.log.commit({
      target: CLAIM_ID,
      actorId: episteme.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('high')]),
    })

    const adapter = new DeterministicEmbeddingAdapter()
    const hybrid = hybridRetriever(
      episteme.graph,
      episteme.log,
      adapter,
      new InMemoryEmbeddingCache(),
    )

    // `signals: ['semantic']` isolates the semantic term: no lexical overlap, no graph proximity to the
    // claim directly, no cognitive state, no recency preference.
    const semanticOnly = await hybrid.retrieve({
      text: PARAPHRASE,
      signals: ['semantic'],
      depth: 0,
    })
    expect(semanticOnly.nodeIds).toContain(CLAIM_ID)

    // And it is at the top, not merely present.
    expect(semanticOnly.nodeIds[0]).toBe(CLAIM_ID)

    // A lexical-only run through the same retriever misses it, so the two signals really are distinct.
    const lexicalOnly = await hybrid.retrieve({ text: PARAPHRASE, signals: ['lexical'], depth: 0 })
    expect(lexicalOnly.nodeIds).not.toContain(CLAIM_ID)
  })

  it('survives persistence: the paraphrase is answered from disk after a restart', async () => {
    const storageA = await openLocalStorage(filePath)
    const session1 = await openEpisteme(storageA)
    seedGraph(session1)
    session1.log.commit({
      target: CLAIM_ID,
      actorId: session1.humanId,
      dimensions: dimensions(
        [DIMENSION.confidence, level('high')],
        [DIMENSION.articulation, level('medium')],
      ),
    })
    await session1.log.persist()
    await storageA.save()
    // A restart means the first owner is gone before the second opens the file.
    await storageA.close()

    // The embedding cache is deliberately thrown away: embeddings are derived data, and a fresh process
    // would have an empty one. Retrieval must still work.
    const session2 = await openEpisteme(await openLocalStorage(filePath))
    const adapter = new DeterministicEmbeddingAdapter()
    const cache = new InMemoryEmbeddingCache()
    expect(cache.size).toBe(0)

    const retrieved = await retrieveRelevantContext(session2.graph, session2.log, PARAPHRASE, {
      actorId: session2.humanId,
      depth: 1,
      retriever: new HybridRetriever(session2.graph, session2.log, adapter, cache),
    })

    expect(contextSummary(retrieved)).toContain(STORED_CLAIM)
    // The cache filled during the call, which is what makes it derived rather than authoritative.
    expect(cache.size).toBeGreaterThan(0)
  })

  it('keeps one actor\u2019s paraphrase from retrieving another actor\u2019s state', async () => {
    const storage = await openLocalStorage(filePath)
    const episteme = await openEpisteme(storage)
    seedGraph(episteme)

    // The claim is stated by the agent; the human never records anything about it.
    episteme.log.commit({
      target: CLAIM_ID,
      actorId: episteme.agentId,
      dimensions: dimensions([DIMENSION.confidence, level('low')]),
    })

    const hybrid = hybridRetriever(
      episteme.graph,
      episteme.log,
      new DeterministicEmbeddingAdapter(),
      new InMemoryEmbeddingCache(),
    )

    const forHuman = await retrieveRelevantContext(episteme.graph, episteme.log, PARAPHRASE, {
      actorId: episteme.humanId,
      depth: 1,
      retriever: hybrid,
    })
    const forAgent = await retrieveRelevantContext(episteme.graph, episteme.log, PARAPHRASE, {
      actorId: episteme.agentId,
      depth: 1,
      retriever: hybrid,
    })

    // The shared node is retrieved for both; the understanding exists for only one of them.
    expect(forHuman.nodes.map((node) => node.id)).toContain(CLAIM_ID)
    expect(forHuman.known).toHaveLength(0)
    expect(forHuman.summary).toBe('')
    expect(forAgent.known.map((entry) => entry.nodeId)).toContain(CLAIM_ID)
    expect(forAgent.summary).toContain('confidence=low')
  })

  it('reports which signals contributed, so a result can explain itself', async () => {
    const storage = await openLocalStorage(filePath)
    const episteme = await openEpisteme(storage)
    seedGraph(episteme)
    episteme.log.commit({
      target: CLAIM_ID,
      actorId: episteme.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('low')]),
    })

    const hybrid = new HybridRetriever(
      episteme.graph,
      episteme.log,
      new DeterministicEmbeddingAdapter(),
      new InMemoryEmbeddingCache(),
    )
    const result = await hybrid.retrieve({ text: PARAPHRASE, depth: 1 })

    // A semantic match has no `matchedTerms`, so the score itself has to carry the explanation — which
    // is why `signals` is declared on the interface rather than left implicit.
    expect(hybrid.signals).toEqual(['semantic', 'lexical', 'graph', 'cognitive', 'recency'])
    const claim = result.matches.find((entry) => entry.node.id === CLAIM_ID)
    expect(claim).toBeDefined()
    expect(claim?.score).toBeGreaterThan(0)
    // The claim matched on meaning rather than words.
    expect(claim?.matchedTerms).toEqual([])
  })
})

describe('embedding failure is explicit', () => {
  it('does not report "no understanding" when the provider is unavailable', async () => {
    const storage = await openLocalStorage(join(tmpdir(), `episteme-absent-${Date.now()}.jsonl`))
    const episteme = await openEpisteme(storage)
    seedGraph(episteme)

    const broken = {
      model: 'broken',
      embed: () =>
        Promise.reject(Object.assign(new Error('connection refused'), { name: 'EmbeddingError' })),
    }

    const hybrid = hybridRetriever(
      episteme.graph,
      episteme.log,
      broken,
      new InMemoryEmbeddingCache(),
    )

    // An empty result would read as "the learner understands nothing", which is a different and worse
    // claim than "the embedding provider is down".
    await expect(hybrid.retrieve({ text: PARAPHRASE })).rejects.toThrow(/connection refused/)
  })
})
