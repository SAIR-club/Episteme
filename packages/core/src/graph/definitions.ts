import type { NodeTypeId, EdgeTypeId, DimensionId } from '../ontology/ids.js'
import type { DimensionKind, StateValue } from '../ontology/state.js'

/**
 * A registered node type.
 *
 * Types must be registered before use: business code is not allowed to invent node
 * type strings on the fly, because an unregistered type is invisible to validation,
 * projection and every future migration.
 */
export interface NodeTypeDefinition {
  readonly id: NodeTypeId
  readonly label: string
  readonly description?: string
  /**
   * Property keys every instance must provide.
   *
   * v0 validates presence, not shape — a deliberately replaceable choice recorded in
   * ADR 0001 (see `docs/decisions/0001-core-boundary.md`). A schema library can be
   * plugged in later behind this same definition without touching Core call sites.
   */
  readonly requiredProperties?: readonly string[]
  /** Whether nodes of this type participate in the cognitive graph by default. */
  readonly defaultTier?: 'draft' | 'thought' | 'reference'
}

/**
 * A registered edge type.
 *
 * `category` exists because traversal and projection need to reason about what a
 * relation *means* in aggregate — e.g. "follow the refinement chain" — without
 * Core hard-coding the list of relation names.
 */
export type EdgeCategory = 'epistemic' | 'structural' | 'provenance' | 'identity'

export interface EdgeTypeDefinition {
  readonly id: EdgeTypeId
  readonly label: string
  readonly description?: string
  readonly category: EdgeCategory
  /** Node types allowed at the source. Absent means: any registered node type. */
  readonly from?: readonly NodeTypeId[]
  /** Node types allowed at the target. Absent means: any registered node type. */
  readonly to?: readonly NodeTypeId[]
}

/** A registered axis of understanding. */
export interface StateDimensionDefinition {
  readonly id: DimensionId
  readonly label: string
  readonly kind: DimensionKind
  /** Legal `level` tokens, for `ordinal` and `categorical` dimensions. */
  readonly levels?: readonly string[]
  /**
   * Levels kept only so that events already written with them stay valid and reduce as before. Each is one of
   * `levels`. A surface reads and shows them, but never offers them for new input.
   */
  readonly legacyLevels?: readonly string[]
  /** Only set when the levels are ordered; enables direction-aware comparison. */
  readonly ordered?: boolean
  /** Every event touching this dimension must carry a `level` from `levels`. */
  readonly values?: readonly StateValue[]
}

/** A registered tag namespace, e.g. `scene`, `topic`, `state`. */
export interface TagNamespaceDefinition {
  readonly namespace: string
  readonly label: string
  readonly description?: string
}
