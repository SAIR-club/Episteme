import { asId } from '../ontology/ids.js'
import type { NodeTypeId, EdgeTypeId, DimensionId } from '../ontology/ids.js'
import type { DimensionKind, StateValue } from '../ontology/state.js'
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
 * dimensions, tag namespaces and guards — which is what keeps `Forum`, `Course` and
 * `Quiz` out of Core while still letting them share one graph.
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

/** Declarative JSON-friendly configuration interfaces for zero-code pluggable packs. */
export interface DeclarativeNodeTypeConfig {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly requiredProperties?: readonly string[]
  readonly defaultTier?: 'draft' | 'thought' | 'reference'
}

export interface DeclarativeEdgeTypeConfig {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly category: 'epistemic' | 'structural' | 'provenance' | 'identity'
  readonly from?: readonly string[]
  readonly to?: readonly string[]
}

export interface DeclarativeStateDimensionConfig {
  readonly id: string
  readonly label: string
  readonly kind: DimensionKind
  readonly levels?: readonly string[]
  readonly ordered?: boolean
  readonly values?: readonly StateValue[]
}

export interface DeclarativeTagNamespaceConfig {
  readonly namespace: string
  readonly label: string
  readonly description?: string
}

export interface DeclarativeOntologyConfig {
  readonly name: string
  readonly nodeTypes?: readonly DeclarativeNodeTypeConfig[]
  readonly edgeTypes?: readonly DeclarativeEdgeTypeConfig[]
  readonly stateDimensions?: readonly DeclarativeStateDimensionConfig[]
  readonly tagNamespaces?: readonly DeclarativeTagNamespaceConfig[]
}

/**
 * Creates a DomainPack from a declarative JSON-compatible configuration.
 * Plain string identifiers are branded to their respective ID types.
 */
export function definePackFromConfig(config: DeclarativeOntologyConfig): DomainPack {
  const definitions: DomainPackDefinitions = {
    ...(config.tagNamespaces !== undefined ? { tagNamespaces: config.tagNamespaces } : {}),
    ...(config.nodeTypes !== undefined
      ? {
          nodeTypes: config.nodeTypes.map((nt) => {
            const def: NodeTypeDefinition = {
              id: asId<NodeTypeId>(nt.id),
              label: nt.label,
              ...(nt.description !== undefined ? { description: nt.description } : {}),
              ...(nt.requiredProperties !== undefined
                ? { requiredProperties: nt.requiredProperties }
                : {}),
              ...(nt.defaultTier !== undefined ? { defaultTier: nt.defaultTier } : {}),
            }
            return def
          }),
        }
      : {}),
    ...(config.edgeTypes !== undefined
      ? {
          edgeTypes: config.edgeTypes.map((et) => {
            const def: EdgeTypeDefinition = {
              id: asId<EdgeTypeId>(et.id),
              label: et.label,
              category: et.category,
              ...(et.description !== undefined ? { description: et.description } : {}),
              ...(et.from !== undefined ? { from: et.from.map((f) => asId<NodeTypeId>(f)) } : {}),
              ...(et.to !== undefined ? { to: et.to.map((t) => asId<NodeTypeId>(t)) } : {}),
            }
            return def
          }),
        }
      : {}),
    ...(config.stateDimensions !== undefined
      ? {
          stateDimensions: config.stateDimensions.map((sd) => {
            const def: StateDimensionDefinition = {
              id: asId<DimensionId>(sd.id),
              label: sd.label,
              kind: sd.kind,
              ...(sd.levels !== undefined ? { levels: sd.levels } : {}),
              ...(sd.ordered !== undefined ? { ordered: sd.ordered } : {}),
              ...(sd.values !== undefined ? { values: sd.values } : {}),
            }
            return def
          }),
        }
      : {}),
  }
  return defineDomainPack(config.name, definitions)
}

/**
 * Parses a JSON string (or accepts a config object) and returns a ready-to-use DomainPack.
 */
export function loadPackFromJson(rawJsonOrConfig: string | DeclarativeOntologyConfig): DomainPack {
  const config =
    typeof rawJsonOrConfig === 'string'
      ? (JSON.parse(rawJsonOrConfig) as DeclarativeOntologyConfig)
      : rawJsonOrConfig
  return definePackFromConfig(config)
}
