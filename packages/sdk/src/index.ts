import {
  EventLog,
  applyDomainPacks,
  asId,
  createFixedClock,
  createGraph,
  createRegistries,
  systemClock,
  type Actor,
  type ActorId,
  type Clock,
  type CoreGraph,
  type DomainPack,
  type GraphStorageAdapter,
  type PersistentEventStore,
  type Registries,
} from '@episteme/core'
import { createMemoryStorage } from '@episteme/storage-memory'

/**
 * The composition surface.
 *
 * Core deliberately exposes its parts separately — storage, registries, graph, event log — because
 * each has to be replaceable and testable on its own. Every consumer then has to wire the four
 * together in the same order, and getting the order wrong is not a type error: the event log validates
 * against a graph, so a log built before the graph has loaded would reject writes that are legal.
 *
 * This package exists to have that order in exactly one place. It is not a second way to use Core: it
 * composes Core's public API and adds nothing that Core already does.
 *
 * ## Actor identifiers
 *
 * A composition is about *knowledge*, not about users, so it does not own an identity model. The
 * caller registers the actors it knows and names the human whose understanding is the subject. There
 * is no authentication here and none is implied.
 */
export interface ComposeOptions {
  /** Where the graph lives. Defaults to memory, which loses everything on exit. */
  readonly storage?: GraphStorageAdapter
  /** Durable sink for the event history. Required for anything to survive a restart. */
  readonly store?: PersistentEventStore
  readonly clock?: Clock
  /** The human whose understanding this instance is about. */
  readonly actorId?: ActorId
  /** Extra actors to register, such as the agent that assists them. */
  readonly actors?: readonly Actor[]
  /** Domain packs to apply, in order. Defaults to an empty list (pure microkernel). */
  readonly packs?: readonly DomainPack[]
}

export interface Episteme {
  readonly graph: CoreGraph
  readonly log: EventLog
  readonly registries: Registries
  /** The human whose understanding this instance is about. */
  readonly actorId: ActorId
  /** Writes the event history through the store, if one is configured. */
  persist(): Promise<void>
}

export const DEFAULT_HUMAN_ID = asId<ActorId>('actor_human')

/**
 * Builds an instance over whatever storage it is given.
 *
 * `initialState` is passed in rather than fetched here, because reading it is asynchronous and this
 * function is not: a caller that wants a durable instance uses `openEpisteme`, which loads first. That
 * separation is what keeps the ordering rule below impossible to get wrong.
 */
export function compose(options: ComposeOptions = {}): Episteme {
  const registries = createRegistries()
  applyDomainPacks(options.packs ?? [], { registries })

  const clock = options.clock ?? systemClock
  const actorId = options.actorId ?? DEFAULT_HUMAN_ID
  const storage = options.storage ?? createMemoryStorage()

  const graph = createGraph({ storage, registries, clock, actorId })
  for (const actor of options.actors ?? []) graph.registerActor(actor)

  const log = new EventLog({
    registries,
    clock,
    graph,
    defaultActorId: actorId,
    ...(options.store === undefined ? {} : { store: options.store }),
  })

  // The graph the *application* reads is wired to the log, so state-filtered projections work. The log
  // keeps the unwired graph: validation needs nodes and edges, never state, and wiring state into the
  // validating view would make the two views mutually dependent.
  const wired = createGraph({ storage, registries, state: log, clock, actorId })
  for (const actor of options.actors ?? []) wired.registerActor(actor)

  return {
    graph: wired,
    log,
    registries,
    actorId,
    persist: () => log.persist(),
  }
}

/**
 * Builds a durable instance: reads the store first, then composes over it.
 *
 * This exists so the ordering rule has one implementation. Reading before composing is what lets a
 * reloaded history be validated against a graph that already contains its nodes.
 */
export async function openEpisteme(
  store: PersistentEventStore & GraphStorageAdapter,
  options: Omit<ComposeOptions, 'storage' | 'store'> = {},
): Promise<Episteme> {
  const initialState = await store.load()
  const registries = createRegistries()
  applyDomainPacks(options.packs ?? [], { registries })

  const clock = options.clock ?? systemClock
  const actorId = options.actorId ?? DEFAULT_HUMAN_ID

  const graph = createGraph({ storage: store, registries, clock, actorId })
  for (const actor of options.actors ?? []) graph.registerActor(actor)

  const log = new EventLog({
    registries,
    clock,
    graph,
    defaultActorId: actorId,
    store,
    ...(initialState === undefined ? {} : { initialState }),
  })

  const wired = createGraph({ storage: store, registries, state: log, clock, actorId })
  for (const actor of options.actors ?? []) wired.registerActor(actor)

  return { graph: wired, log, registries, actorId, persist: () => log.persist() }
}

/** An in-memory instance on a fixed clock, for a demo or a test that must be reproducible. */
export function composeDeterministic(startedAt = 0, options: ComposeOptions = {}): Episteme {
  return compose({ ...options, clock: createFixedClock(startedAt) })
}

/** A human actor with the given id, so callers do not each invent the shape. */
export function humanActor(id: ActorId, displayName = 'Learner', now = 0): Actor {
  return { id, kind: 'human', displayName, shareByDefault: false, createdAt: now }
}

/** An agent actor. Agents suggest; they never author a human's understanding. */
export function agentActor(id: ActorId, displayName = 'Scaffold', now = 0): Actor {
  return { id, kind: 'agent', displayName, shareByDefault: false, createdAt: now }
}
