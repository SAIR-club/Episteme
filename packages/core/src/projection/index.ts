import type { GraphReadView } from '../visibility/index.js'
import type { ActorId, DimensionId, NodeId, NodeTypeId } from '../ontology/ids.js'
import type { EpochMillis } from '../ontology/primitives.js'
import type { GraphEdge, GraphNode, SubGraph } from '../ontology/resources.js'
import type { StateValue } from '../ontology/state.js'

/**
 * How a view selects nodes.
 *
 * Values inside one criterion are OR-ed (any of these topics), while different
 * criteria narrow the result. Every criterion is optional, and an absent criterion
 * means "do not filter on this" rather than "match nothing".
 */
export interface ProjectionFilter {
  /** Scene tags such as `scene:learn`, `scene:forum`. */
  readonly scene?: readonly string[]
  /** Tag namespaces AND their values, e.g. `topic` → `['transformer']`. */
  readonly tags?: Readonly<Record<string, readonly string[]>>
  /** Whose cognitive state the state filter is evaluated against. */
  readonly actor?: ActorId
  /** Whose authored nodes to include. Independent of `actor`. */
  readonly authoredBy?: ActorId
  /** Node types to include, e.g. only `claim` nodes. */
  readonly nodeTypes?: readonly NodeTypeId[]
  /**
   * Current state of the node for `actor` — at least one must hold.
   *
   * Matching uses each dimension's *own* final value, so `state: { confidence: 'high' }`
   * means "currently high", not "was ever high".
   */
  readonly state?: Readonly<Record<string, StateValue>>
  /**
   * Hop count from a seed node. `0` returns seeds only; `1` adds direct neighbours.
   * `Infinity` follows the connected component.
   */
  readonly depth?: number
  readonly timeRange?: { readonly from?: EpochMillis; readonly to?: EpochMillis }
}

/**
 * A projection plus the provenance of the projection itself.
 *
 * The trace is why a view can explain itself: "this appeared because it is tagged
 * `topic:transformer`" and "this appeared because it is one hop from a seed" are
 * different claims, and a Learner View needs to tell them apart.
 */
export interface Projection extends SubGraph {
  readonly seeds: readonly NodeId[]
  readonly expanded: readonly NodeId[]
  readonly filter: ProjectionFilter
}

const UNLIMITED = Number.POSITIVE_INFINITY

/**
 * Derives a view over one graph.
 *
 * This is the only sanctioned way to build `Learn`, `Forum` or `Research` surfaces:
 * they differ by projection rule, not by data model, so no second graph ever appears.
 * Edges are kept only when both endpoints survive, because a dangling edge would imply
 * knowledge that the view cannot show.
 */
export function project(graph: GraphReadView, filter: ProjectionFilter = {}): Projection {
  const candidates = selectSeeds(graph, filter)
  const depth = filter.depth ?? 1
  const reached = expand(graph, candidates, depth)

  const included = new Set<NodeId>()
  for (const id of reached) {
    const node = graph.getNode(id)
    if (node === undefined) continue
    if (!matchesType(node, filter)) continue
    if (!matchesTimeRange(node.createdAt, filter)) continue
    if (!matchesState(graph, node, filter)) continue
    included.add(node.id)
  }

  const nodes: GraphNode[] = []
  for (const id of included) {
    const node = graph.getNode(id)
    if (node !== undefined) nodes.push(node)
  }

  const edges: GraphEdge[] = graph
    .listEdges()
    .filter((edge) => included.has(edge.from) && included.has(edge.to))

  // Seeds are reported only if they survived the gates; a seed that was reached by scope but
  // excluded by type or state is not part of this view and must not be claimed as its origin.
  const seeds = candidates.filter((id) => included.has(id))
  const expanded: NodeId[] = []
  for (const id of included) {
    if (!seeds.includes(id)) expanded.push(id)
  }

  return Object.freeze({
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    seeds: Object.freeze(seeds),
    expanded: Object.freeze(expanded),
    filter,
  })
}

/**
 * Whether a node is a seed: it matches the view's scope directly.
 *
 * Scope criteria — scene, tags, authoring actor — only decide where the view *starts*. An
 * unrestricted filter makes every node a seed, which is what "show me everything I have"
 * means. `nodeTypes`, `state` and `timeRange` are applied as gates afterwards instead, so
 * that depth can still pull in the neighbours a view needs to make sense.
 */
export function selectSeeds(graph: GraphReadView, filter: ProjectionFilter): readonly NodeId[] {
  const scene = filter.scene ?? []
  const tagCriteria = Object.entries(filter.tags ?? {})
  const unrestricted =
    scene.length === 0 &&
    tagCriteria.length === 0 &&
    filter.actor === undefined &&
    filter.authoredBy === undefined

  const seeds: NodeId[] = []
  for (const node of graph.listNodes()) {
    if (unrestricted) {
      seeds.push(node.id)
      continue
    }
    if (filter.authoredBy !== undefined && node.actorId !== filter.authoredBy) continue
    if (scene.length > 0 && !scene.some((tag) => node.tags.includes(tag))) continue
    if (!tagCriteria.every(([namespace, values]) => hasNamespaceTag(node, namespace, values))) {
      continue
    }
    seeds.push(node.id)
  }
  return Object.freeze(seeds)
}

/**
 * Breadth-first expansion from the seeds.
 *
 * Traversal is undirected: an edge is a relation, and which end you arrived from is a
 * view concern. The visited set makes the walk linear in the size of the component.
 */
function expand(graph: GraphReadView, seeds: readonly NodeId[], depth: number): readonly NodeId[] {
  const visited = new Set<NodeId>(seeds)
  const order: NodeId[] = [...seeds]
  if (depth <= 0) return order

  let frontier: NodeId[] = [...seeds]
  let remaining = depth === UNLIMITED ? UNLIMITED : depth

  while (frontier.length > 0 && remaining > 0) {
    const next: NodeId[] = []
    for (const id of frontier) {
      for (const edge of graph.edgesOf(id)) {
        const other = edge.from === id ? edge.to : edge.from
        if (visited.has(other)) continue
        visited.add(other)
        next.push(other)
        order.push(other)
      }
    }
    frontier = next
    if (remaining !== UNLIMITED) remaining -= 1
  }

  return order
}

/** Matches when the node carries `namespace:value` for one of the values. */
function hasNamespaceTag(node: GraphNode, namespace: string, values: readonly string[]): boolean {
  const prefix = `${namespace}:`
  return node.tags.some((tag) => {
    if (!tag.startsWith(prefix)) return false
    return values.includes(tag.slice(prefix.length))
  })
}

/**
 * Whether the node's type is wanted in the *result*.
 *
 * Traversal is deliberately not restricted by type: a depth-1 view of one claim type still
 * needs to walk through the concepts it refers to in order to reach other claims.
 */
function matchesType(node: GraphNode, filter: ProjectionFilter): boolean {
  const nodeTypes = filter.nodeTypes ?? []
  return nodeTypes.length === 0 || nodeTypes.includes(node.type)
}

function matchesTimeRange(createdAt: EpochMillis, filter: ProjectionFilter): boolean {
  const range = filter.timeRange
  if (range === undefined) return true
  if (range.from !== undefined && createdAt < range.from) return false
  if (range.to !== undefined && createdAt > range.to) return false
  return true
}

/**
 * Whether the node's *current* understanding satisfies the requested state.
 *
 * Every requested dimension must hold, and each is compared against its own final value
 * rather than any historical one. Reading through the graph keeps this honest: current
 * state is whatever `reduce` produces, never a cached flag.
 */
function matchesState(graph: GraphReadView, node: GraphNode, filter: ProjectionFilter): boolean {
  const criteria = Object.entries(filter.state ?? {})
  if (criteria.length === 0) return true
  if (filter.actor === undefined) return true

  const state = graph.state.stateOf(node.id, filter.actor)
  return criteria.every(([dimension, expected]) => {
    const actual = state.get(dimension as DimensionId)
    if (actual === undefined) return false
    if (expected.level !== undefined && actual.level !== expected.level) return false
    if (expected.scalar !== undefined && actual.scalar !== expected.scalar) return false
    return true
  })
}

/** The state dimensions a view would display, in registry order. */
export function dimensionsOf(graph: GraphReadView, node: GraphNode, actor: ActorId): DimensionId[] {
  return [...graph.state.stateOf(node.id, actor).keys()]
}

export function toSubGraph(projection: Projection): SubGraph {
  return { nodes: projection.nodes, edges: projection.edges }
}
