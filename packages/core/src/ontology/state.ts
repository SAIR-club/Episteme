import type { ActorId, BranchId, DimensionId, EventId, NodeId } from './ids.js'
import type { Timestamps } from './primitives.js'

/**
 * A dimension is one independent axis of understanding.
 *
 * Understanding is explicitly *not* a single mastery number. It is a small set of
 * axes — how much you have seen, how confident you are, what evidence you hold,
 * how well you can articulate it, whether you can transfer it, where it conflicts —
 * each of which moves on its own schedule. Domains register extra axes through
 * `registerStateDimension` instead of overloading existing ones.
 */
export type DimensionKind = 'ordinal' | 'boolean' | 'scalar' | 'categorical'

/**
 * The value of one dimension at one point in time.
 *
 * `level` is an opaque token whose legal vocabulary is declared by the dimension
 * definition, so Core never hard-codes "low/high" or any other domain word.
 * `scalar` exists for genuinely continuous axes; it is not a place to smuggle in a
 * composite score.
 */
export interface StateValue {
  readonly level?: string
  readonly scalar?: number
  /**
   * Who stands behind this value.
   *
   * - `author` (default) — the actor whose state this is asserted it themselves.
   * - `suggested` — an agent inferred it.
   * - `confirmed` — an agent suggested it and a human accepted it, so `confirmedBy` must
   *   name that human.
   *
   * This field is what makes "AI may suggest, never author" enforceable rather than
   * aspirational: a `suggested` value is refused at commit time by the AI-ownership guard.
   */
  readonly authority?: StateAuthority
  /** The human who accepted a `confirmed` or agent-derived value. */
  readonly confirmedBy?: ActorId
  /** The suggestion or evidence this value came from, kept so the origin stays traceable. */
  readonly sourceOf?: string
}

/**
 * How a value became the actor's: written by them, only suggested, confirmed by the person, or confirmed for them
 * by the service under a delegation they granted and can revoke (ADR 0016).
 */
export type StateAuthority = 'author' | 'suggested' | 'confirmed' | 'delegated'

/** A resolved snapshot of dimensions for one node, for one actor. */
export type DimensionIndex = ReadonlyMap<DimensionId, StateValue>

/**
 * The record that an actor's understanding of one node changed.
 *
 * This is the most important structure in the system, and its guarantees are hard:
 *
 * - **append-only** — a committed event is never edited or removed;
 * - **immutable** — it is frozen on construction;
 * - **traceable** — it names its actor, its time, and its optional source/reason;
 * - **branchable** — it belongs to a branch and points at the event it continues.
 *
 * A StateEvent records *only what moved*. Silent re-statements of unchanged
 * dimensions are not representable, which keeps the history readable as a story of
 * changes rather than a series of full snapshots.
 */
export interface StateEvent extends Timestamps {
  readonly id: EventId
  readonly branchId: BranchId
  /** The node whose understanding changed. */
  readonly target: NodeId
  /**
   * Whose understanding changed.
   *
   * This is a separate axis from who authored the node: an agent may author a node,
   * while the human's state about it changes. Actor-state isolation depends on it.
   */
  readonly actorId: ActorId
  readonly dimensions: DimensionIndex
  /** What this event continues; absent only when it opens a brand-new lineage. */
  readonly parent?: EventId
  /**
   * The event this branch was cut from, when this event opens a fork.
   *
   * Equal to `parent` for a branch's first event, and recorded separately because the two
   * answer different questions: `parent` is "what came before on the path", while
   * `forkedFrom` is "where did this line of inquiry split off".
   */
  readonly forkedFrom?: EventId
  /** Why the change happened, e.g. `exploration:session-1`. */
  readonly reason?: string
  readonly source?: string
}

export interface StateEventDraft {
  readonly target: NodeId
  readonly actorId: ActorId
  readonly dimensions: ReadonlyMap<DimensionId, StateValue>
  readonly reason?: string
  readonly source?: string
}
