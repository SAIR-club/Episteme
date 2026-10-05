import { dirname } from 'node:path'
import { EpistemeError, asId, fromSerializedEvent, toSerializedEvent } from '@episteme/core'
import type {
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

/** One record per line, tagged by kind so a reader can tell what it is holding. */
export type PersistedRecord =
  | { readonly schemaVersion: number; readonly kind: 'node'; readonly node: GraphNode }
  | { readonly schemaVersion: number; readonly kind: 'edge'; readonly edge: GraphEdge }
  | { readonly schemaVersion: number; readonly kind: 'branch'; readonly branch: Branch }
  | { readonly schemaVersion: number; readonly kind: 'event'; readonly event: SerializedStateEvent }
  | { readonly schemaVersion: number; readonly kind: 'revocation'; readonly revocation: Revocation }

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
 * Parses one line back into a record.
 *
 * Throws an `EpistemeError` rather than returning `undefined`, so a caller cannot mistake "this
 * line was unreadable" for "there was no line" and continue with a truncated history. Truncation is
 * exactly the failure that would look like lost understanding.
 */
export function deserializeRecord(line: string, lineNumber: number): PersistedRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    throw new EpistemeError(
      'guard_rejected',
      `persisted record on line ${lineNumber} is not valid JSON: ${(error as Error).message}`,
    )
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new EpistemeError(
      'guard_rejected',
      `persisted record on line ${lineNumber} is not an object`,
    )
  }

  const candidate = parsed as { schemaVersion?: unknown; kind?: unknown }
  if (candidate.schemaVersion !== SERIALIZATION_SCHEMA_VERSION) {
    throw new EpistemeError(
      'guard_rejected',
      `persisted record on line ${lineNumber} has schema version ${String(candidate.schemaVersion)}; this build reads version ${SERIALIZATION_SCHEMA_VERSION}`,
    )
  }

  if (!isKnownKind(candidate.kind)) {
    throw new EpistemeError(
      'guard_rejected',
      `persisted record on line ${lineNumber} has unknown kind "${String(candidate.kind)}"`,
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
    value === 'revocation'
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
 * A durable local backend: one append-only JSONL file.
 *
 * **Why JSONL and not SQLite.** `node:sqlite` is still experimental and needs a newer Node than
 * this project targets, and a native driver would put a build step between a learner and their own
 * history. A line-delimited log is a dependency-free file that is also readable and diffable by a
 * human, which matters for a system whose whole claim is that its records are inspectable. A
 * personal cognitive graph is written at human speed, so scanning it is not the constraint; if that
 * ever changes, this class implements a port and a SQLite backend can replace it without Core
 * changing.
 *
 * Retracted entities are written as *new records* carrying `revoked: true` rather than by rewriting
 * the earlier line, so the record of the retraction survives alongside what it retracted — the same
 * reasoning as `revokeStateEvent`.
 */
export class LocalStorageAdapter implements GraphStorageAdapter, PersistentEventStore {
  readonly name = 'local'

  readonly #nodes = new Map<string, GraphNode>()
  readonly #edges = new Map<string, GraphEdge>()
  readonly #branches = new Map<string, Branch>()
  readonly #events = new Map<string, StateEvent>()
  /** Insertion order, which is commit order. Event order is part of the history. */
  readonly #eventOrder: string[] = []
  readonly #branchEvents = new Map<string, string[]>()
  readonly #revocations = new Map<string, Revocation>()
  readonly #filePath: string
  #loaded = false

  constructor(filePath: string) {
    this.#filePath = filePath
  }

  get filePath(): string {
    return this.#filePath
  }

  /** Reads the file into memory. A missing file is an empty history, not an error. */
  async open(): Promise<LoadedState> {
    const { readFile } = await import('node:fs/promises')
    let contents = ''
    try {
      contents = await readFile(this.#filePath, 'utf8')
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code !== 'ENOENT') throw error
      this.#loaded = true
      return { nodes: [], edges: [], events: this.#eventState(), recordCount: 0 }
    }

    let recordCount = 0
    for (const [index, raw] of contents.split('\n').entries()) {
      const line = raw.trim()
      if (line === '') continue
      this.#apply(deserializeRecord(line, index + 1))
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

  /**
   * Writes the whole history atomically, absorbing `state` first when the event log offers it.
   *
   * One method rather than a `save(state)` plus a `flush()`: the event-log port and a manual
   * checkpoint want the same thing, and two methods with the same name and different signatures
   * cannot coexist in a class.
   */
  async save(state?: EventLogState): Promise<void> {
    if (state !== undefined) this.#absorb(state)
    this.#assertOpen()
    const { writeFile, rename, mkdir } = await import('node:fs/promises')

    const lines: string[] = []
    for (const node of this.#nodes.values()) {
      lines.push(
        serializeRecord({ schemaVersion: SERIALIZATION_SCHEMA_VERSION, kind: 'node', node }),
      )
    }
    for (const edge of this.#edges.values()) {
      lines.push(
        serializeRecord({ schemaVersion: SERIALIZATION_SCHEMA_VERSION, kind: 'edge', edge }),
      )
    }
    for (const branch of this.#branches.values()) {
      lines.push(
        serializeRecord({ schemaVersion: SERIALIZATION_SCHEMA_VERSION, kind: 'branch', branch }),
      )
    }
    for (const id of this.#eventOrder) {
      const event = this.#events.get(id)
      if (event === undefined) continue
      lines.push(
        serializeRecord({
          schemaVersion: SERIALIZATION_SCHEMA_VERSION,
          kind: 'event',
          event: toSerializedEvent(event),
        }),
      )
    }
    for (const revocation of this.#revocations.values()) {
      lines.push(
        serializeRecord({
          schemaVersion: SERIALIZATION_SCHEMA_VERSION,
          kind: 'revocation',
          revocation,
        }),
      )
    }

    // A temporary file plus a rename: a crash mid-write leaves the previous complete history
    // intact rather than a half-written one.
    const temporary = `${this.#filePath}.tmp`
    await mkdir(dirname(this.#filePath), { recursive: true })
    await writeFile(temporary, lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8')
    await rename(temporary, this.#filePath)
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
    this.#assertOpen()
    this.#nodes.set(node.id, node)
    return node
  }

  putEdge(edge: GraphEdge): GraphEdge {
    this.#assertOpen()
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
   * fail, whereas `undefined` correctly means "start a new history". A file with no branches is
   * therefore reported as absent rather than as empty.
   */
  /**
   * The persisted history, or `undefined` when there is none.
   *
   * The distinction is load-bearing: a log handed an empty *state* would try to restore from it and
   * fail, whereas `undefined` correctly means "start a new history". A file with no branches is
   * therefore reported as absent rather than as empty.
   *
   * Not `async`: everything is already in memory after `open()`, so an `async` marker would only add
   * a promise around a value that is immediately available.
   */
  load(): Promise<EventLogState | undefined> {
    this.#assertOpen()
    if (this.#branches.size === 0) return Promise.resolve(undefined)
    return Promise.resolve(this.#eventState())
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Merges event-log state into memory. Never writes the file; that is the caller's boundary. */
  #absorb(state: EventLogState): void {
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
  }

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
        // file order is commit order. Writing this index to disk produced empty entries that then
        // shadowed the rebuilt one, which made every branch look like it had no events.
        const bucket = this.#branchEvents.get(event.branchId)
        if (bucket === undefined) this.#branchEvents.set(event.branchId, [event.id])
        else if (!bucket.includes(event.id)) bucket.push(event.id)
        return
      }
      case 'revocation':
        this.#revocations.set(record.revocation.eventId, record.revocation)
        return
    }
  }

  #assertOpen(): void {
    if (!this.#loaded) {
      throw new EpistemeError(
        'guard_rejected',
        `storage "${this.#filePath}" was used before open(); call open() first`,
      )
    }
  }
}

/** Opens a file-backed adapter and reads whatever is already there. */
export async function openLocalStorage(filePath: string): Promise<LocalStorageAdapter> {
  const storage = new LocalStorageAdapter(filePath)
  await storage.open()
  return storage
}

/**
 * Converts an event to its serialized form, and back.
 *
 * Re-exported from Core so adapters do not each invent a durable shape: the serialized event is a
 * contract shared by every backend, not a detail of this one.
 */
export { toSerializedEvent, fromSerializedEvent } from '@episteme/core'
