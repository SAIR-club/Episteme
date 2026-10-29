import {
  NodeTypeRegistry,
  EdgeTypeRegistry,
  StateDimensionRegistry,
  TagNamespaceRegistry,
} from './registry.js'
import { GuardRegistry } from '../guards/index.js'
import type { MutationGuard, GuardGraphView } from '../guards/index.js'
import type {
  NodeTypeDefinition,
  EdgeTypeDefinition,
  StateDimensionDefinition,
  TagNamespaceDefinition,
} from './definitions.js'

/**
 * Every registry the graph needs, bundled.
 *
 * Bundled rather than passed individually so a caller cannot half-configure a graph
 * and end up with, say, node types registered but their dimensions missing. It also
 * gives the guard layer one object to read from, which is why this interface lives in
 * its own module instead of beside the registry classes: it depends on both, and
 * neither should depend on the other.
 */
export interface Registries {
  readonly nodeTypes: NodeTypeRegistry
  readonly edgeTypes: EdgeTypeRegistry
  readonly stateDimensions: StateDimensionRegistry
  readonly tagNamespaces: TagNamespaceRegistry
  readonly guards: GuardRegistry
}

export function createRegistries(): Registries {
  return {
    nodeTypes: new NodeTypeRegistry(),
    edgeTypes: new EdgeTypeRegistry(),
    stateDimensions: new StateDimensionRegistry(),
    tagNamespaces: new TagNamespaceRegistry(),
    guards: new GuardRegistry(),
  }
}

/**
 * What a domain extension contributes to Core.
 *
 * A pack is the only sanctioned way to add vocabulary — node types, edge types, state
 * dimensions, tag namespaces and guards — keeping domain-specific application semantics
 * out of Core while still letting them share one graph.
 */
export interface DomainPack {
  readonly name: string
  /** Called with the registries and the read view, so guards can capture what they need. */
  readonly initialize: (context: DomainPackContext) => void
}

export interface DomainPackContext {
  readonly registries: Registries
  /** Present when the pack is applied to a live graph; absent for schema-only use. */
  readonly graph?: GuardGraphView
}

/** Shorthand used by packs so their definitions stay declarative. */
export interface DomainPackDefinitions {
  readonly nodeTypes?: readonly NodeTypeDefinition[]
  readonly edgeTypes?: readonly EdgeTypeDefinition[]
  readonly stateDimensions?: readonly StateDimensionDefinition[]
  readonly tagNamespaces?: readonly TagNamespaceDefinition[]
  readonly guards?: readonly MutationGuard[]
}

/**
 * Builds a pack from declarative definitions.
 *
 * Packs that only add vocabulary need no imperative code, which keeps the common case
 * trivial and reserves `initialize` for packs that genuinely compute something.
 */
export function defineDomainPack(name: string, definitions: DomainPackDefinitions): DomainPack {
  return {
    name,
    initialize: ({ registries }) => {
      for (const definition of definitions.tagNamespaces ?? []) {
        registries.tagNamespaces.registerIfAbsent(definition)
      }
      for (const definition of definitions.stateDimensions ?? []) {
        registries.stateDimensions.registerIfAbsent(definition)
      }
      for (const definition of definitions.nodeTypes ?? []) {
        registries.nodeTypes.registerIfAbsent(definition)
      }
      for (const definition of definitions.edgeTypes ?? []) {
        registries.edgeTypes.registerIfAbsent(definition)
      }
      for (const guard of definitions.guards ?? []) {
        registries.guards.register(guard)
      }
    },
  }
}

/**
 * Applies packs in order.
 *
 * `registerIfAbsent` semantics let two packs that share a vocabulary (Learn and Forum
 * both use `Concept` and `Claim`) compose without a registration conflict.
 */
export function applyDomainPacks(packs: readonly DomainPack[], context: DomainPackContext): void {
  for (const pack of packs) {
    pack.initialize(context)
  }
}
