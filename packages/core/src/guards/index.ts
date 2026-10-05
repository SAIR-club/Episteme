import { EpistemeError, GuardRejection } from '../errors.js'
import type { Registries } from '../graph/registries.js'
import type { Actor } from '../ontology/actor.js'
import type { GraphEdge, GraphNode } from '../ontology/resources.js'
import type { StateAuthority, StateValue } from '../ontology/state.js'
import type { ActorId, DimensionId, EdgeId, EventId, NodeId } from '../ontology/ids.js'

/**
 * Every way the graph can change.
 *
 * Guards receive one of these instead of a stored entity, because a guard needs to
 * judge the *intent* ("this edge should exist") before it exists.
 */
export type GraphMutation =
  | { readonly kind: 'node.add'; readonly node: GraphNode }
  | { readonly kind: 'node.delete'; readonly nodeId: NodeId }
  | { readonly kind: 'edge.add'; readonly edge: GraphEdge }
  | { readonly kind: 'edge.delete'; readonly edgeId: EdgeId }
  | {
      readonly kind: 'state.commit'
      readonly eventId: EventId
      readonly target: NodeId
      readonly dimensions: ReadonlyMap<DimensionId, StateValue>
    }

/** Read-only view a guard may consult while judging a mutation. */
export interface GuardGraphView {
  getNode(id: NodeId | string): GraphNode | undefined
  getEdge(id: EdgeId | string): GraphEdge | undefined
  edgesOf(nodeId: NodeId | string): readonly GraphEdge[]
  /**
   * A registered actor, so a guard can tell a human from an agent.
   *
   * The actor registry belongs to the graph rather than to storage: storage persists
   * structure, while "who is allowed to stand behind this" is a graph-level fact.
   */
  getActor(id: ActorId | string): Actor | undefined
}

export interface GuardContext {
  readonly registries: Registries
  readonly graph: GuardGraphView
}

export type GuardVerdict =
  /** The rule is satisfied. */
  | { readonly ok: true }
  /** The rule refuses; the caller must surface this to the user, not silently drop it. */
  | {
      readonly ok: false
      readonly message: string
      readonly details?: Readonly<Record<string, unknown>>
    }

export interface MutationGuard {
  readonly name: string
  /** Mutations this guard claims to judge; others never reach it. */
  readonly appliesTo: readonly GraphMutation['kind'][]
  /** One-line explanation, shown when the user inspects a rejection. */
  readonly description?: string
  check(mutation: GraphMutation, context: GuardContext): GuardVerdict
}

/**
 * Domain rules that must hold before a mutation is applied.
 *
 * Guards are registered data rather than hard-coded branches, so a domain extension
 * adds constraints without Core learning anything about that domain.
 */
export class GuardRegistry {
  readonly #guards: MutationGuard[] = []

  register(guard: MutationGuard): MutationGuard {
    if (this.#guards.some((existing) => existing.name === guard.name)) {
      throw new EpistemeError(
        'duplicate_registration',
        `guard "${guard.name}" is already registered`,
      )
    }
    this.#guards.push(guard)
    return guard
  }

  list(): readonly MutationGuard[] {
    return [...this.#guards]
  }

  /** Guards that opted into this mutation kind, in registration order. */
  forKind(kind: GraphMutation['kind']): readonly MutationGuard[] {
    return this.#guards.filter((guard) => guard.appliesTo.includes(kind))
  }
}

export const ok: GuardVerdict = { ok: true }

export function reject(message: string, details?: Readonly<Record<string, unknown>>): GuardVerdict {
  return details === undefined ? { ok: false, message } : { ok: false, message, details }
}

/**
 * The single authoritative validation path for graph mutation.
 *
 * Structural integrity is checked first — registered types, existing endpoints,
 * declared properties, legal dimension values — and then registered guards run.
 * Because the graph layer calls this for every change, no code path can write an
 * unregistered type or skip a domain rule.
 */
export function validateMutation(mutation: GraphMutation, context: GuardContext): void {
  validateStructure(mutation, context)
  runGuards(mutation, context)
}

/** Shape and referential validation, independent of any registered guard. */
export function validateStructure(mutation: GraphMutation, context: GuardContext): void {
  const { registries, graph } = context

  switch (mutation.kind) {
    case 'node.add': {
      // An id names one node for good. Adding over an existing one would replace it in place, losing the
      // node it named from the graph without a revocation; a revoked node's id stays taken for the same reason.
      if (graph.getNode(mutation.node.id) !== undefined) {
        throw new EpistemeError(
          'duplicate_id',
          `a node with id "${mutation.node.id}" already exists`,
        )
      }
      const definition = registries.nodeTypes.require(mutation.node.type)
      assertProperties(mutation.node, definition.requiredProperties ?? [])
      for (const tag of mutation.node.tags) {
        registries.tagNamespaces.validate(tag)
      }
      return
    }

    case 'node.delete': {
      if (graph.getNode(mutation.nodeId) === undefined) {
        throw new EpistemeError('unknown_node', `cannot delete unknown node "${mutation.nodeId}"`)
      }
      return
    }

    case 'edge.add': {
      if (graph.getEdge(mutation.edge.id) !== undefined) {
        throw new EpistemeError(
          'duplicate_id',
          `an edge with id "${mutation.edge.id}" already exists`,
        )
      }
      const definition = registries.edgeTypes.require(mutation.edge.type)
      const from = graph.getNode(mutation.edge.from)
      if (from === undefined) {
        throw new EpistemeError(
          'invalid_edge_endpoint',
          `edge source "${mutation.edge.from}" does not exist`,
        )
      }
      const to = graph.getNode(mutation.edge.to)
      if (to === undefined) {
        throw new EpistemeError(
          'invalid_edge_endpoint',
          `edge target "${mutation.edge.to}" does not exist`,
        )
      }
      if (definition.from !== undefined && !definition.from.includes(from.type)) {
        throw new EpistemeError(
          'invalid_edge_endpoint',
          `edge type "${definition.id}" does not accept source type "${from.type}"`,
        )
      }
      if (definition.to !== undefined && !definition.to.includes(to.type)) {
        throw new EpistemeError(
          'invalid_edge_endpoint',
          `edge type "${definition.id}" does not accept target type "${to.type}"`,
        )
      }
      return
    }

    case 'edge.delete': {
      if (graph.getEdge(mutation.edgeId) === undefined) {
        throw new EpistemeError('unknown_edge', `cannot delete unknown edge "${mutation.edgeId}"`)
      }
      return
    }

    case 'state.commit': {
      if (graph.getNode(mutation.target) === undefined) {
        throw new EpistemeError(
          'unknown_node',
          `cannot record state for unknown node "${mutation.target}"`,
        )
      }
      if (mutation.dimensions.size === 0) {
        throw new EpistemeError(
          'invalid_dimension_value',
          'a state event must record at least one dimension change',
        )
      }
      for (const [dimensionId, value] of mutation.dimensions) {
        assertValueShape(dimensionId, value, registries)
        assertHumanOwnsTheValue(dimensionId, value, graph)
      }
      return
    }
  }
}

/**
 * The AI-ownership rule: an agent may suggest, but may never author a human's state.
 *
 * This is structural rather than an opt-in guard because it is the project's central
 * principle — "AI is a cognitive scaffold, not the author of the user's thinking" — and a
 * pack that simply forgot to register it would be a back door. Three cases:
 *
 * - `author` (default) — the person is asserting their own understanding. Allowed.
 * - `suggested` — an inference. Refused: it must be accepted by a human first, which
 *   re-commits it as `confirmed`.
 * - `confirmed` — an accepted suggestion, so `confirmedBy` must name a registered human.
 *
 * The rule deliberately does not check who *wrote* the event. A human accepting an agent's
 * suggestion commits under their own actor id, and that is the only path by which an
 * inferred value is allowed to exist.
 */
function assertHumanOwnsTheValue(
  dimensionId: DimensionId,
  value: StateValue,
  graph: GuardGraphView,
): void {
  const authority: StateAuthority = value.authority ?? 'author'

  if (authority === 'author') return

  if (authority === 'suggested') {
    throw new GuardRejection(
      'core/ai-cannot-author-state',
      `dimension "${dimensionId}" is only suggested; an agent's inference must be confirmed by a human before it becomes cognitive state`,
      { dimension: dimensionId, authority },
    )
  }

  const confirmedBy = value.confirmedBy
  if (confirmedBy === undefined) {
    throw new GuardRejection(
      'core/ai-cannot-author-state',
      `dimension "${dimensionId}" is marked confirmed but names no confirming human`,
      { dimension: dimensionId, authority },
    )
  }

  const actor = graph.getActor(confirmedBy)
  if (actor === undefined) {
    throw new GuardRejection(
      'core/ai-cannot-author-state',
      `dimension "${dimensionId}" was confirmed by unregistered actor "${confirmedBy}"`,
      { dimension: dimensionId, authority, confirmedBy },
    )
  }
  if (actor.kind !== 'human') {
    throw new GuardRejection(
      'core/ai-cannot-author-state',
      `dimension "${dimensionId}" was confirmed by "${confirmedBy}", which is a ${actor.kind} actor; only a human can accept a suggested state`,
      { dimension: dimensionId, authority, confirmedBy, kind: actor.kind },
    )
  }
}

/** Per-kind value validation, so the state model's rules have one definition. */
function assertValueShape(
  dimensionId: DimensionId,
  value: StateValue,
  registries: Registries,
): void {
  const definition = registries.stateDimensions.require(dimensionId)
  switch (definition.kind) {
    case 'ordinal':
    case 'categorical': {
      if (value.level === undefined) {
        throw new EpistemeError(
          'invalid_dimension_value',
          `dimension "${dimensionId}" requires a level`,
        )
      }
      const levels = definition.levels ?? []
      if (levels.length > 0 && !levels.includes(value.level)) {
        throw new EpistemeError(
          'invalid_dimension_value',
          `level "${value.level}" is not valid for dimension "${dimensionId}" (expected one of ${levels.join(', ')})`,
        )
      }
      return
    }
    case 'boolean': {
      if (value.level !== 'true' && value.level !== 'false') {
        throw new EpistemeError(
          'invalid_dimension_value',
          `dimension "${dimensionId}" requires the level "true" or "false"`,
        )
      }
      return
    }
    case 'scalar': {
      if (typeof value.scalar !== 'number' || Number.isNaN(value.scalar)) {
        throw new EpistemeError(
          'invalid_dimension_value',
          `dimension "${dimensionId}" requires a numeric scalar`,
        )
      }
      return
    }
  }
}

/** Runs each applicable guard and throws the first refusal it produces. */
export function runGuards(mutation: GraphMutation, context: GuardContext): void {
  for (const guard of context.registries.guards.forKind(mutation.kind)) {
    const verdict = guard.check(mutation, context)
    if (!verdict.ok) {
      throw new GuardRejection(guard.name, verdict.message, verdict.details ?? {})
    }
  }
}

function assertProperties(node: GraphNode, required: readonly string[]): void {
  for (const key of required) {
    const value = node.properties[key]
    if (value === undefined) {
      throw new EpistemeError(
        'missing_property',
        `node type "${node.type}" requires property "${key}"`,
      )
    }
  }
}
