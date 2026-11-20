import { EpistemeError, asId, fromSerializedEvent, toSerializedEvent } from '@episteme/core'
import type {
  Publication,
  Withdrawal,
  Branch,
  BranchId,
  EventId,
  EventLogState,
  GraphEdge,
  GraphNode,
  GraphStorageAdapter,
  PersistentEventStore,
  Revocation,
  SerializedStateEvent,
  StateEvent,
} from '@episteme/core'

/**
 * The on-disk schema version.
 *
 * Every record carries it, so a future format change can be recognised and migrated rather than
 * silently misread. Bump this only together with a migration.
 */
export const SERIALIZATION_SCHEMA_VERSION = 1

/** One record per row, tagged by kind so a reader can tell what it is holding. */
export type PersistedRecord =
  | { readonly schemaVersion: number; readonly kind: 'node'; readonly node: GraphNode }
  | { readonly schemaVersion: number; readonly kind: 'edge'; readonly edge: GraphEdge }
  | { readonly schemaVersion: number; readonly kind: 'branch'; readonly branch: Branch }
  | { readonly schemaVersion: number; readonly kind: 'event'; readonly event: SerializedStateEvent }
  | { readonly schemaVersion: number; readonly kind: 'revocation'; readonly revocation: Revocation }
  | {
      readonly schemaVersion: number
      readonly kind: 'publication'
      readonly publication: Publication
    }
  | { readonly schemaVersion: number; readonly kind: 'withdrawal'; readonly withdrawal: Withdrawal }

export type PersistedRecordKind = PersistedRecord['kind']

/**
 * Serializes a record, dropping nothing a reader needs and nothing it does not.
 *
 * Exported so the contract is testable on its own: a round trip through these two functions must be
 * lossless for every record kind, independently of any file I/O.
 */
export function serializeRecord(record: PersistedRecord): string {
  return JSON.stringify(record)
}

/**
 * Parses one stored record back.
 *
 * Throws an `EpistemeError` rather than returning `undefined`, so a caller cannot mistake "this
 * record was unreadable" for "there was no record" and continue with a truncated history. Truncation is
 * exactly the failure that would look like lost understanding.
 */
export function deserializeRecord(body: string, position: number): PersistedRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    throw new EpistemeError(
      'guard_rejected',
      `persisted record ${position} is not valid JSON: ${(error as Error).message}`,
    )
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new EpistemeError('guard_rejected', `persisted record ${position} is not an object`)
  }

  const candidate = parsed as { schemaVersion?: unknown; kind?: unknown }
  if (candidate.schemaVersion !== SERIALIZATION_SCHEMA_VERSION) {
    throw new EpistemeError(
      'guard_rejected',
      `persisted record ${position} has schema version ${String(candidate.schemaVersion)}; this build reads version ${SERIALIZATION_SCHEMA_VERSION}`,
    )
  }

  if (!isKnownKind(candidate.kind)) {
    throw new EpistemeError(
      'guard_rejected',
      `persisted record ${position} has unknown kind "${String(candidate.kind)}"`,
    )
  }
  return parsed as PersistedRecord
}

/** Narrows an unknown value to a record kind, so an unknown kind cannot slip through as `any`. */
function isKnownKind(value: unknown): value is PersistedRecordKind {
  return (
    value === 'node' ||
    value === 'edge' ||
    value === 'branch' ||
    value === 'event' ||
    value === 'revocation' ||
    value === 'publication' ||
    value === 'withdrawal'
  )
}

/** What a load produced, grouped by kind. */
export interface LoadedState {
  readonly nodes: readonly GraphNode[]
  readonly edges: readonly GraphEdge[]
  readonly events: EventLogState
  readonly recordCount: number
}

/**
 * The graph and the event history in memory, as records: the half of the storage that does not touch the database.
 *
 * The adapter reads its records into this on open and writes them back out on save. Everything in between, the graph
 * and event-log ports, is plain memory, kept apart from the SQL so it reads, and is tested, on its own.
 */
export abstract class RecordStorage implements GraphStorageAdapter, PersistentEventStore {
  abstract readonly name: string

  readonly #nodes = new Map<string, GraphNode>()
  readonly #edges = new Map<string, GraphEdge>()
  readonly #branches = new Map<string, Branch>()
  readonly #events = new Map<string, StateEvent>()
  /** Insertion order, which is commit order. Event order is part of the history. */
  readonly #eventOrder: string[] = []
  readonly #branchEvents = new Map<string, string[]>()
  readonly #revocations = new Map<string, Revocation>()
  /** Publications and withdrawals, in the order they were made (ADR 0014). */
  readonly #publications = new Map<string, Publication>()
  readonly #withdrawals = new Map<string, Withdrawal>()
  #loaded = false

  /** Where the graph is kept, for messages. */
  protected abstract get location(): string

  /** Takes ownership and reads the history into memory. Throws `GraphLockedError` when another owner holds it. */
  abstract open(): Promise<LoadedState>

  /** Writes the whole history, absorbing `state` first when the event log offers it. */
  abstract save(state?: EventLogState): Promise<void>

  /** Releases ownership. Does not save (ADR 0006). Closing twice, or before opening, is a no-op. */
  abstract close(): Promise<void>

  /** Copies the graph as last saved to `target`, as a backup to restore by hand. */
  abstract backUp(target: string): Promise<void>

  /**
   * Every record of the history, in the order they are written: nodes, edges, branches, events in commit
   * order, revocations, publications, withdrawals. Reading them back in this order restores the same state.
   */
  records(): readonly PersistedRecord[] {
    const schemaVersion = SERIALIZATION_SCHEMA_VERSION
    const records: PersistedRecord[] = []
    for (const node of this.#nodes.values()) records.push({ schemaVersion, kind: 'node', node })
    for (const edge of this.#edges.values()) records.push({ schemaVersion, kind: 'edge', edge })
    for (const branch of this.#branches.values()) {
      records.push({ schemaVersion, kind: 'branch', branch })
    }
    for (const id of this.#eventOrder) {
      const event = this.#events.get(id)
      if (event === undefined) continue
      records.push({ schemaVersion, kind: 'event', event: toSerializedEvent(event) })
    }
    for (const revocation of this.#revocations.values()) {
      records.push({ schemaVersion, kind: 'revocation', revocation })
    }
    for (const publication of this.#publications.values()) {
      records.push({ schemaVersion, kind: 'publication', publication })
    }
    for (const withdrawal of this.#withdrawals.values()) {
      records.push({ schemaVersion, kind: 'withdrawal', withdrawal })
    }
    return records
  }

  /** Fills memory from the records `open()` read, and marks it open. */
  protected restore(records: Iterable<PersistedRecord>): LoadedState {
    let recordCount = 0
    for (const record of records) {
      this.#apply(record)
      recordCount += 1
    }
    this.#loaded = true
    return {
      nodes: this.listNodes({ includeRevoked: true }),
      edges: this.listEdges({ includeRevoked: true }),
      events: this.#eventState(),
      recordCount,
    }
  }

  /** After this the adapter cannot be written through. */
  protected markClosed(): void {
    this.#loaded = false
  }

  /** Merges event-log state into memory. Never writes; that is the caller's boundary. */
  protected absorb(state: EventLogState): void {
    for (const branch of state.branches) {
      this.#branches.set(branch.id, branch)
      if (!this.#branchEvents.has(branch.id)) this.#branchEvents.set(branch.id, [])
    }
    for (const event of state.events) {
      if (!this.#events.has(event.id)) this.#eventOrder.push(event.id)
      this.#events.set(event.id, event)
    }
    for (const entry of state.branchEvents) {
      this.#branchEvents.set(entry.branchId, [...entry.eventIds])
    }
    for (const revocation of state.revocations) {
      this.#revocations.set(revocation.eventId, revocation)
    }
    for (const publication of state.publications ?? []) {
      this.#publications.set(publication.id, publication)
    }
    for (const withdrawal of state.withdrawals ?? []) {
      this.#withdrawals.set(withdrawal.publicationId, withdrawal)
    }
  }

  protected assertOpen(): void {
    if (!this.#loaded) {
      throw new EpistemeError(
        'guard_rejected',
        `storage "${this.location}" was used before open() or after close(); call open() first`,
      )
    }
  }

  // ── GraphStorageAdapter ────────────────────────────────────────────────────

  getNode(id: string): GraphNode | undefined {
    return this.#nodes.get(id)
  }

  getEdge(id: string): GraphEdge | undefined {
    return this.#edges.get(id)
  }

  listNodes(options?: { readonly includeRevoked?: boolean }): readonly GraphNode[] {
    const nodes = [...this.#nodes.values()]
    return options?.includeRevoked === true ? nodes : nodes.filter((node) => node.revoked !== true)
  }

  listEdges(options?: { readonly includeRevoked?: boolean }): readonly GraphEdge[] {
    const edges = [...this.#edges.values()]
    return options?.includeRevoked === true ? edges : edges.filter((edge) => edge.revoked !== true)
  }

  edgesOf(nodeId: string): readonly GraphEdge[] {
    return [...this.#edges.values()].filter((edge) => edge.from === nodeId || edge.to === nodeId)
  }

  putNode(node: GraphNode): GraphNode {
    this.assertOpen()
    this.#nodes.set(node.id, node)
    return node
  }

  putEdge(edge: GraphEdge): GraphEdge {
    this.assertOpen()
    this.#edges.set(edge.id, edge)
    return edge
  }

  deleteNode(id: string): boolean {
    return this.#nodes.delete(id)
  }

  deleteEdge(id: string): boolean {
    return this.#edges.delete(id)
  }

  revokeNode(id: string): boolean {
    const node = this.#nodes.get(id)
    if (node === undefined || node.revoked === true) return false
    this.#nodes.set(id, { ...node, revoked: true })
    return true
  }

  revokeEdge(id: string): boolean {
    const edge = this.#edges.get(id)
    if (edge === undefined || edge.revoked === true) return false
    this.#edges.set(id, { ...edge, revoked: true })
    return true
  }

  // ── PersistentEventStore ───────────────────────────────────────────────────

  /**
   * The persisted history, or `undefined` when there is none.
   *
   * The distinction is load-bearing: a log handed an empty *state* would try to restore from it and
   * fail, whereas `undefined` correctly means "start a new history". A history with no branches is
   * therefore reported as absent rather than as empty.
   *
   * Not `async`: everything is already in memory after `open()`, so an `async` marker would only add
   * a promise around a value that is immediately available.
   */
  load(): Promise<EventLogState | undefined> {
    this.assertOpen()
    if (this.#branches.size === 0) return Promise.resolve(undefined)
    return Promise.resolve(this.#eventState())
  }

  // ── internals ──────────────────────────────────────────────────────────────

  #eventState(): EventLogState {
    return {
      branches: [...this.#branches.values()],
      events: this.#eventOrder
        .map((id) => this.#events.get(id))
        .filter((event): event is StateEvent => event !== undefined),
      branchEvents: [...this.#branchEvents.entries()].map(([branchId, eventIds]) => ({
        branchId: asId<BranchId>(branchId),
        eventIds: eventIds.map((id) => asId<EventId>(id)),
      })),
      revocations: [...this.#revocations.values()],
      publications: [...this.#publications.values()],
      withdrawals: [...this.#withdrawals.values()],
    }
  }

  #apply(record: PersistedRecord): void {
    switch (record.kind) {
      case 'node':
        this.#nodes.set(record.node.id, record.node)
        return
      case 'edge':
        this.#edges.set(record.edge.id, record.edge)
        return
      case 'branch':
        this.#branches.set(record.branch.id, record.branch)
        return
      case 'event': {
        const event = fromSerializedEvent(record.event)
        if (!this.#events.has(event.id)) this.#eventOrder.push(event.id)
        this.#events.set(event.id, event)
        // The branch→events index is derived, never stored: an event knows its own branch, and the
        // record order is commit order. Writing this index to disk produced empty entries that then
        // shadowed the rebuilt one, which made every branch look like it had no events.
        const bucket = this.#branchEvents.get(event.branchId)
        if (bucket === undefined) this.#branchEvents.set(event.branchId, [event.id])
        else if (!bucket.includes(event.id)) bucket.push(event.id)
        return
      }
      case 'revocation':
        this.#revocations.set(record.revocation.eventId, record.revocation)
        return
      case 'publication':
        this.#publications.set(record.publication.id, record.publication)
        return
      case 'withdrawal':
        this.#withdrawals.set(record.withdrawal.publicationId, record.withdrawal)
        return
    }
  }
}

/**
 * Converts an event to its serialized form, and back.
 *
 * Re-exported from Core so storage does not invent its own durable shape: the serialized event is a
 * contract of Core's, not a detail of this package.
 */
export { toSerializedEvent, fromSerializedEvent } from '@episteme/core'
