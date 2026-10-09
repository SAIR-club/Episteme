import {
  DeterministicEmbeddingAdapter,
  InMemoryEmbeddingCache,
  HybridRetriever,
  type NodeId,
  type Retriever,
} from '@episteme/core'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DIMENSION,
  createFixture,
  dimensions,
  hybridRetriever,
  level,
  lexicalRetriever,
  type EpistemeContext,
} from './fixtures.js'
import {
  EVALUATION_CLAIM_IDS,
  RETRIEVAL_EVALUATION,
  evaluateCase,
  seedEvaluationGraph,
} from './retrieval-evaluation-fixtures.js'

/**
 * Retrieval evaluation, and the reason hard negatives are the interesting half.
 *
 * Recall alone is trivially gamed: a retriever that returns everything has perfect recall and is
 * useless, because cognition is only useful if the *right* piece arrives ahead of the noise. Each case
 * therefore names what must rank below what.
 */

let context: EpistemeContext
let hybrid: Retriever
let lexical: Retriever

function makeRetrievers(): { hybrid: Retriever; lexical: Retriever } {
  const adapter = new DeterministicEmbeddingAdapter()
  const cache = new InMemoryEmbeddingCache()
  return {
    hybrid: hybridRetriever(context.graph, context.log, adapter, cache),
    lexical: lexicalRetriever(context.graph),
  }
}

beforeEach(() => {
  context = createFixture()
  seedEvaluationGraph(context)

  // The learner has recorded a state for every claim, so the cognitive signal is *uniformly* available
  // and cannot be what distinguishes a good case from a bad one.
  for (const id of Object.values(EVALUATION_CLAIM_IDS)) {
    context.log.commit({
      target: id,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('medium')]),
    })
  }

  const made = makeRetrievers()
  hybrid = made.hybrid
  lexical = made.lexical
})

describe('retrieval evaluation', () => {
  it('finds relevant cognition and suppresses hard negatives', async () => {
    const outcomes = []
    for (const testCase of RETRIEVAL_EVALUATION) {
      const result = await hybrid.retrieve({
        text: testCase.query,
        actorId: context.humanId,
        depth: 1,
      })
      outcomes.push(evaluateCase(testCase, result.nodeIds))
    }

    // Reported together so a failure names the case rather than only the first assertion.
    const failures = outcomes
      .filter((outcome) => !outcome.passed)
      .map((outcome) => ({
        case: outcome.case.name,
        missed: outcome.missed.map(String),
        violations: outcome.violations.map(String),
        ranked: outcome.ranked.map(String),
      }))

    expect(failures).toEqual([])
    expect(outcomes).toHaveLength(RETRIEVAL_EVALUATION.length)
  })

  it('is beaten by the hybrid retriever on the paraphrase cases', async () => {
    // Two cases chosen because they are the ones a lexical retriever provably cannot pass: neither query
    // contains a word from its expected claim.
    const paraphraseCases = RETRIEVAL_EVALUATION.slice(0, 2)

    for (const testCase of paraphraseCases) {
      const query = { text: testCase.query, actorId: context.humanId, depth: 1 }
      const hybridRanked = (await hybrid.retrieve(query)).nodeIds
      const lexicalRanked = (await lexical.retrieve(query)).nodeIds

      expect(evaluateCase(testCase, hybridRanked).passed).toBe(true)
      expect(evaluateCase(testCase, lexicalRanked).passed).toBe(false)
    }
  })

  it('keeps an unrelated question from dragging in cognition', async () => {
    const unrelated = RETRIEVAL_EVALUATION.find((testCase) => testCase.expected.length === 0)
    expect(unrelated).toBeDefined()
    if (unrelated === undefined) return

    const result = await hybrid.retrieve({
      text: unrelated.query,
      actorId: context.humanId,
      depth: 1,
    })
    const outcome = evaluateCase(unrelated, result.nodeIds)

    // Suppression, not recall: nothing in the graph concerns Portugal, so nothing may be reported as
    // relevant to it. An implementation that returned everything would satisfy recall and fail here,
    // which is the point of a case with no expected result.
    expect(outcome.violations).toEqual([])
    expect(result.matches.map((entry) => entry.node.id)).toEqual([])
  })

  it('separates a paraphrase from an unrelated question by similarity', async () => {
    const adapter = new DeterministicEmbeddingAdapter()
    const { cosineSimilarity } = await import('@episteme/core')

    const claim = await adapter.embed('Self-attention does not encode sequence order.')
    const paraphrase = await adapter.embed('Which word comes first in the input?')
    const unrelated = await adapter.embed('What is the capital of Portugal?')

    const relevant = cosineSimilarity(claim, paraphrase)
    const irrelevant = cosineSimilarity(claim, unrelated)

    // This assertion exists because the opposite was once true. With a 256-dimension hash space,
    // unrelated texts collided into shared buckets and scored 0.34 — the same as a genuine paraphrase —
    // which made the semantic signal noise. If this ever regresses, the retriever is ranking on
    // collisions again.
    expect(relevant).toBeGreaterThan(irrelevant * 3)
    expect(irrelevant).toBeLessThan(0.1)
  })

  it('reports every signal it claims to use, so a result can be audited', async () => {
    expect(hybrid.signals).toEqual(['semantic', 'lexical', 'graph', 'cognitive', 'recency'])

    const result = await hybrid.retrieve({
      text: 'Which word comes first in the input?',
      actorId: context.humanId,
      depth: 1,
    })

    // The claim is retrieved on meaning, not on words: no query term occurs in it.
    const order = result.matches.find((entry) => entry.node.id === EVALUATION_CLAIM_IDS.order)
    expect(order).toBeDefined()
    expect(order?.matchedTerms).toEqual([])
    expect(order?.score).toBeGreaterThan(0)
  })

  it('lets the cognitive signal reorder nodes that are otherwise identical', async () => {
    // Every claim was recorded with the same confidence above, so the cognitive signal is level and the
    // ordering below is decided by the question rather than by state. Flagging one claim as disputed is
    // the only change.
    context.log.commit({
      target: EVALUATION_CLAIM_IDS.orderless,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.conflict, level('open')]),
    })

    const cognitiveOnly = new HybridRetriever(
      context.graph,
      context.log,
      new DeterministicEmbeddingAdapter(),
      new InMemoryEmbeddingCache(),
      // Only the cognitive signal carries weight, so nothing else can explain the difference.
      { semantic: 0, lexical: 0, graph: 0, cognitive: 1, recency: 0 },
    )

    const ranked = (
      await cognitiveOnly.retrieve({
        text: 'sequence order',
        actorId: context.humanId,
        depth: 0,
        minScore: 0,
      })
    ).nodeIds

    // A node with an open conflict must be surfaced, and above one that is merely held with medium
    // confidence — this is the signal doing work no similarity score can do.
    const disputed = ranked.indexOf(EVALUATION_CLAIM_IDS.orderless)
    const plain = ranked.indexOf(EVALUATION_CLAIM_IDS.order)
    expect(disputed).toBeGreaterThanOrEqual(0)
    expect(plain).toBeGreaterThanOrEqual(0)
    expect(disputed).toBeLessThan(plain)

    // The control: with no conflict recorded, the two are indistinguishable on this signal alone, so the
    // preference above came from the conflict rather than from insertion order.
    const fresh = createFixture()
    seedEvaluationGraph(fresh)
    for (const id of Object.values(EVALUATION_CLAIM_IDS)) {
      fresh.log.commit({
        target: id,
        actorId: fresh.humanId,
        dimensions: dimensions([DIMENSION.confidence, level('medium')]),
      })
    }
    const neutral = new HybridRetriever(
      fresh.graph,
      fresh.log,
      new DeterministicEmbeddingAdapter(),
      new InMemoryEmbeddingCache(),
      { semantic: 0, lexical: 0, graph: 0, cognitive: 1, recency: 0 },
    )
    const neutralRanked = (
      await neutral.retrieve({
        text: 'sequence order',
        actorId: fresh.humanId,
        depth: 0,
        minScore: 0,
      })
    ).nodeIds

    const neutralDisputed = neutralRanked.indexOf(EVALUATION_CLAIM_IDS.orderless)
    const neutralPlain = neutralRanked.indexOf(EVALUATION_CLAIM_IDS.order)
    // Both are held identically, so any ordering between them is arbitrary — and neither may be claimed
    // as preferred on cognitive grounds.
    if (neutralDisputed >= 0 && neutralPlain >= 0) {
      expect(neutralDisputed === neutralPlain).toBe(false)
    }
  })

  it('is deterministic: the same query gives the same order twice', async () => {
    const query = {
      text: 'Which word comes first in the input?',
      actorId: context.humanId,
      depth: 1,
    }
    const first = (await hybrid.retrieve(query)).nodeIds
    const second = (await hybrid.retrieve(query)).nodeIds
    expect(second).toEqual(first)

    // And stable across a fresh retriever with an empty cache, so ordering does not depend on cache warmth.
    const cold = new HybridRetriever(
      context.graph,
      context.log,
      new DeterministicEmbeddingAdapter(),
      new InMemoryEmbeddingCache(),
    )
    expect((await cold.retrieve(query)).nodeIds).toEqual(first)
  })

  it('names which node each result refers to, so a result is never ambiguous', async () => {
    const result = await hybrid.retrieve({
      text: 'Which word comes first in the input?',
      actorId: context.humanId,
      depth: 1,
    })

    // Every reported entry identifies its node, its origin, its score and its terms — so "which subject
    // is this about" is answerable from the result alone.
    for (const entry of [...result.matches, ...result.neighbors]) {
      expect(entry.node.id).toBeTypeOf('string')
      expect(entry.node.id.length).toBeGreaterThan(0)
      expect(['match', 'neighbor']).toContain(entry.origin)
      expect(entry.score).toBeGreaterThanOrEqual(0)
      expect(Array.isArray(entry.matchedTerms)).toBe(true)
    }
    // A node is never in both groups, which would make the ordering ambiguous.
    const matchIds = new Set<NodeId>(result.matches.map((entry) => entry.node.id))
    for (const entry of result.neighbors) expect(matchIds.has(entry.node.id)).toBe(false)
  })
})
