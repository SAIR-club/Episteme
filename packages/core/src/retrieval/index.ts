import type { ActorId, NodeId, NodeTypeId } from '../ontology/ids.js'
import type { GraphNode } from '../ontology/resources.js'
import { queryNodes } from '../ontology/resources.js'

/**
 * A request for the part of the graph that is relevant right now.
 *
 * Deliberately deterministic and explainable: v0 retrieves by terms, tags, graph
 * neighbourhood and recency, with no embeddings and no model. The goal is not to retrieve
 * cleverly — it is to prove that Episteme can get *previous understanding* back, and a
 * lexical match can be checked by hand in a way that a similarity score cannot.
 */
export interface RetrievalQuery {
  /** Free text, e.g. the user's question. Matched against labels, tags and ids. */
  readonly text?: string
  /** Explicit anchors: these nodes are relevant whatever the text says. */
  readonly nodeIds?: readonly NodeId[]
  /**
   * Tag patterns, e.g. `['topic:rope']` or `['topic:*']`.
   *
   * A pattern of the form `topic:<nodeId>` also contributes that node as an anchor, because
   * a concept tagged with its own id is a common and useful convention.
   */
  readonly tags?: readonly string[]
  /** Restricts candidates to these node types. */
  readonly nodeTypes?: readonly NodeTypeId[]
  /** Whose state to include. Without it, retrieval is purely structural. */
  readonly actorId?: ActorId
  /**
   * Hops of neighbourhood to include around a match.
   *
   * This is what makes retrieval useful in practice: asking about "RoPE" should also bring
   * back the claim that RoPE was built to address, not only the concept named RoPE.
   */
  readonly depth?: number
  /** Minimum number of distinct query terms a node must match. Defaults to 1. */
  readonly minScore?: number
  readonly limit?: number
}

/** Why one node was retrieved, so a view or a test can justify the result. */
export interface RetrievedNode {
  readonly node: GraphNode
  /** Distinct query terms found in the node, for a readable explanation. */
  readonly matchedTerms: readonly string[]
  /** Whether it matched directly, or arrived by walking out from a match. */
  readonly origin: 'match' | 'neighbor'
  readonly score: number
}

export interface RetrievalResult {
  readonly query: RetrievalQuery
  readonly terms: readonly string[]
  readonly matches: readonly RetrievedNode[]
  readonly neighbors: readonly RetrievedNode[]
  /** Matches first, then neighbours, each group in descending score. */
  readonly nodes: readonly GraphNode[]
  readonly nodeIds: readonly NodeId[]
}

/**
 * Words that carry no retrieval signal.
 *
 * Kept deliberately short. An aggressive stop list would silently drop terms like "not" or
 * "does", and this system cares about *how* something is understood, where such words often
 * distinguish one claim from its opposite.
 */
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'can',
  'did',
  'do',
  'does',
  'for',
  'from',
  'has',
  'have',
  'how',
  'i',
  'if',
  'in',
  'is',
  'it',
  'its',
  'me',
  'my',
  'of',
  'on',
  'or',
  'so',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'why',
  'will',
  'with',
  'you',
  'your',
])

/**
 * Splits text into comparable terms.
 *
 * Lowercased, split on anything that is not a letter or digit, stop words removed, and
 * de-duplicated while keeping first-seen order so the result is stable. Simple on purpose:
 * a stemmer or a model would make the retrieval harder to explain, and explaining *why* a
 * prior understanding surfaced is the whole point of this layer.
 */
export function termsOf(text: string): readonly string[] {
  const seen = new Set<string>()
  const terms: string[] = []
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOP_WORDS.has(raw) || seen.has(raw)) continue
    seen.add(raw)
    terms.push(raw)
  }
  return terms
}

/**
 * Retrieves the part of the graph relevant to a query.
 *
 * The result is derived, never stored: this walks the graph and ranks what it finds, so the
 * same query over the same graph always returns the same thing in the same order. That
 * property is what lets the critical loop be *proved* rather than demonstrated — the test can
 * assert that a later interaction retrieved specific prior understanding.
 */
export function retrieve(
  view: {
    getNode(id: NodeId | string): GraphNode | undefined
    edgesOf(nodeId: NodeId | string): readonly { readonly from: NodeId; readonly to: NodeId }[]
    listNodes(): readonly GraphNode[]
  },
  query: RetrievalQuery = {},
): RetrievalResult {
  const terms = termsOf(query.text ?? '')
  const filters = query.tags ?? []
  const explicit = new Set<NodeId>(query.nodeIds ?? [])
  // Drafts are excluded through the same query path as every other node lookup, so there is
  // one definition of what is visible rather than one per retrieval caller.
  const visible = queryNodes(view.listNodes(), {})
  // A tag filter is a statement of intent, not a hint: which nodes carry those tags is the
  // answer. Without this, a filter-only query would be scored against zero terms and match
  // nothing, which is the opposite of what the caller asked for.
  const tagMatched =
    filters.length === 0
      ? []
      : queryNodes(view.listNodes(), { tags: filters }).map((node) => node.id)
  const anchors = new Set<NodeId>([...explicit, ...tagMatched])

  const matches: RetrievedNode[] = []

  for (const node of visible) {
    if (query.nodeTypes !== undefined && query.nodeTypes.length > 0) {
      if (!query.nodeTypes.includes(node.type)) continue
    }
    const matched = matchedTermsIn(node, terms)
    const isAnchor = anchors.has(node.id)
    if (matched.length === 0 && !isAnchor) continue
    if (!isAnchor && matched.length < (query.minScore ?? 1)) continue

    matches.push({
      node,
      matchedTerms: matched,
      origin: 'match',
      score: scoreOf(node, matched, isAnchor),
    })
  }

  sortRetrieved(matches)

  const limited = query.limit === undefined ? matches : matches.slice(0, query.limit)
  const allowed = new Set(limited.map((entry) => entry.node.id))

  const neighbors = collectNeighbors(view, allowed, query.depth ?? 1, query.nodeTypes)

  return Object.freeze({
    query,
    terms,
    matches: Object.freeze(limited),
    neighbors: Object.freeze(neighbors),
    nodes: Object.freeze([...limited.map((e) => e.node), ...neighbors.map((e) => e.node)]),
    nodeIds: Object.freeze([...allowed, ...neighbors.map((e) => e.node.id)]),
  })
}

/**
 * Whether a token carries no retrieval signal.
 *
 * Exported so a second tokenizer — the Chinese-aware one — can apply the *same* stop list instead of
 * inventing its own. Two stop lists would mean two different notions of "does this match", which is how a
 * lexical signal silently changes meaning when a tokenizer is swapped.
 */
export function isStopWord(token: string): boolean {
  return STOP_WORDS.has(token)
}

/**
 * Terms found in a node's label, tags and id.
 *
 * Exported because lexical overlap is one relevance signal among several, and a hybrid retriever must
 * measure it the same way the lexical one does. Two definitions of "does this match" would drift.
 */
export function matchedTermsIn(node: GraphNode, terms: readonly string[]): readonly string[] {
  if (terms.length === 0) return []
  const haystack = `${node.label} ${node.tags.join(' ')} ${node.id}`.toLowerCase()
  return terms.filter((term) => haystack.includes(term))
}

/**
 * Scores a node for ordering.
 *
 * Label matches outweigh tag matches, because a node *called* "RoPE" is more likely to be
 * what a question about RoPE means than a node merely tagged `rope`. Explicit anchors lead,
 * and recency is the final tie-break — a crude proxy for relevance that at least makes the
 * order total and reproducible.
 */
function scoreOf(node: GraphNode, matched: readonly string[], isAnchor: boolean): number {
  const label = node.label.toLowerCase()
  let score = isAnchor ? 10 : 0
  for (const term of matched) {
    score += label.includes(term) ? 2 : 1
  }
  return score
}

function sortRetrieved(entries: RetrievedNode[]): void {
  entries.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (b.node.createdAt !== a.node.createdAt) return b.node.createdAt - a.node.createdAt
    return a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0
  })
}

/**
 * Walks out from the matches.
 *
 * Neighbours are scored as a fraction of the best match so the two groups stay comparable in
 * an interleaved view, while a direct match always outranks what was merely nearby.
 */
function collectNeighbors(
  view: {
    getNode(id: NodeId | string): GraphNode | undefined
    edgesOf(nodeId: NodeId | string): readonly { readonly from: NodeId; readonly to: NodeId }[]
  },
  matched: ReadonlySet<NodeId>,
  depth: number,
  nodeTypes: readonly NodeTypeId[] | undefined,
): readonly RetrievedNode[] {
  if (depth <= 0 || matched.size === 0) return []

  const visited = new Set<NodeId>(matched)
  const found: RetrievedNode[] = []
  let frontier: NodeId[] = [...matched]
  let remaining = depth

  while (frontier.length > 0 && remaining > 0) {
    const next: NodeId[] = []
    for (const id of frontier) {
      for (const edge of view.edgesOf(id)) {
        const other = edge.from === id ? edge.to : edge.from
        if (visited.has(other)) continue
        visited.add(other)
        const node = view.getNode(other)
        if (node === undefined) continue
        if (node.revoked === true) continue
        if (nodeTypes !== undefined && nodeTypes.length > 0 && !nodeTypes.includes(node.type)) {
          // Still traverse through it, so a two-hop relation is reachable via a node the
          // caller did not ask to see.
          next.push(other)
          continue
        }
        next.push(other)
        found.push({ node, matchedTerms: [], origin: 'neighbor', score: 1 })
      }
    }
    frontier = next
    remaining -= 1
  }

  found.sort((a, b) => {
    if (b.node.createdAt !== a.node.createdAt) return b.node.createdAt - a.node.createdAt
    return a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0
  })
  return Object.freeze(found)
}

export * from './hybrid.js'
export * from './context.js'
