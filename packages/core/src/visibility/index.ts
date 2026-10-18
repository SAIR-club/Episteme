import type { CoreGraph, GraphStats } from '../graph/graph.js'
import type { ActorId, EdgeId, NodeId } from '../ontology/ids.js'
import type { GraphEdge, GraphNode, Neighbors, NodeQuery } from '../ontology/resources.js'

/**
 * What one person may see of a shared graph (ADR 0014, decision 2).
 *
 * The rule lives here and nowhere else. Recall, the node and state listings, history, projection and the MCP
 * tools all read through `visibleTo`, so a read path cannot forget it.
 */

/**
 * The read side of a graph: what retrieval, projection and context building use.
 *
 * `CoreGraph` satisfies it, and so does `visibleTo(graph, viewer)`, which is how the same reader serves the whole
 * graph or one person's view of it without knowing which.
 */
export type GraphReadView = Pick<
  CoreGraph,
  | 'registries'
  | 'state'
  | 'actorId'
  | 'getActor'
  | 'listActors'
  | 'getNode'
  | 'getEdge'
  | 'findNodes'
  | 'neighbors'
  | 'incoming'
  | 'outgoing'
  | 'edgesOf'
  | 'listNodes'
  | 'listEdges'
  | 'stats'
>

/**
 * Whether `viewer` may see `node`: they authored it, or it is reference material, or they hold state on it.
 *
 * The last clause keeps a person's own history readable: once they recorded something about a node, it stays
 * theirs to read even if whatever made it visible is later withdrawn. Publications (ADR 0014, S4) add one more
 * clause, here.
 */
export function isNodeVisible(
  node: GraphNode,
  viewer: ActorId,
  hasState: (target: NodeId, actorId: ActorId) => boolean,
): boolean {
  return node.actorId === viewer || node.meta.tier === 'reference' || hasState(node.id, viewer)
}

/** Whether `viewer` may see `edge`: it is their own, and both its ends are visible to them. */
export function isEdgeVisible(
  edge: GraphEdge,
  viewer: ActorId,
  nodeVisible: (id: NodeId) => boolean,
): boolean {
  return edge.actorId === viewer && nodeVisible(edge.from) && nodeVisible(edge.to)
}

/**
 * `graph` as `viewer` may see it: every read filtered by the one rule above, every other read passed through.
 *
 * It has no write methods. A view is for reading; writes go through the graph, as ever.
 */
export function visibleTo(graph: GraphReadView, viewer: ActorId): GraphReadView {
  const nodeVisible = (node: GraphNode | undefined): node is GraphNode =>
    node !== undefined &&
    isNodeVisible(node, viewer, (target, actor) => graph.state.hasState(target, actor))
  const visibleId = (id: NodeId): boolean => nodeVisible(graph.getNode(id))
  const edgeVisible = (edge: GraphEdge | undefined): edge is GraphEdge =>
    edge !== undefined && isEdgeVisible(edge, viewer, visibleId)
  const edges = (list: readonly GraphEdge[]): readonly GraphEdge[] => list.filter(edgeVisible)

  return {
    registries: graph.registries,
    state: graph.state,
    actorId: viewer,
    getActor: (id) => graph.getActor(id),
    listActors: () => graph.listActors(),
    getNode: (id) => {
      const node = graph.getNode(id)
      return nodeVisible(node) ? node : undefined
    },
    getEdge: (id: EdgeId | string) => {
      const edge = graph.getEdge(id)
      return edgeVisible(edge) ? edge : undefined
    },
    findNodes: (query?: NodeQuery) => graph.findNodes(query).filter(nodeVisible),
    neighbors: (id): Neighbors => {
      if (!visibleId(id as NodeId)) return { incoming: [], outgoing: [] }
      const { incoming, outgoing } = graph.neighbors(id)
      return { incoming: edges(incoming), outgoing: edges(outgoing) }
    },
    incoming: (id) => (visibleId(id as NodeId) ? edges(graph.incoming(id)) : []),
    outgoing: (id) => (visibleId(id as NodeId) ? edges(graph.outgoing(id)) : []),
    edgesOf: (id) => (visibleId(id as NodeId) ? edges(graph.edgesOf(id)) : []),
    listNodes: () => graph.listNodes().filter(nodeVisible),
    listEdges: () => edges(graph.listEdges()),
    stats: (): GraphStats => ({
      nodes: graph.listNodes().filter(nodeVisible).length,
      edges: edges(graph.listEdges()).length,
    }),
  }
}
