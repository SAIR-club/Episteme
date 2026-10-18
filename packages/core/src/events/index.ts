import { EpistemeError, isEpistemeError } from '../errors.js'
import type { GuardGraphView, GraphMutation } from '../guards/index.js'
import type { Registries } from '../graph/registries.js'
import { validateMutation } from '../guards/index.js'
import type { CognitiveStateView } from '../graph/graph.js'
import { asId } from '../ontology/ids.js'
import type { ActorId, BranchId, DimensionId, EventId, NodeId } from '../ontology/ids.js'
import type { Clock, EpochMillis } from '../ontology/primitives.js'
import type { DimensionIndex, StateEvent, StateEventDraft, StateValue } from '../ontology/state.js'

/**
 * Ids are supplied by the caller.
 *
 * Core never invents identifiers from wall-clock time or randomness, so a history can be
 * replayed exactly. A counter is enough for v0 and keeps the demo and tests deterministic.
 */
export interface IdFactory {
  eventId(): EventId
  branchId(): BranchId
  /**
   * Advances the counters past ids that already exist.
   *
   * A reloaded history must not reuse an id, so a durable adapter calls this with what it
   * restored. Optional because a factory used for a single in-process run never needs it.
   */
  resume?(existing: { eventIds: readonly string[]; branchIds: readonly string[] }): void
}

export function createSequentialIdFactory(prefix = ''): IdFactory {
  let eventCounter = 0
  let branchCounter = 0
  return {
    eventId: () => asId<EventId>(`${prefix}evt_${++eventCounter}`),
    branchId: () => asId<BranchId>(`${prefix}br_${++branchCounter}`),
    resume(existing) {
      eventCounter = Math.max(eventCounter, highestSuffix(existing.eventIds, `${prefix}evt_`))
      branchCounter = Math.max(branchCounter, highestSuffix(existing.branchIds, `${prefix}br_`))
    },
  }
}

/**
 * The largest `<n>` among ids shaped `<prefix><n>`.
 *
 * Used to resume a counter after reload. Without this, a restarted process would begin at
 * `evt_1` again and an id already in the log would be reused — which would silently make two
 * different moments in the history share one identity.
 */
function highestSuffix(ids: Iterable<string>, prefix: string): number {
  let highest = 0
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue
    const parsed = Number.parseInt(id.slice(prefix.length), 10)
    if (Number.isFinite(parsed) && parsed > highest) highest = parsed
  }
  return highest
}

/**
 * A branch is the unit of "a line of inquiry".
 *
 * It starts either as the actor's initial line or as a fork from an event on another branch.
 * `forkPoint` records *where* it starts, which is what lets the branch be read as "everything
 * up to here, then my own changes" — the semantics that make going back meaningful.
 */
export interface Branch {
  readonly id: BranchId
  readonly actorId: ActorId
  /** The branch this one was cut from; absent for the initial branch. */
  readonly parentBranchId?: BranchId
  /** The event this branch starts from; absent for the initial branch. */
  readonly forkPoint?: EventId
  readonly createdAt: EpochMillis
}

/**
 * A request to record a change of understanding.
 *
 * `forkedFrom` is set by `fork` when the new event continues a historical point; a
 * direct `commit` never sets it.
 */
export interface StateCommit extends StateEventDraft {
  readonly forkedFrom?: EventId
}

export interface HistoryQuery {
  readonly target: NodeId
  readonly actorId: ActorId
  /** Tip to walk back from. Defaults to every tip of the actor's branches. */
  readonly from?: EventId
  /** Branch to restrict to. */
  readonly branchId?: BranchId
  /**
   * Read only what this branch could see — its own events plus those of the branches it
   * descends from.
   *
   * This is what makes forking from an earlier understanding meaningful. A branch that starts
   * at an old event must *not* inherit changes made after that point on the original line,
   * otherwise "go back and try something else" would silently pick up everything that
   * happened in the meantime and would not be going back at all.
   */
  readonly lineage?: BranchId
  /**
   * Whether retracted events are included. Defaults to `false`.
   *
   * A revoke does not remove the record — `getEvent` still returns it — it removes the
   * event's *effect* on current state and hides it from the ordinary read. History and
   * audit views ask for it explicitly.
   */
  readonly includeRevoked?: boolean
}

/** A retraction of a recorded state change, itself appended rather than overwriting. */
export interface Revocation {
  readonly eventId: EventId
  readonly reason?: string
  readonly source?: string
  readonly revokedAt: EpochMillis
}

export interface HistoryOrder {
  /** `ascending` reads as a story of change; `descending` reads as a recency list. */
  readonly order?: 'ascending' | 'descending'
}

export interface EventLogOptions {
  readonly registries: Registries
  readonly clock: Clock
  readonly graph: GuardGraphView
  readonly ids?: IdFactory
  /** Seeds the initial branch so the first commit needs no explicit fork. */
  readonly defaultActorId: ActorId
  /** Durable sink, when the log should outlive the process. */
  readonly store?: PersistentEventStore
  /** Restored state. When present the log continues that history instead of starting one. */
  readonly initialState?: EventLogState
}

/** The branch a reloaded history continues from when its own branches are unusable. */
export interface EventLogState {
  readonly branches: readonly Branch[]
  readonly events: readonly StateEvent[]
  readonly branchEvents: readonly {
    readonly branchId: BranchId
    readonly eventIds: readonly EventId[]
  }[]
  readonly revocations: readonly Revocation[]
}

/**
 * Durability seam for the event history.
 *
 * Core only needs "hand me what you have" and "here is the whole thing". Compaction, chunking
 * and incremental writes are the adapter's business: the history is small enough for v0 that
 * writing it whole is the simplest thing that is actually correct, and a smarter backend can
 * implement this port without Core changing.
 */
export interface PersistentEventStore {
  load(): Promise<EventLogState | undefined>
  save(state: EventLogState): Promise<void>
}

export interface EventCommitResult {
  readonly event: StateEvent
  readonly branch: Branch
}

/**
 * Engram — the event-sourced record of changing understanding.
 *
 * Two invariants hold here and nowhere else:
 *
 * 1. **History is the truth.** Current state is always `reduce(events)`. The cache this
 *    class maintains is an optimisation and can be discarded and rebuilt at any time.
 * 2. **Nothing is overwritten.** There is no update or delete. A change of mind is a new
 *    event; a change of direction is a new branch.
 */
export class EventLog implements CognitiveStateView {
  readonly #registries: Registries
  readonly #clock: Clock
  readonly #graph: GuardGraphView
  readonly #ids: IdFactory

  readonly #branches = new Map<BranchId, Branch>()
  readonly #events = new Map<EventId, StateEvent>()
  /** Each event's position in the log, the order it was committed or restored in. Derived, never persisted. */
  readonly #sequence = new Map<EventId, number>()
  readonly #branchEvents = new Map<BranchId, EventId[]>()
  /** `target|actor` → events, in commit order. The read path for projection. */
  readonly #bySubject = new Map<string, EventId[]>()
  /** Retractions, keyed by the event they retract. Never a mutation of that event. */
  readonly #revocations = new Map<EventId, Revocation>()
  /** Derived state; never authoritative. */
  readonly #cache = new Map<string, DimensionIndex>()
  /**
   * Bumped on every append and every retraction.
   *
   * Part of the cache key, which is what makes invalidation total. Deleting only the entry for
   * the subject being written was not enough: the same subject can be read under several keys
   * (one per branch, plus the default), and a commit has to invalidate all of them.
   */
  #revision = 0

  #defaultBranch: BranchId
  readonly #store: PersistentEventStore | undefined

  constructor(options: EventLogOptions) {
    this.#registries = options.registries
    this.#clock = options.clock
    this.#graph = options.graph
    this.#ids = options.ids ?? createSequentialIdFactory()
    this.#store = options.store

    if (options.initialState !== undefined) {
      this.#defaultBranch = this.#restore(options.initialState)
      return
    }

    const branch: Branch = {
      id: this.#ids.branchId(),
      actorId: options.defaultActorId,
      createdAt: this.#clock.now(),
    }
    this.#branches.set(branch.id, branch)
    this.#branchEvents.set(branch.id, [])
    this.#defaultBranch = branch.id
  }

  /**
   * Rebuilds the in-memory indexes from restored state.
   *
   * Everything derived — the branch→events index, the subject index, the state cache — is
   * recomputed here rather than persisted. A durable file holds *facts*; an index is an
   * optimisation that must be reconstructible, or a corrupt index would look like corrupt
   * history and the two could not be told apart.
   */
  #restore(state: EventLogState): BranchId {
    for (const branch of state.branches) this.#branches.set(branch.id, branch)

    for (const event of state.events) {
      const restored: StateEvent = Object.freeze({
        ...event,
        dimensions: new Map(event.dimensions),
      })
      this.#events.set(restored.id, restored)
      this.#sequence.set(restored.id, this.#sequence.size)
      pushTo(this.#bySubject, subjectKey(restored.target, restored.actorId), restored.id)
    }

    for (const entry of state.branchEvents) {
      this.#branchEvents.set(entry.branchId, [...entry.eventIds])
    }

    for (const revocation of state.revocations) {
      this.#revocations.set(revocation.eventId, Object.freeze({ ...revocation }))
    }

    // Ids must continue past what was restored, never restart, or a reloaded process would
    // reuse an id and two different moments would share one identity.
    this.#ids.resume?.({
      eventIds: state.events.map((event) => event.id),
      branchIds: state.branches.map((branch) => branch.id),
    })

    const [first] = state.branches
    if (first === undefined) {
      throw new EpistemeError('guard_rejected', 'restored event log has no branches')
    }
    this.#revision += 1
    return first.id
  }

  /** Everything needed to rebuild this log: facts only, no indexes. */
  snapshot(): EventLogState {
    return {
      branches: [...this.#branches.values()],
      events: [...this.#events.values()],
      branchEvents: [...this.#branchEvents.entries()].map(([branchId, eventIds]) => ({
        branchId,
        eventIds: [...eventIds],
      })),
      revocations: [...this.#revocations.values()],
    }
  }

  /** Writes the current history through the store, if one was configured. */
  async persist(): Promise<void> {
    if (this.#store === undefined) return
    await this.#store.save(this.snapshot())
  }

  get defaultBranchId(): BranchId {
    return this.#defaultBranch
  }

  /** Commits a change of understanding on the actor's current path. */
  commit(request: StateCommit): StateEvent {
    if (request.forkedFrom !== undefined) {
      throw new EpistemeError(
        'guard_rejected',
        'commit must not set forkedFrom; use fork() to continue a historical point',
      )
    }
    const branch = this.currentBranch(request.actorId)
    return this.#append(branch, request)
  }

  /**
   * Continues an existing path from a historical event, without touching it.
   *
   * The original event stays exactly as it was; the new branch simply begins where the
   * chosen point ended. This is what makes "I used to understand it this way, then I went
   * in two different directions" expressible.
   */
  fork(request: StateCommit & { readonly from: EventId }): EventCommitResult {
    const from = this.#requireEvent(request.from)
    if (from.actorId !== request.actorId) {
      throw new EpistemeError(
        'guard_rejected',
        `cannot fork event "${from.id}": it belongs to another actor's path`,
      )
    }

    // Any event can be a fork point, including one that a later event already continued. The
    // new branch reads only its own lineage, so it genuinely starts from the understanding
    // that existed at `from` and does not pick up what happened afterwards.
    const branch: Branch = {
      id: this.#ids.branchId(),
      actorId: request.actorId,
      parentBranchId: from.branchId,
      forkPoint: from.id,
      createdAt: this.#clock.now(),
    }
    this.#branches.set(branch.id, branch)
    this.#branchEvents.set(branch.id, [])

    const event = this.#append(branch, { ...request, forkedFrom: from.id })
    return { event, branch }
  }

  /**
   * Retracts a recorded state change.
   *
   * The event itself is untouched — it stays readable through `getEvent` — so "this was
   * recorded and then withdrawn" remains part of the record. What changes is its *effect*:
   * it is excluded from reduction and hidden from ordinary history reads. Deleting the event
   * would erase the fact that the person once understood something differently, which is
   * exactly what this system exists to keep.
   */
  revokeStateEvent(
    eventId: EventId | string,
    options: { reason?: string; source?: string } = {},
  ): Revocation {
    const event = this.#requireEvent(eventId)
    const existing = this.#revocations.get(event.id)
    if (existing !== undefined) return existing

    // A retraction is itself appended data, so it carries a time and an optional reason.
    const revocation: Revocation = Object.freeze({
      eventId: event.id,
      revokedAt: this.#clock.now(),
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      ...(options.source === undefined ? {} : { source: options.source }),
    })
    this.#revocations.set(event.id, revocation)
    this.#revision += 1
    return revocation
  }

  /** Whether an event has been retracted. */
  isRevoked(eventId: EventId | string): boolean {
    return this.#revocations.has(eventId as EventId)
  }

  /** The retraction of an event, if it was withdrawn. */
  revocationOf(eventId: EventId | string): Revocation | undefined {
    return this.#revocations.get(eventId as EventId)
  }

  /** The path leading to an event, oldest first by default. */
  history(query: HistoryQuery, options: HistoryOrder = {}): readonly StateEvent[] {
    const tips = this.#resolveTips(query)
    const collected: StateEvent[] = []
    const seen = new Set<EventId>()
    const lineage = this.#lineageOf(query)

    for (const tip of tips) {
      let cursor: EventId | undefined = tip
      while (cursor !== undefined) {
        const event = this.#requireEvent(cursor)
        if (event.target !== query.target || event.actorId !== query.actorId) break
        if (seen.has(event.id)) break
        seen.add(event.id)
        // A revoked event is skipped, but traversal continues through it so that anything
        // committed after it still reduces on top of the state that survived the retraction.
        const visible = lineage === undefined || lineage.includes(event.branchId)
        if (visible && (query.includeRevoked === true || !this.#revocations.has(event.id))) {
          collected.push(event)
        }
        cursor = predecessorOf(event)
      }
    }

    // A subject's events are not one chain: a branch runs through every node its actor recorded, so the
    // walk above stops where another node was recorded in between and resumes from the next open end.
    // Reversing what was collected would then order the segments by which open end came first, and the
    // fold would end on a stale value. Sorting by position in the log is chronological whatever the walk.
    // `toSorted` rather than `sort`: the internal index must never be reordered by a read.
    const ascending = collected.toSorted(
      (left, right) => (this.#sequence.get(left.id) ?? 0) - (this.#sequence.get(right.id) ?? 0),
    )
    return options.order === 'descending' ? ascending.toReversed() : ascending
  }

  /**
   * Folds a sequence of events into current state.
   *
   * Exposed because reducing *is* the definition of "currently understood": anything that
   * needs to preview or explain a state must use this, not its own merge.
   */
  reduce(events: Iterable<StateEvent>): DimensionIndex {
    return foldEvents(events)
  }

  /**
   * Current understanding, computed from the event history.
   *
   * By default this reduces every open end of the actor's paths for this subject. Pass
   * `branchId` to ask what the actor understands *on one line of inquiry*, which is the
   * meaningful question once they have forked: without it, two parallel explorations would be
   * folded together as though they were a single belief.
   */
  stateOf(
    target: NodeId,
    actorId: ActorId,
    options: { readonly branchId?: BranchId } = {},
  ): DimensionIndex {
    const key = `${subjectKey(target, actorId)}@${options.branchId ?? '*'}#${this.#revision}`
    const cached = this.#cache.get(key)
    if (cached !== undefined) return cached

    const computed = foldEvents(this.#historyOf(target, actorId, options.branchId))
    this.#cache.set(key, computed)
    return computed
  }

  /**
   * History for a fold: one branch's lineage if named, otherwise every open end.
   *
   * A named branch is read as a stitch of its ancestry, because "what did I understand on this
   * line" is not a single backward walk from one tip:
   *
   * - every ancestor branch contributes the prefix ending at the point the next branch down the
   *   chain forked from it, so changes made afterwards on the original line are *not* inherited;
   * - the branch itself contributes everything it has recorded for this subject.
   *
   * `branchId` is passed through rather than `from`, so the recursion resolves each branch's tip
   * for *this subject* — a branch holds events for every node its actor reasoned about, and the
   * wrong tip would make an ancestor segment silently disappear.
   */
  #historyOf(
    target: NodeId,
    actorId: ActorId,
    branchId: BranchId | undefined,
  ): readonly StateEvent[] {
    if (branchId === undefined) return this.history({ target, actorId })

    const chain = this.branchAncestry(branchId)
    const segments: StateEvent[][] = []

    for (const [index, branch] of chain.entries()) {
      const next: BranchId | undefined = chain[index + 1]
      const forkPoint = next === undefined ? undefined : this.#branches.get(next)?.forkPoint
      segments.push([
        ...this.history({
          target,
          actorId,
          branchId: branch,
          // An ancestor stops where the next branch down the chain forked from it.
          ...(forkPoint === undefined ? {} : { from: forkPoint }),
        }),
      ])
    }

    return segments.flat()
  }

  hasState(target: NodeId, actorId: ActorId): boolean {
    return (this.#bySubject.get(subjectKey(target, actorId))?.length ?? 0) > 0
  }

  getEvent(id: EventId | string): StateEvent | undefined {
    return this.#events.get(id as EventId)
  }

  getBranch(id: BranchId | string): Branch | undefined {
    return this.#branches.get(id as BranchId)
  }

  /**
   * The actor's current path.
   *
   * After a fork the original branch stops being current, because a commit on it would create
   * a second tip and make the actor's own history ambiguous. An actor who has never committed
   * simply opens a branch on first use, so no caller has to create one explicitly.
   */
  currentBranch(actorId: ActorId): Branch {
    const branches = [...this.#branches.values()].filter(
      (branch) => branch.actorId === actorId && !this.#hasChildBranch(branch.id),
    )

    const [branch] = branches
    if (branch !== undefined && branches.length === 1) return branch
    if (branches.length > 1) {
      throw new EpistemeError(
        'guard_rejected',
        `actor "${actorId}" has ${branches.length} open branches; name the branch explicitly`,
      )
    }

    const created: Branch = {
      id: this.#ids.branchId(),
      actorId,
      createdAt: this.#clock.now(),
    }
    this.#branches.set(created.id, created)
    this.#branchEvents.set(created.id, [])
    return created
  }

  /** Branch ids from the initial branch down to `branchId`, oldest first. */
  branchAncestry(branchId: BranchId): readonly BranchId[] {
    const chain: BranchId[] = []
    let cursor: BranchId | undefined = branchId
    while (cursor !== undefined) {
      const branch: Branch | undefined = this.#branches.get(cursor)
      if (branch === undefined) break
      chain.push(branch.id)
      cursor = branch.parentBranchId
    }
    return chain.reverse()
  }

  /** Every branch belonging to an actor, oldest first. */
  branchesOf(actorId: ActorId): readonly Branch[] {
    return [...this.#branches.values()].filter((branch) => branch.actorId === actorId)
  }

  /** Events on a branch, in commit order. */
  eventsOfBranch(branchId: BranchId): readonly StateEvent[] {
    const ids = this.#branchEvents.get(branchId) ?? []
    return ids.map((id) => this.#requireEvent(id))
  }

  /**
   * The open ends of the actor's lines of inquiry.
   *
   * Pass `target` for the honest per-subject answer: a branch holds events for every node its actor
   * has reasoned about, so "this branch's open end" is ambiguous until the subject is named, and a
   * branch whose most recent event is about a *different* node would otherwise hide the open end of
   * this one.
   *
   * Without a target, one tip is returned per branch — the branch's last event overall — which suits
   * a history or overview read. A branch that was forked from before recording anything of its own
   * has no open end, because its content lives on in the branch that forked from it.
   */
  /**
   * The open end of each in-scope branch, at most one event per branch.
   *
   * **Branch-global unless a subject is named**, and the difference is the whole point of this method:
   *
   * - `tips(actorId)` asks "where has this actor left off?" — one answer per branch, because a branch is a
   *   line of inquiry and a line has one end.
   * - `tips(actorId, target)` asks "where has this actor left off *on this node*?" — a different question,
   *   answered by scanning each branch for its most recent event **about that subject**.
   *
   * The second is not the first plus a filter. A branch holds events for every node its actor reasoned
   * about, so filtering the branch tip by target reports nothing whenever the branch's last event happened
   * to concern another node — which is exactly the confusion this method's documentation and its behaviour
   * disagreed about until an invariant test caught it.
   *
   * Branch-scoped *reads* already resolved this correctly through `#lastOnBranchFor`; this brings the
   * querying helper into line with them rather than leaving two answers to one question.
   */
  tips(actorId?: ActorId, target?: NodeId): readonly StateEvent[] {
    const tips: StateEvent[] = []
    for (const branch of this.#branches.values()) {
      if (actorId !== undefined && branch.actorId !== actorId) continue
      const last =
        target === undefined ? this.#tipOf(branch.id) : this.#lastOnBranchFor(branch.id, target)
      if (last === undefined) continue
      const event = this.#events.get(last)
      if (event === undefined) continue
      if (this.#revocations.has(event.id)) continue
      if (target !== undefined && event.target !== target) continue
      tips.push(event)
    }
    // Ordered by creation so the result is stable regardless of map iteration order.
    return tips.sort(
      (left, right) => left.createdAt - right.createdAt || (left.id < right.id ? -1 : 1),
    )
  }

  get eventCount(): number {
    return this.#events.size
  }

  /**
   * Appends an event to a branch.
   *
   * `parent` is the branch's own previous event. A fork's first event therefore has no
   * parent — it begins a new path — while its `forkedFrom` records where that path split
   * off. `predecessorOf` treats the two as one predecessor function, so reducing a lineage
   * still folds everything the fork inherited.
   */
  #append(branch: Branch, request: StateCommit): StateEvent {
    const mutation: GraphMutation = {
      kind: 'state.commit',
      eventId: this.#ids.eventId(),
      target: request.target,
      dimensions: request.dimensions,
    }
    validateMutation(mutation, { registries: this.#registries, graph: this.#graph })

    const parent = this.#continuationOn(branch.id)
    const event: Mutable<StateEvent> = {
      id: mutation.eventId,
      branchId: branch.id,
      target: request.target,
      actorId: request.actorId,
      dimensions: new Map(request.dimensions),
      createdAt: this.#clock.now(),
    }
    // Absent stays absent: a reader can tell "this path split off somewhere" from "it just
    // continues the previous event" only if unset optional fields are genuinely unset.
    if (parent !== undefined) event.parent = parent
    if (request.forkedFrom !== undefined) event.forkedFrom = request.forkedFrom
    if (request.reason !== undefined) event.reason = request.reason
    if (request.source !== undefined) event.source = request.source
    Object.freeze(event)

    this.#events.set(event.id, event)
    this.#sequence.set(event.id, this.#sequence.size)
    this.#branchEvents.get(branch.id)?.push(event.id)
    pushTo(this.#bySubject, subjectKey(event.target, event.actorId), event.id)
    this.#revision += 1
    return event
  }

  #tipOf(branchId: BranchId): EventId | undefined {
    const events = this.#branchEvents.get(branchId) ?? []
    return events[events.length - 1]
  }

  /**
   * The event a new commit on this branch continues from.
   *
   * A branch with no events yet is a fresh fork, so it continues from the event it was cut
   * from. Without this the branch's first event would have no predecessor, and reading the
   * branch could not reach the understanding it started from.
   */
  #continuationOn(branchId: BranchId): EventId | undefined {
    const own = this.#tipOf(branchId)
    if (own !== undefined) return own
    return this.#branches.get(branchId)?.forkPoint
  }

  #hasChildBranch(branchId: BranchId): boolean {
    for (const branch of this.#branches.values()) {
      if (branch.parentBranchId === branchId) return true
    }
    return false
  }

  /**
   * The branches whose events a query may see.
   *
   * Naming a `branchId` is enough on its own: reading one line of inquiry must never include
   * events recorded on a branch that is not its ancestor, or a fork would inherit exactly the
   * change it forked to escape. `lineage` remains as an explicit override.
   */
  #lineageOf(query: HistoryQuery): readonly BranchId[] | undefined {
    const scope = query.lineage ?? query.branchId
    return scope === undefined ? undefined : this.branchAncestry(scope)
  }

  #resolveTips(query: HistoryQuery): readonly EventId[] {
    if (query.from !== undefined) return [this.#requireEvent(query.from).id]
    if (query.branchId !== undefined) {
      const tip = this.#lastOnBranchFor(query.branchId, query.target)
      if (tip !== undefined) return [tip]
      // The branch has not touched this subject. Fall back to the point it forked from, so the
      // read reports what was inherited rather than nothing at all.
      const forkPoint = this.#branches.get(query.branchId)?.forkPoint
      return forkPoint === undefined ? [] : [forkPoint]
    }
    // Copied: a caller must never be able to mutate the log through a returned array.
    return [...this.#openEndsOf(subjectKey(query.target, query.actorId))]
  }

  /**
   * The most recent event a branch holds for one subject.
   *
   * A branch carries events for every node its actor has reasoned about, so "the tip of the
   * branch" is not the same question as "the tip of this branch *for this node*". Conflating
   * them makes a branch-scoped read resolve to another subject's event and then legitimately —
   * but uselessly — find nothing.
   */
  #lastOnBranchFor(branchId: BranchId, target: NodeId): EventId | undefined {
    const events = this.#branchEvents.get(branchId) ?? []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const id = events[index]
      if (id !== undefined && this.#events.get(id)?.target === target) return id
    }
    return undefined
  }

  /**
   * Open ends of one subject's history.
   *
   * An event is an open end when nothing continues it — neither a `parent` on the same path
   * nor a `forkedFrom` where another path split off. Counting forks as continuations is what
   * stops a point that has already been branched from being branched from again, while still
   * allowing one point to be the origin of several paths.
   */
  #openEndsOf(key: string): readonly EventId[] {
    const eventIds = this.#bySubject.get(key) ?? []
    const continued = new Set<EventId>()
    for (const id of eventIds) {
      const event = this.#events.get(id)
      const predecessor = event === undefined ? undefined : predecessorOf(event)
      if (predecessor !== undefined) continued.add(predecessor)
    }
    return eventIds.filter((id) => !continued.has(id))
  }

  #requireEvent(id: EventId | string): StateEvent {
    const event = this.#events.get(id as EventId)
    if (event === undefined) {
      throw new EpistemeError('guard_rejected', `unknown event "${id}"`)
    }
    return event
  }
}

/**
 * Folds a sequence of dimension changes into a state index.
 *
 * Exported because reducing is the definition of "current state"; anything that needs
 * to preview a proposed change must use the same function rather than its own merge.
 */
export function foldEvents(events: Iterable<StateEvent>): DimensionIndex {
  const state = new Map<DimensionId, StateValue>()
  for (const event of events) {
    for (const [dimensionId, value] of event.dimensions) {
      state.set(dimensionId, Object.freeze({ ...value }))
    }
  }
  return state
}

export function createEventLog(options: EventLogOptions): EventLog {
  return new EventLog(options)
}

/** The identity of "one actor's understanding of one node". */
export function subjectKey(target: NodeId, actorId: ActorId): string {
  return `${target}|${actorId}`
}

/**
 * The event immediately before this one on the same path.
 *
 * `parent` is the previous event on this branch; `forkedFrom` continues the path across a
 * branch boundary. Treating them as one predecessor function is what lets a single
 * `reduce` fold an entire lineage, including everything a fork inherited, without
 * special-casing branches anywhere else.
 */
export function predecessorOf(event: StateEvent): EventId | undefined {
  return event.parent ?? event.forkedFrom
}

function pushTo(index: Map<string, EventId[]>, key: string, value: EventId): void {
  const bucket = index.get(key)
  if (bucket === undefined) {
    index.set(key, [value])
    return
  }
  bucket.push(value)
}

/** Strips the `readonly` modifiers so a builder can populate an event field by field. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

export { isEpistemeError }
