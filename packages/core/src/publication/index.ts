import type { MutationRefusal } from '../graph/graph.js'
import type { GuardGraphView } from '../guards/index.js'
import type { ActorId, Brand, EdgeId, NodeId } from '../ontology/ids.js'
import type { EpochMillis } from '../ontology/primitives.js'
import type { GraphEdge, GraphNode } from '../ontology/resources.js'

/** What validating a publication reads of the graph: nodes, their edges, and who an actor is. */
export type PublicationGraph = Pick<GuardGraphView, 'getNode' | 'edgesOf' | 'getActor'>

/**
 * Publications: a person's deliberate act of making part of their understanding public (ADR 0014).
 *
 * A publication is a record, not a node and not a copy. It names the nodes and edges it makes visible, pins them
 * as they are (nodes are immutable), and is withdrawn by a record of its own. Nothing is ever deleted.
 */

export type PublicationId = Brand<string, 'PublicationId'>

export interface Publication {
  readonly id: PublicationId
  /** The author, always a person. */
  readonly actorId: ActorId
  readonly createdAt: EpochMillis
  /** What the author chose to publish. */
  readonly root: NodeId
  /** The nodes made public, the root included. */
  readonly members: readonly NodeId[]
  /** The relations made public between them, and from them to what everyone can already see. */
  readonly edges: readonly EdgeId[]
  /** The author's earlier publication this one replaces. */
  readonly supersedes?: PublicationId
  /** The author's own words about this version. */
  readonly note?: string
  /** Summaries of conversation threads published with it (ADR 0015); never their raw text. */
  readonly threads?: readonly string[]
}

/** The record that withdraws a publication. Browsing and adopting stop; nothing is erased. */
export interface Withdrawal {
  readonly publicationId: PublicationId
  readonly actorId: ActorId
  readonly withdrawnAt: EpochMillis
  readonly reason?: string
}

/** What a person asks to publish. The id comes from the caller, as every id in Core does. */
export interface PublicationDraft {
  readonly id: PublicationId | string
  readonly actorId: ActorId
  readonly root: NodeId | string
  /** Further nodes to publish with the root. Each must be reachable from it through the author's edges. */
  readonly include?: readonly (NodeId | string)[]
  readonly supersedes?: PublicationId | string
  readonly note?: string
  readonly threads?: readonly string[]
}

export type PublicationPreview =
  | { readonly ok: true; readonly publication: Publication }
  | { readonly ok: false; readonly refusal: MutationRefusal }

export interface PublicationsState {
  readonly publications: readonly Publication[]
  readonly withdrawals: readonly Withdrawal[]
}

function refused(code: string, message: string): PublicationPreview {
  return { ok: false, refusal: { code, message, guard: 'core/publication' } }
}

/**
 * The publications of one graph, and the one validation path they go through (ADR 0014, decision 3).
 *
 * `preview` and `publish` share it, so what a person is shown before confirming is exactly what is written.
 */
export class PublicationLog {
  readonly #publications = new Map<string, Publication>()
  readonly #withdrawals = new Map<string, Withdrawal>()
  /** Live members and edges, recomputed on every change; derived, never persisted. */
  #liveNodes = new Set<string>()
  #liveEdges = new Set<string>()

  constructor(initial?: Partial<PublicationsState>) {
    for (const publication of initial?.publications ?? []) {
      this.#publications.set(publication.id, Object.freeze({ ...publication }))
    }
    for (const withdrawal of initial?.withdrawals ?? []) {
      this.#withdrawals.set(withdrawal.publicationId, Object.freeze({ ...withdrawal }))
    }
    this.#reindex()
  }

  get(id: PublicationId | string): Publication | undefined {
    return this.#publications.get(id)
  }

  /** Whether a publication exists and has not been withdrawn. */
  isLive(id: PublicationId | string): boolean {
    return this.#publications.has(id) && !this.#withdrawals.has(id)
  }

  withdrawalOf(id: PublicationId | string): Withdrawal | undefined {
    return this.#withdrawals.get(id)
  }

  /** Every publication not withdrawn, oldest first. */
  live(): readonly Publication[] {
    return [...this.#publications.values()].filter((publication) => this.isLive(publication.id))
  }

  /** Every publication, withdrawn ones included, oldest first. */
  all(): readonly Publication[] {
    return [...this.#publications.values()]
  }

  isNodePublished(id: NodeId | string): boolean {
    return this.#liveNodes.has(id)
  }

  isEdgePublished(id: EdgeId | string): boolean {
    return this.#liveEdges.has(id)
  }

  /**
   * What `draft` would publish, or why it cannot be published.
   *
   * `graph` is the whole graph, not a person's view: whether a member is the author's own is a fact about the
   * node, and an edge to something everyone can see is judged by what everyone can see.
   */
  preview(
    graph: PublicationGraph,
    draft: PublicationDraft,
    createdAt: EpochMillis,
  ): PublicationPreview {
    const author = draft.actorId
    if (graph.getActor(author)?.kind !== 'human') {
      return refused(
        'agent_cannot_publish',
        'only a person publishes; making understanding public is their decision',
      )
    }
    if (this.#publications.has(draft.id)) {
      return refused('duplicate_id', `publication "${draft.id}" already exists`)
    }

    const memberIds = [...new Set([draft.root, ...(draft.include ?? [])].map(String))]
    for (const id of memberIds) {
      const node = graph.getNode(id)
      if (node === undefined || node.revoked === true || node.meta.tier === 'draft') {
        return refused('not_publishable', `"${id}" is not a node that can be published`)
      }
      if (node.actorId !== author) {
        return refused(
          'not_publishable',
          `"${id}" was written by someone else; it can be linked to, never published by ${author}`,
        )
      }
    }

    // Relations: the author's own edges between members, and from a member to what everyone can already see.
    const members = new Set(memberIds)
    const visibleToEveryone = (node: GraphNode | undefined): boolean =>
      node !== undefined &&
      node.revoked !== true &&
      (node.meta.tier === 'reference' || this.#liveNodes.has(node.id))
    const incident = new Map<string, GraphEdge>()
    for (const id of memberIds) for (const edge of graph.edgesOf(id)) incident.set(edge.id, edge)
    const edges = [...incident.values()].filter((edge) => {
      if (edge.revoked === true || edge.actorId !== author) return false
      const fromIn = members.has(edge.from)
      const toIn = members.has(edge.to)
      if (fromIn && toIn) return true
      if (fromIn) return visibleToEveryone(graph.getNode(edge.to))
      if (toIn) return visibleToEveryone(graph.getNode(edge.from))
      return false
    })

    // Every member must be reachable from the root through those edges, so nothing unrelated slips in.
    const reached = new Set<string>([String(draft.root)])
    const queue = [String(draft.root)]
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const edge of edges) {
        const other = edge.from === current ? edge.to : edge.to === current ? edge.from : undefined
        if (other !== undefined && members.has(other) && !reached.has(other)) {
          reached.add(other)
          queue.push(other)
        }
      }
    }
    const unreached = memberIds.filter((id) => !reached.has(id))
    if (unreached.length > 0) {
      return refused(
        'outside_closure',
        `${unreached.join(', ')} cannot be reached from "${draft.root}" through the author's relations`,
      )
    }

    if (draft.supersedes !== undefined) {
      const earlier = this.#publications.get(draft.supersedes)
      if (earlier === undefined || !this.isLive(earlier.id) || earlier.actorId !== author) {
        return refused(
          'invalid_supersedes',
          `"${draft.supersedes}" is not a live publication of ${author}`,
        )
      }
    }

    return {
      ok: true,
      publication: Object.freeze({
        id: draft.id as PublicationId,
        actorId: author,
        createdAt,
        root: draft.root as NodeId,
        members: memberIds as NodeId[],
        edges: edges.map((edge) => edge.id),
        ...(draft.supersedes === undefined
          ? {}
          : { supersedes: draft.supersedes as PublicationId }),
        ...(draft.note === undefined ? {} : { note: draft.note }),
        ...(draft.threads === undefined ? {} : { threads: [...draft.threads] }),
      }),
    }
  }

  /** Validates and records a publication. */
  publish(
    graph: PublicationGraph,
    draft: PublicationDraft,
    createdAt: EpochMillis,
  ): PublicationPreview {
    const preview = this.preview(graph, draft, createdAt)
    if (!preview.ok) return preview
    this.#publications.set(preview.publication.id, preview.publication)
    this.#reindex()
    return preview
  }

  /** Withdraws a live publication. Only its author may. */
  withdraw(
    id: PublicationId | string,
    actorId: ActorId,
    withdrawnAt: EpochMillis,
    reason?: string,
  ):
    | { readonly ok: true; readonly withdrawal: Withdrawal }
    | { readonly ok: false; readonly refusal: MutationRefusal } {
    const publication = this.#publications.get(id)
    if (publication === undefined || !this.isLive(id)) {
      return {
        ok: false,
        refusal: { code: 'not_live', message: `"${id}" is not a live publication` },
      }
    }
    if (publication.actorId !== actorId) {
      return {
        ok: false,
        refusal: {
          code: 'not_the_author',
          message: `only ${publication.actorId} can withdraw "${id}"`,
        },
      }
    }
    const withdrawal: Withdrawal = Object.freeze({
      publicationId: publication.id,
      actorId,
      withdrawnAt,
      ...(reason === undefined ? {} : { reason }),
    })
    this.#withdrawals.set(publication.id, withdrawal)
    this.#reindex()
    return { ok: true, withdrawal }
  }

  state(): PublicationsState {
    return { publications: this.all(), withdrawals: [...this.#withdrawals.values()] }
  }

  #reindex(): void {
    const nodes = new Set<string>()
    const edges = new Set<string>()
    for (const publication of this.live()) {
      for (const id of publication.members) nodes.add(id)
      for (const id of publication.edges) edges.add(id)
    }
    this.#liveNodes = nodes
    this.#liveEdges = edges
  }
}
