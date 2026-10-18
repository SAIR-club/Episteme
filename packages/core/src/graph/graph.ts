import { isEpistemeError } from '../errors.js'
import type { Registries } from './registries.js'
import type { GuardGraphView, GraphMutation } from '../guards/index.js'
import { validateMutation } from '../guards/index.js'
import { asId } from '../ontology/ids.js'
import type { ActorId, BranchId, EdgeId, EdgeTypeId, NodeId, NodeTypeId } from '../ontology/ids.js'
import type { Clock } from '../ontology/primitives.js'
import type { Actor } from '../ontology/actor.js'
import type {
  GraphEdge,
  GraphNode,
  Neighbors,
  NodeMeta,
  NodeQuery,
  Tier,
} from '../ontology/resources.js'
import { queryNodes } from '../ontology/resources.js'
import type { DimensionIndex } from '../ontology/state.js'
import type { GraphStorageAdapter } from '../storage/adapter.js'

/**
 * Read-only cognitive state, supplied by the event history.
 *
 * The graph needs the *current* state to answer state-filtered queries and to let
 * guards reason about what an actor currently understands. It is injected rather than
 * owned because event history is the source of truth: the graph must never become a
 * second place where understanding is stored.
 */
export interface CognitiveStateView {
  /** Current dimensions of `target` for `actor`, or an empty index. */
  stateOf(
    target: NodeId,
    actorId: ActorId,
    options?: { readonly branchId?: BranchId },
  ): DimensionIndex
  /** Whether any recorded state exists for this target and actor. */
  hasState(target: NodeId, actorId: ActorId): boolean
  /** Whether a node is a member of a live publication (ADR 0014), so everyone may see it. */
  isNodePublished(id: NodeId | string): boolean
  /** Whether an edge is part of a live publication. */
  isEdgePublished(id: string): boolean
}

export const emptyStateView: CognitiveStateView = {
  stateOf: () => new Map(),
  hasState: () => false,
  isNodePublished: () => false,
  isEdgePublished: () => false,
}

export interface GraphNodeDraft {
  /** Ids are supplied by the caller so that a mutation is fully describable pre-commit. */
  readonly id: NodeId
  readonly type: NodeTypeId
  readonly label: string
  readonly properties?: Readonly<Record<string, unknown>>
  readonly tags?: readonly string[]
  readonly tier?: Tier
  readonly priority?: number
  /** Overrides the acting actor when the node was authored by someone else. */
  readonly actorId?: ActorId
  readonly source?: string
}

export interface GraphEdgeDraft {
  readonly id: EdgeId
  readonly type: EdgeTypeId
  readonly from: NodeId
  readonly to: NodeId
  readonly confidence?: number
  readonly priority?: number
  readonly actorId?: ActorId
  readonly source?: string
}

export interface CoreGraphOptions {
  readonly storage: GraphStorageAdapter
  readonly registries: Registries
  readonly state?: CognitiveStateView
  readonly clock: Clock
  /** Actor used when a draft does not name one. */
  readonly actorId: ActorId
}

/**
 * Why a mutation was refused, in a form a UI can render.
 *
 * `preview` returns this instead of throwing so that "AI suggests a change, user
 * decides" can be built without exception control flow.
 */
export interface MutationRefusal {
  readonly code: string
  readonly message: string
  readonly guard?: string
  readonly details?: Readonly<Record<string, unknown>>
}

export type PreviewResult =
  | { readonly ok: true; readonly mutation: GraphMutation }
  | { readonly ok: false; readonly refusal: MutationRefusal }

export interface GraphStats {
  readonly nodes: number
  readonly edges: number
}

/**
 * The Episteme graph.
 *
 * Every mutation is validated before it is stored, so the graph is always a legal
 * instance of the registered vocabulary. The graph holds structure only: it stores no
 * understanding, and it deliberately has no ranking, feed or recommendation surface.
 */
export class CoreGraph implements GuardGraphView {
  readonly #storage: GraphStorageAdapter
  readonly #registries: Registries
  readonly #state: CognitiveStateView
  readonly #clock: Clock
  readonly #actorId: ActorId
  readonly #actors = new Map<ActorId, Actor>()

  constructor(options: CoreGraphOptions) {
    this.#storage = options.storage
    this.#registries = options.registries
    this.#state = options.state ?? emptyStateView
    this.#clock = options.clock
    this.#actorId = options.actorId
  }

  get registries(): Registries {
    return this.#registries
  }

  get storage(): GraphStorageAdapter {
    return this.#storage
  }

  get state(): CognitiveStateView {
    return this.#state
  }

  /** The actor recorded on entities when a draft does not name one. */
  get actorId(): ActorId {
    return this.#actorId
  }

  /**
   * Registers a known actor.
   *
   * Registering is explicit so that "who believes this" can never be invented by the
   * graph, and so an agent actor is distinguishable from the human it assists.
   */
  registerActor(actor: Actor): Actor {
    this.#actors.set(actor.id, actor)
    return actor
  }

  getActor(id: ActorId | string): Actor | undefined {
    return this.#actors.get(id as ActorId)
  }

  addNode(draft: GraphNodeDraft): GraphNode {
    const node = this.#buildNode(draft)
    this.#apply({ kind: 'node.add', node })
    return node
  }

  addEdge(draft: GraphEdgeDraft): GraphEdge {
    const edge = this.#buildEdge(draft)
    this.#apply({ kind: 'edge.add', edge })
    return edge
  }

  getNode(id: NodeId | string): GraphNode | undefined {
    return this.#storage.getNode(id)
  }

  getEdge(id: EdgeId | string): GraphEdge | undefined {
    return this.#storage.getEdge(id)
  }

  /**
   * Finds nodes matching a query.
   *
   * Drafts and revoked nodes are excluded by default: neither is understanding, so the
   * ordinary ways of looking for something should not surface them. Ask explicitly to see
   * them, which is what a history or review view does.
   *
   * The `forActor` form is the one to reach for when the answer depends on whose
   * understanding matters — it reads through that actor's state, never a shared one.
   */
  findNodes(query: NodeQuery = {}): readonly GraphNode[] {
    return queryNodes(
      this.#storage.listNodes({ includeRevoked: query.includeRevoked === true }),
      query,
    )
  }

  /** Both directions of adjacency; traversal order is a view decision, not a graph one. */
  neighbors(id: NodeId | string): Neighbors {
    const incoming: GraphEdge[] = []
    const outgoing: GraphEdge[] = []
    for (const edge of this.#storage.edgesOf(id)) {
      if (edge.from === id) outgoing.push(edge)
      if (edge.to === id) incoming.push(edge)
    }
    return { incoming, outgoing }
  }

  /** Edges pointing at this node. */
  incoming(id: NodeId | string): readonly GraphEdge[] {
    return this.#storage.edgesOf(id).filter((edge) => edge.to === id)
  }

  /** Edges leaving this node. */
  outgoing(id: NodeId | string): readonly GraphEdge[] {
    return this.#storage.edgesOf(id).filter((edge) => edge.from === id)
  }

  /** Lists registered actors, so an access or policy layer has something to read. */
  listActors(): readonly Actor[] {
    return [...this.#actors.values()]
  }

  /**
   * Retracts a node without removing it.
   *
   * The record stays readable through `getNode` so history and audit stay honest, while
   * `findNodes` and projections hide it. This is why v0 exposes no physical deletion:
   * forgetting should be an explicit, separate act, not a side effect of a normal edit.
   */
  revokeNode(id: NodeId | string): boolean {
    const node = this.#storage.getNode(id)
    if (node === undefined || node.revoked === true) return false
    const revokedAt = this.#clock.now()
    this.#storage.putNode({ ...node, revoked: true, revokedAt, updatedAt: revokedAt })
    return true
  }

  revokeEdge(id: EdgeId | string): boolean {
    const edge = this.#storage.getEdge(id)
    if (edge === undefined || edge.revoked === true) return false
    const revokedAt = this.#clock.now()
    this.#storage.putEdge({ ...edge, revoked: true, revokedAt, updatedAt: revokedAt })
    return true
  }

  edgesOf(id: NodeId | string): readonly GraphEdge[] {
    return this.#storage.edgesOf(id)
  }

  listNodes(): readonly GraphNode[] {
    return this.#storage.listNodes()
  }

  listEdges(): readonly GraphEdge[] {
    return this.#storage.listEdges()
  }

  stats(): GraphStats {
    return { nodes: this.#storage.listNodes().length, edges: this.#storage.listEdges().length }
  }

  /**
   * Validates a node without storing it.
   *
   * Used by the suggestion flow: the graph can answer "would this be accepted?" while
   * the change is still only a proposal awaiting human confirmation.
   */
  previewNode(draft: GraphNodeDraft): PreviewResult {
    return this.#preview({ kind: 'node.add', node: this.#buildNode(draft) })
  }

  previewEdge(draft: GraphEdgeDraft): PreviewResult {
    return this.#preview({ kind: 'edge.add', edge: this.#buildEdge(draft) })
  }

  /** Runs validation and guards, converting expected refusals into a value. */
  #preview(mutation: GraphMutation): PreviewResult {
    try {
      this.#validate(mutation)
      return { ok: true, mutation }
    } catch (error) {
      if (!isEpistemeError(error)) throw error
      const guard = 'guard' in error ? String(error.guard) : undefined
      return {
        ok: false,
        refusal:
          guard === undefined
            ? { code: error.code, message: error.message }
            : { code: error.code, message: error.message, guard },
      }
    }
  }

  #apply(mutation: GraphMutation): void {
    this.#validate(mutation)
    switch (mutation.kind) {
      case 'node.add':
        this.#storage.putNode(mutation.node)
        return
      case 'edge.add':
        this.#storage.putEdge(mutation.edge)
        return
      // Deletion is deliberately not exposed in v0: removed history is a revoke, and
      // physical deletion is reserved for privacy and legal erasure. See ADR 0001.
      case 'node.delete':
      case 'edge.delete':
      case 'state.commit':
        throw new Error(`mutation "${mutation.kind}" must be applied through its own subsystem`)
    }
  }

  #validate(mutation: GraphMutation): void {
    validateMutation(mutation, { registries: this.#registries, graph: this })
  }

  #buildNode(draft: GraphNodeDraft): GraphNode {
    const node: Mutable<GraphNode> = {
      id: draft.id,
      type: draft.type,
      label: draft.label,
      properties: Object.freeze({ ...draft.properties }),
      tags: Object.freeze([...(draft.tags ?? [])]),
      meta: buildMeta(draft.tier),
      createdAt: this.#clock.now(),
      actorId: draft.actorId ?? this.#actorId,
    }
    // Absent stays absent: `exactOptionalPropertyTypes` keeps "not stated" distinct from
    // "stated as unknown", so unset fields are assigned only when a value exists.
    if (draft.source !== undefined) node.source = draft.source
    if (draft.priority !== undefined) node.priority = draft.priority
    return Object.freeze(node)
  }

  #buildEdge(draft: GraphEdgeDraft): GraphEdge {
    const edge: Mutable<GraphEdge> = {
      id: draft.id,
      type: asId<EdgeTypeId>(draft.type),
      from: draft.from,
      to: draft.to,
      createdAt: this.#clock.now(),
      actorId: draft.actorId ?? this.#actorId,
    }
    if (draft.confidence !== undefined) edge.confidence = draft.confidence
    if (draft.priority !== undefined) edge.priority = draft.priority
    if (draft.source !== undefined) edge.source = draft.source
    return Object.freeze(edge)
  }
}

/** Strips the `readonly` modifiers so a builder can populate an entity field by field. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

function buildMeta(tier: Tier | undefined): NodeMeta {
  return tier === undefined ? Object.freeze({}) : Object.freeze({ tier })
}

/** Convenience constructor mirroring how the rest of Core exposes factories. */
export function createGraph(options: CoreGraphOptions): CoreGraph {
  return new CoreGraph(options)
}
