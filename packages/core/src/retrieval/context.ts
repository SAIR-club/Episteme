import type {
  ActorId,
  CoreGraph,
  EventLog,
  GraphNode,
  NodeId,
  RetrievalQuery,
  StateValue,
} from '../index.js'
import {
  LexicalGraphRetriever,
  canExplain,
  type RankSignal,
  type Retriever,
  type SignalContribution,
} from './hybrid.js'

/**
 * What the actor already understands about a retrieved node.
 */
export interface KnownUnderstanding {
  readonly nodeId: NodeId
  readonly label: string
  readonly type: string
  readonly state: Readonly<Record<string, StateValue>>
  /** Whether the actor holds this with enough confidence to build on it. */
  readonly settled: boolean
  /** Dimensions the actor currently has marked as conflicting, if any. */
  readonly openConflicts: readonly string[]
}

export interface RankedEntry {
  readonly nodeId: NodeId
  readonly score: number
  readonly origin: 'match' | 'neighbor'
  readonly matchedTerms: readonly string[]
  readonly contributions: readonly SignalContribution[]
}

export interface RelevantContext {
  readonly question: string
  readonly actorId: ActorId | undefined
  /** Terms the query was reduced to, so the retrieval can be explained. */
  readonly terms: readonly string[]
  /** Every node the retrieval surfaced, in ranked order. */
  readonly nodes: readonly GraphNode[]
  /** What this actor already understands about those nodes. */
  readonly known: readonly KnownUnderstanding[]
  /** One-line rendering of prior understanding. */
  readonly summary: string
  readonly query: RetrievalQuery
  /** Which retriever produced this. */
  readonly retriever: string
  /** Detailed ranking breakdown if available. */
  readonly ranked?: readonly RankedEntry[]
}

const SETTLED_DIMENSIONS: Readonly<Record<string, readonly string[]>> = {
  confidence: ['medium', 'high'],
  articulation: ['medium', 'high'],
}

export interface RetrieveContextOptions {
  readonly actorId?: ActorId
  readonly tags?: readonly string[]
  readonly nodeTypes?: RetrievalQuery['nodeTypes']
  readonly depth?: number
  readonly limit?: number
  readonly retriever?: Retriever
  readonly signals?: readonly RankSignal[]
}

/**
 * Retrieves the cognitive context relevant to a query.
 */
export function retrieveRelevantContext(
  graph: CoreGraph,
  log: EventLog,
  question: string,
  options: RetrieveContextOptions = {},
): Promise<RelevantContext> {
  return retrieveWith(
    options.retriever ?? new LexicalGraphRetriever(graph),
    graph,
    log,
    question,
    options,
  )
}

/**
 * Retrieves context through a named retriever.
 */
export async function retrieveWith(
  retriever: Retriever,
  graph: CoreGraph,
  log: EventLog,
  question: string,
  options: RetrieveContextOptions = {},
): Promise<RelevantContext> {
  const result = await retriever.retrieve({
    text: question,
    ...(options.actorId === undefined ? {} : { actorId: options.actorId }),
    ...(options.tags === undefined ? {} : { tags: options.tags }),
    ...(options.nodeTypes === undefined ? {} : { nodeTypes: options.nodeTypes }),
    ...(options.signals === undefined ? {} : { signals: options.signals }),
    depth: options.depth ?? 1,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  })

  const actorId = options.actorId

  const ranked = canExplain(retriever)
    ? (
        await retriever.explain({
          text: question,
          ...(actorId === undefined ? {} : { actorId }),
          ...(options.tags === undefined ? {} : { tags: options.tags }),
          ...(options.nodeTypes === undefined ? {} : { nodeTypes: options.nodeTypes }),
          ...(options.signals === undefined ? {} : { signals: options.signals }),
          depth: options.depth ?? 1,
          ...(options.limit === undefined ? {} : { limit: options.limit }),
        })
      ).map((entry) => ({
        nodeId: entry.node.id,
        score: entry.score,
        contributions: entry.contributions,
        matchedTerms: entry.matchedTerms,
        origin: entry.origin,
      }))
    : undefined

  const known: KnownUnderstanding[] = []
  if (actorId !== undefined) {
    for (const node of result.nodes) {
      const current = graph.getNode(node.id) ?? node
      const state = log.stateOf(current.id, actorId)
      if (state.size === 0) continue

      const record: Record<string, StateValue> = {}
      const openConflicts: string[] = []
      let settled = false

      for (const [dimension, value] of state) {
        record[dimension] = value
        if (dimension === 'conflict' && value.level !== undefined && value.level !== 'none') {
          openConflicts.push(value.level)
        }
        const levels = SETTLED_DIMENSIONS[dimension]
        if (levels !== undefined && value.level !== undefined && levels.includes(value.level)) {
          settled = true
        }
      }

      known.push({
        nodeId: current.id,
        label: current.label,
        type: current.type,
        state: Object.freeze(record),
        settled,
        openConflicts: Object.freeze(openConflicts),
      })
    }
  }

  return Object.freeze({
    question,
    actorId,
    terms: result.terms,
    nodes: result.nodes,
    known: Object.freeze(known),
    summary: summarise(known),
    query: result.query,
    retriever: retriever.name,
    ...(ranked === undefined ? {} : { ranked: Object.freeze(ranked) }),
  })
}

export function summarise(known: readonly KnownUnderstanding[]): string {
  if (known.length === 0) return ''

  return known
    .map((entry) => {
      const levels = Object.entries(entry.state)
        .map(([dimension, value]) => `${dimension}=${value.level ?? value.scalar ?? '?'}`)
        .sort()
        .join(', ')
      const conflicts =
        entry.openConflicts.length > 0 ? ` (unresolved: ${entry.openConflicts.join('/')})` : ''
      return `${entry.label} [${levels}]${conflicts}`
    })
    .join('; ')
}

export function contextSummary(context: RelevantContext): string {
  return context.summary === '' ? 'nothing is recorded about this yet' : context.summary
}

/** The subset of prior understanding the actor appears ready to build on. */
export function settledUnderstanding(context: RelevantContext): readonly KnownUnderstanding[] {
  return context.known.filter((entry) => entry.settled)
}

/** Whether the actor has already recorded an unresolved conflict anywhere in this context. */
export function hasOpenConflict(context: RelevantContext): boolean {
  return context.known.some((entry) => entry.openConflicts.length > 0)
}

/** Translates retrieved context into the structured form an agent reads. */
export function toAgentContext(context: RelevantContext): {
  summary: string
  nodeIds: readonly NodeId[]
  detail: Readonly<Record<string, unknown>>
} {
  return {
    summary: context.summary,
    nodeIds: context.nodes.map((node) => node.id),
    detail: {
      settledLabels: settledUnderstanding(context).map((entry) => entry.label),
      openConflicts: [...new Set(context.known.flatMap((entry) => entry.openConflicts))],
      known: context.known,
      terms: context.terms,
    },
  }
}
