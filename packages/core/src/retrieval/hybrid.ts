import type { ActorId, BranchId, NodeId, NodeTypeId } from '../ontology/ids.js'
import type { CoreGraph } from '../graph/graph.js'
import type { GraphNode } from '../ontology/resources.js'
import { queryNodes } from '../ontology/resources.js'
import type { EventLog } from '../events/index.js'
import type { RetrievedNode, RetrievalResult } from './index.js'
import { retrieve as coreRetrieve, termsOf, matchedTermsIn } from './index.js'
import type { Vector, EmbeddingAdapter, EmbeddingCache } from '../embedding/index.js'
import { EmbeddingError, embeddingKeyFor } from '../embedding/index.js'
import { similaritySignal } from '../embedding/similarity.js'

/**
 * A retrieval request.
 *
 * Extends Core's `RetrievalQuery`, which carries the structural part — text, anchors, tags, node types,
 * depth, limit. A retriever adds only what it can use beyond structure.
 */
export interface RetrieveQuery {
  readonly text?: string
  readonly nodeIds?: readonly NodeId[]
  readonly tags?: readonly string[]
  readonly nodeTypes?: readonly NodeTypeId[]
  /** Whose understanding should inform ranking. Absent means structure only. */
  readonly actorId?: ActorId
  /** Hops of neighbourhood to include around a match. */
  readonly depth?: number
  readonly limit?: number
  /** Which signals to combine. Defaults to each retriever's own choice. */
  readonly signals?: readonly RankSignal[]
  /** Minimum combined score for a node to be reported. */
  readonly minScore?: number
}

/** The relevance signals a retriever may combine. See `docs/architecture/retrieval.md`. */
export type RankSignal = 'semantic' | 'lexical' | 'graph' | 'cognitive' | 'recency'

/**
 * The retrieval seam.
 *
 * Core's `retrieve()` is the lexical and neighbourhood primitive; this is the layer an application talks
 * to, so a second strategy can be added without a caller changing. It is asynchronous because
 * embeddings are, and because a synchronous signature would have to be broken later.
 *
 * `RetrievalResult` is Core's and stays stable. A retriever may attach scores; it may not change the
 * shape a caller reads.
 */
export interface Retriever {
  readonly name: string
  /** Short description of how it decides relevance, so a view can be honest about how it looked. */
  readonly description: string
  /**
   * Which signals this retriever actually uses.
   *
   * Declared so a caller can tell a semantic result from a lexical one without inspecting scores, and
   * so a hybrid implementation cannot quietly drop a signal it claims to combine.
   */
  readonly signals: readonly RankSignal[]
  retrieve(query: RetrieveQuery): Promise<RetrievalResult>
}

/** One contribution to a node's relevance score, in `[0, weight]`. */
export interface SignalContribution {
  readonly signal: RankSignal
  /** What the signal found, normalised to `[0, 1]`. */
  readonly value: number
  /** The weight this signal had in the ranking, in `[0, 1]`. */
  readonly weight: number
  /** The actual addition to the score: `value * weight`. */
  readonly contribution: number
}

/**
 * A candidate node with its final score and the contributions that produced it.
 *
 * Internal to the explaining retrievers: the public `retrieve()` folds this into Core's `RetrievalResult`
 * and keeps the shape stable. Surfaces that want to show *why* a node was chosen use `explain()`.
 */
export interface ScoredCandidate {
  readonly node: GraphNode
  /** Sum of the contributions, in `[0, 1]`. Higher is more relevant. */
  readonly score: number
  /** The contributions that produced the score, sorted largest first. */
  readonly contributions: readonly SignalContribution[]
  /** Terms that matched this candidate's label, tags or id. */
  readonly matchedTerms: readonly string[]
  /** Whether the node was reached by query matching or by following edges. */
  readonly origin: 'match' | 'neighbor'
}

/** A retriever that can explain why it ranked things the way it did. */
export interface ExplainingRetriever extends Retriever {
  /**
   * Explains each candidate's score as the sum of normalised signal contributions.
   *
   * `retrieve()` returns Core's `RetrievalResult`, which is stable and deliberately carries only what a
   * caller needs to *use* a result. This carries what a caller needs to *show* one: why this node and not
   * that one.
   */
  explain(query: RetrieveQuery): Promise<readonly ScoredCandidate[]>
}

/** Narrowing helper, so a caller does not have to reach for a cast or an `instanceof`. */
export function canExplain(retriever: Retriever): retriever is ExplainingRetriever {
  return typeof (retriever as Partial<ExplainingRetriever>).explain === 'function'
}

/**
 * The deterministic lexical retriever: terms, tags, anchors and graph neighbourhood.
 *
 * This is the Phase 0 behaviour, unchanged, behind the interface. No embeddings and no model: the same
 * question over the same graph returns the same thing in the same order.
 */
export class LexicalGraphRetriever implements Retriever {
  readonly name = 'lexical-graph'
  readonly description =
    'Matches the words in the question against labels, tags and ids, then walks the graph outward.'
  readonly signals: readonly RankSignal[] = ['lexical', 'graph']
  readonly #graph: CoreGraph

  constructor(graph: CoreGraph) {
    this.#graph = graph
  }

  retrieve(query: RetrieveQuery): Promise<RetrievalResult> {
    return Promise.resolve(
      coreRetrieve(this.#graph, {
        ...(query.text === undefined ? {} : { text: query.text }),
        ...(query.nodeIds === undefined ? {} : { nodeIds: query.nodeIds }),
        ...(query.tags === undefined ? {} : { tags: query.tags }),
        ...(query.nodeTypes === undefined ? {} : { nodeTypes: query.nodeTypes }),
        ...(query.actorId === undefined ? {} : { actorId: query.actorId }),
        ...(query.depth === undefined ? {} : { depth: query.depth }),
        ...(query.minScore === undefined ? {} : { minScore: query.minScore }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      }),
    )
  }
}

/** Shared candidate gathering for the retrievers. */
function gatherCandidates(
  graph: CoreGraph,
  query: RetrieveQuery,
  options: { readonly prefilterLexically: boolean },
): {
  readonly reachable: readonly GraphNode[]
  readonly lexicalSeedIds: ReadonlySet<NodeId>
  readonly neighbors: readonly GraphNode[]
} {
  const all = queryNodes(graph.listNodes(), {
    ...(query.tags === undefined ? {} : { tags: query.tags }),
  }).filter((node) => {
    if (query.nodeTypes !== undefined && query.nodeTypes.length > 0) {
      return query.nodeTypes.includes(node.type)
    }
    return true
  })

  const text = query.text ?? ''
  const terms = termsOf(text)
  const lexicalSeedIds = new Set(
    terms.length === 0
      ? all.map((node) => node.id)
      : all.filter((node) => matchedTermsIn(node, terms).length > 0).map((node) => node.id),
  )

  const reachable = options.prefilterLexically
    ? all.filter((node) => lexicalSeedIds.has(node.id))
    : all

  const reachableIds = new Set(reachable.map((node) => node.id))
  const seeds = options.prefilterLexically ? [...reachableIds] : [...lexicalSeedIds]
  const seen = new Set<NodeId>(seeds)
  const neighbors: GraphNode[] = []
  const depth = query.depth ?? 1

  if (depth > 0 && seeds.length > 0) {
    let frontier: readonly NodeId[] = seeds
    let remaining = depth
    while (frontier.length > 0 && remaining > 0) {
      const next: NodeId[] = []
      for (const id of frontier) {
        for (const edge of graph.edgesOf(id)) {
          const other = edge.from === id ? edge.to : edge.from
          if (seen.has(other)) continue
          seen.add(other)
          const node = graph.getNode(other)
          if (node === undefined || node.revoked === true) continue
          if (node.meta.tier === 'draft') continue
          if (query.nodeTypes !== undefined && query.nodeTypes.length > 0) {
            if (!query.nodeTypes.includes(node.type)) {
              next.push(other)
              continue
            }
          }
          neighbors.push(node)
          next.push(other)
        }
      }
      frontier = next
      remaining -= 1
    }
  }

  const outsideReach = neighbors.filter((node) => !reachableIds.has(node.id))
  return { reachable, lexicalSeedIds, neighbors: outsideReach }
}

/** Ranks candidates by embedding similarity alone. */
export class EmbeddingRetriever implements ExplainingRetriever {
  readonly name = 'embedding'
  readonly description =
    'Cosine similarity between the question and each candidate, via an adapter.'
  readonly signals: readonly RankSignal[] = ['semantic']
  readonly #graph: CoreGraph
  readonly #adapter: EmbeddingAdapter
  readonly #cache: EmbeddingCache

  constructor(graph: CoreGraph, adapter: EmbeddingAdapter, cache: EmbeddingCache) {
    this.#graph = graph
    this.#adapter = adapter
    this.#cache = cache
  }

  explain(query: RetrieveQuery): Promise<readonly ScoredCandidate[]> {
    return scoreSemantically(this.#graph, this.#adapter, this.#cache, query, {
      semantic: 1,
      lexical: 0,
      graph: 0,
      cognitive: 0,
      recency: 0,
    })
  }

  async retrieve(query: RetrieveQuery): Promise<RetrievalResult> {
    return toResult(query, await this.explain(query))
  }
}

/**
 * Combines every available signal, including semantic similarity.
 *
 * This is the retriever a product should use: semantic similarity is one relevance signal, and the
 * graph and the actor's own recorded state are evidence a similarity score cannot see.
 */
export class HybridRetriever implements ExplainingRetriever {
  readonly name = 'hybrid'
  readonly description =
    'Combines semantic similarity, lexical overlap, graph proximity, recorded state and recency.'
  readonly signals: readonly RankSignal[] = ['semantic', 'lexical', 'graph', 'cognitive', 'recency']
  readonly #graph: CoreGraph
  readonly #log: EventLog
  readonly #adapter: EmbeddingAdapter
  readonly #cache: EmbeddingCache
  readonly #weights: HybridWeights

  constructor(
    graph: CoreGraph,
    log: EventLog,
    adapter: EmbeddingAdapter,
    cache: EmbeddingCache,
    weights: HybridWeights = DEFAULT_HYBRID_WEIGHTS,
  ) {
    this.#graph = graph
    this.#log = log
    this.#adapter = adapter
    this.#cache = cache
    this.#weights = normalizeWeights(weights)
  }

  get weights(): HybridWeights {
    return this.#weights
  }

  explain(query: RetrieveQuery): Promise<readonly ScoredCandidate[]> {
    return scoreSemantically(this.#graph, this.#adapter, this.#cache, query, this.#weights, {
      log: this.#log,
    })
  }

  async retrieve(query: RetrieveQuery): Promise<RetrievalResult> {
    return toResult(query, await this.explain(query))
  }
}

export type HybridWeights = Readonly<Record<RankSignal, number>>

export const DEFAULT_HYBRID_WEIGHTS: HybridWeights = Object.freeze({
  semantic: 0.5,
  lexical: 0.2,
  graph: 0.15,
  cognitive: 0.1,
  recency: 0.05,
})

function normalizeWeights(weights: HybridWeights): HybridWeights {
  const sum = Object.values(weights).reduce((total, value) => total + value, 0)
  if (sum === 0) return DEFAULT_HYBRID_WEIGHTS
  return Object.freeze({
    semantic: weights.semantic / sum,
    lexical: weights.lexical / sum,
    graph: weights.graph / sum,
    cognitive: weights.cognitive / sum,
    recency: weights.recency / sum,
  })
}

function textOfNode(node: GraphNode): string {
  const tagsText = node.tags.length > 0 ? ` ${node.tags.join(' ')}` : ''
  const statement =
    typeof node.properties.statement === 'string' ? ` ${node.properties.statement}` : ''
  return `${node.label}${statement}${tagsText}`
}

function hopDistances(
  graph: CoreGraph,
  seeds: ReadonlySet<NodeId>,
  maxDepth: number,
): ReadonlyMap<NodeId, number> {
  const distances = new Map<NodeId, number>()
  if (seeds.size === 0 || maxDepth <= 0) return distances

  let frontier: readonly NodeId[] = [...seeds]
  let currentDepth = 0
  for (const seed of seeds) distances.set(seed, 0)

  while (frontier.length > 0 && currentDepth < maxDepth) {
    const next: NodeId[] = []
    currentDepth += 1
    for (const id of frontier) {
      for (const edge of graph.edgesOf(id)) {
        const other = edge.from === id ? edge.to : edge.from
        if (distances.has(other)) continue
        distances.set(other, currentDepth)
        next.push(other)
      }
    }
    frontier = next
  }

  return distances
}

function newestCreatedAt(nodes: readonly GraphNode[]): number {
  return nodes.reduce((max, node) => Math.max(max, node.createdAt), 0)
}

function oldestCreatedAt(nodes: readonly GraphNode[]): number {
  if (nodes.length === 0) return 0
  return nodes.reduce((min, node) => Math.min(min, node.createdAt), nodes[0]?.createdAt ?? 0)
}

const DEFAULT_MIN_SCORE = 0.05
const SEMANTIC_MATCH_THRESHOLD = 0.2

function strongestSimilarity(
  vectors: ReadonlyMap<NodeId, Vector>,
  queryVector: Vector | undefined,
): number {
  if (queryVector === undefined) return 0
  let max = 0
  for (const vector of vectors.values()) {
    max = Math.max(max, similaritySignal(queryVector, vector))
  }
  return max
}

async function scoreSemantically(
  graph: CoreGraph,
  adapter: EmbeddingAdapter,
  cache: EmbeddingCache,
  query: RetrieveQuery,
  weights: HybridWeights,
  context?: { readonly log: EventLog },
): Promise<readonly ScoredCandidate[]> {
  const { reachable, lexicalSeedIds, neighbors } = gatherCandidates(graph, query, {
    prefilterLexically: false,
  })

  if (reachable.length === 0 && neighbors.length === 0) return []

  const candidates: readonly { readonly node: GraphNode; readonly origin: 'match' | 'neighbor' }[] =
    [
      ...reachable.map((node) => ({
        node,
        origin: lexicalSeedIds.has(node.id) ? ('match' as const) : ('neighbor' as const),
      })),
      ...neighbors.map((node) => ({ node, origin: 'neighbor' as const })),
    ]

  const text = query.text ?? ''
  const queryVector = text === '' ? undefined : await embedWithCache(adapter, cache, text)

  const vectors = new Map<NodeId, Vector>()
  const wants = (signal: RankSignal): boolean =>
    weights[signal] > 0 && (query.signals === undefined || query.signals.includes(signal))

  if (queryVector !== undefined && wants('semantic')) {
    for (const entry of candidates) {
      vectors.set(entry.node.id, await embedWithCache(adapter, cache, textOfNode(entry.node)))
    }
  }

  const semanticIsMeaningful = strongestSimilarity(vectors, queryVector) >= SEMANTIC_MATCH_THRESHOLD

  const terms = termsOf(text)
  const branchId =
    context === undefined ? undefined : context.log.currentBranch(query.actorId ?? graph.actorId).id
  const newest = newestCreatedAt(candidates.map((entry) => entry.node))
  const oldest = oldestCreatedAt(candidates.map((entry) => entry.node))
  const seedIds = new Set(
    candidates.filter((entry) => entry.origin === 'match').map((entry) => entry.node.id),
  )
  const hops = hopDistances(graph, seedIds, query.depth ?? 1)

  const scored: ScoredCandidate[] = []
  for (const candidate of candidates) {
    const { node } = candidate
    let origin = candidate.origin
    const matchedTerms = terms.length === 0 ? [] : matchedTermsIn(node, terms)

    const contributions: SignalContribution[] = []
    const push = (
      list: SignalContribution[],
      signal: RankSignal,
      weight: number,
      raw: number,
    ): void => {
      if (weight <= 0) return
      const value = Math.max(0, Math.min(1, raw))
      list.push({ signal, value, weight, contribution: value * weight })
    }

    if (wants('semantic') && queryVector !== undefined && semanticIsMeaningful) {
      const nodeVector = vectors.get(node.id)
      if (nodeVector !== undefined) {
        const value = similaritySignal(queryVector, nodeVector)
        push(contributions, 'semantic', weights.semantic, value)
        if (value >= SEMANTIC_MATCH_THRESHOLD) origin = 'match'
      }
    }

    if (wants('lexical')) {
      push(contributions, 'lexical', weights.lexical, lexicalValue(node, terms, matchedTerms))
    }

    if (wants('graph')) {
      const distance = hops.get(node.id)
      push(contributions, 'graph', weights.graph, graphValue(distance, seedIds.has(node.id)))
    }

    if (context !== undefined && wants('cognitive')) {
      push(
        contributions,
        'cognitive',
        weights.cognitive,
        cognitiveValue(context.log, node.id, query.actorId, branchId),
      )
    }

    if (wants('recency')) {
      push(contributions, 'recency', weights.recency, recencyValue(node, oldest, newest))
    }

    const score = contributions.reduce((total, entry) => total + entry.contribution, 0)

    if (text !== '' && contributions.every((entry) => entry.signal === 'recency')) continue
    if (score < (query.minScore ?? DEFAULT_MIN_SCORE)) continue

    scored.push({ node, score, contributions, matchedTerms, origin })
  }

  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    if (right.node.createdAt !== left.node.createdAt)
      return right.node.createdAt - left.node.createdAt
    return left.node.id < right.node.id ? -1 : left.node.id > right.node.id ? 1 : 0
  })

  return query.limit === undefined ? scored : scored.slice(0, query.limit)
}

async function embedWithCache(
  adapter: EmbeddingAdapter,
  cache: EmbeddingCache,
  text: string,
): Promise<Vector> {
  const key = embeddingKeyFor(text)
  const cached = cache.get(key, adapter.model)
  if (cached !== undefined) return cached

  const vector = await adapter.embed(text)
  if (vector.length === 0) {
    throw new EmbeddingError(
      'malformed_response',
      `adapter "${adapter.model}" returned an empty vector`,
      { model: adapter.model },
    )
  }
  cache.set(key, adapter.model, vector)
  return vector
}

function lexicalValue(
  node: GraphNode,
  terms: readonly string[],
  matchedTerms: readonly string[],
): number {
  if (terms.length === 0) return 0
  const label = node.label.toLowerCase()
  const weighted = matchedTerms.reduce((total, term) => total + (label.includes(term) ? 2 : 1), 0)
  return Math.min(1, weighted / (terms.length * 2))
}

function graphValue(hops: number | undefined, isSeed: boolean): number {
  if (isSeed) return 1
  if (hops === undefined) return 0
  return 1 / (1 + hops)
}

function recencyValue(node: GraphNode, oldest: number, newest: number): number {
  if (newest <= oldest) return 1
  return Math.max(0, Math.min(1, (node.createdAt - oldest) / (newest - oldest)))
}

export function cognitiveValue(
  log: EventLog,
  nodeId: NodeId,
  actorId: ActorId | undefined,
  branchId: BranchId | undefined,
): number {
  if (actorId === undefined) return 0

  const state =
    branchId === undefined
      ? log.stateOf(nodeId, actorId)
      : log.stateOf(nodeId, actorId, { branchId })
  if (state.size === 0) return 0

  const level = (dimension: string): string | undefined => state.get(dimension as never)?.level
  const confidence = level('confidence')
  const articulation = level('articulation')
  const conflict = level('conflict')

  let value = 0.2
  if (conflict !== undefined && conflict !== 'none') value += 0.5
  if (confidence === 'low') value += 0.2
  else if (confidence === 'medium') value += 0.1
  if (articulation === 'low') value += 0.2
  else if (articulation === 'medium') value += 0.1

  if (confidence === 'high' && articulation === 'high') value -= 0.2

  return Math.max(0, Math.min(1, value))
}

export function toResult(
  query: RetrieveQuery,
  candidates: readonly ScoredCandidate[],
): RetrievalResult {
  const matches: RetrievedNode[] = []
  const neighbors: RetrievedNode[] = []

  for (const entry of candidates) {
    const item: RetrievedNode = {
      node: entry.node,
      matchedTerms: entry.matchedTerms,
      origin: entry.origin,
      score: entry.score,
    }
    if (entry.origin === 'match') matches.push(item)
    else neighbors.push(item)
  }

  const all = [...matches.map((e) => e.node), ...neighbors.map((e) => e.node)]
  const allIds = all.map((n) => n.id)

  return Object.freeze({
    query,
    terms: termsOf(query.text ?? ''),
    matches: Object.freeze(matches),
    neighbors: Object.freeze(neighbors),
    nodes: Object.freeze(all),
    nodeIds: Object.freeze(allIds),
  })
}
