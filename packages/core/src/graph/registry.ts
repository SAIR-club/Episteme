import { EpistemeError } from '../errors.js'
import type {
  NodeTypeDefinition,
  EdgeTypeDefinition,
  StateDimensionDefinition,
  TagNamespaceDefinition,
} from './definitions.js'
import type { DimensionId } from '../ontology/ids.js'

/**
 * A registry keyed by registered id.
 *
 * Registration is the *only* way a type becomes legal, and re-registration is an
 * error rather than an overwrite: silently swapping a definition would invalidate
 * every node already stored under it.
 */
class Registry<TDefinition extends { readonly id: string }> {
  readonly #definitions = new Map<string, TDefinition>()
  readonly #label: string

  constructor(label: string) {
    this.#label = label
  }

  get size(): number {
    return this.#definitions.size
  }

  register(definition: TDefinition): TDefinition {
    if (this.#definitions.has(definition.id)) {
      throw new EpistemeError(
        'duplicate_registration',
        `${this.#label} "${definition.id}" is already registered`,
      )
    }
    this.#definitions.set(definition.id, Object.freeze(definition))
    return definition
  }

  /** Registers unless already present; the idempotent form for pack composition. */
  registerIfAbsent(definition: TDefinition): TDefinition {
    const existing = this.#definitions.get(definition.id)
    if (existing !== undefined) return existing
    return this.register(definition)
  }

  has(id: string): boolean {
    return this.#definitions.has(id)
  }

  /** The definition, or `undefined`. Callers that require it must throw explicitly. */
  find(id: string): TDefinition | undefined {
    return this.#definitions.get(id)
  }

  /** The definition, or an `unregistered_*` error naming the offending id. */
  require(id: string, code: 'unregistered_node_type' | 'unregistered_edge_type'): TDefinition {
    const definition = this.#definitions.get(id)
    if (definition === undefined) {
      throw new EpistemeError(code, `${this.#label} "${id}" is not registered`)
    }
    return definition
  }

  list(): readonly TDefinition[] {
    return [...this.#definitions.values()]
  }

  ids(): readonly string[] {
    return [...this.#definitions.keys()]
  }
}

export class NodeTypeRegistry {
  readonly #registry = new Registry<NodeTypeDefinition>('node type')

  register(definition: NodeTypeDefinition): NodeTypeDefinition {
    return this.#registry.register(definition)
  }

  registerIfAbsent(definition: NodeTypeDefinition): NodeTypeDefinition {
    return this.#registry.registerIfAbsent(definition)
  }

  has(id: string): boolean {
    return this.#registry.has(id)
  }

  find(id: string): NodeTypeDefinition | undefined {
    return this.#registry.find(id)
  }

  /** Throws unless the node type is registered. */
  require(id: string): NodeTypeDefinition {
    return this.#registry.require(id, 'unregistered_node_type')
  }

  list(): readonly NodeTypeDefinition[] {
    return this.#registry.list()
  }
}

export class EdgeTypeRegistry {
  readonly #registry = new Registry<EdgeTypeDefinition>('edge type')

  register(definition: EdgeTypeDefinition): EdgeTypeDefinition {
    return this.#registry.register(definition)
  }

  registerIfAbsent(definition: EdgeTypeDefinition): EdgeTypeDefinition {
    return this.#registry.registerIfAbsent(definition)
  }

  has(id: string): boolean {
    return this.#registry.has(id)
  }

  find(id: string): EdgeTypeDefinition | undefined {
    return this.#registry.find(id)
  }

  /** Throws unless the edge type is registered. */
  require(id: string): EdgeTypeDefinition {
    return this.#registry.require(id, 'unregistered_edge_type')
  }

  list(): readonly EdgeTypeDefinition[] {
    return this.#registry.list()
  }
}

/** A legacy level must be a level: otherwise it would mark as read-only a token no event can carry. */
function assertLegacyLevelsRegistered(definition: StateDimensionDefinition): void {
  const unknown = (definition.legacyLevels ?? []).filter(
    (level) => !(definition.levels ?? []).includes(level),
  )
  if (unknown.length > 0) {
    throw new EpistemeError(
      'invalid_definition',
      `state dimension "${definition.id}" marks ${unknown.join(', ')} as legacy, which are not among its levels`,
    )
  }
}

/**
 * Registered axes of understanding.
 *
 * Registration is what lets a StateEvent be validated without Core knowing any
 * domain vocabulary, and it is also how a Learner View discovers which axes to show.
 */
export class StateDimensionRegistry {
  readonly #registry = new Registry<StateDimensionDefinition>('state dimension')

  register(definition: StateDimensionDefinition): StateDimensionDefinition {
    assertLegacyLevelsRegistered(definition)
    return this.#registry.register(definition)
  }

  registerIfAbsent(definition: StateDimensionDefinition): StateDimensionDefinition {
    if (!this.#registry.has(definition.id)) assertLegacyLevelsRegistered(definition)
    return this.#registry.registerIfAbsent(definition)
  }

  has(id: string): boolean {
    return this.#registry.has(id)
  }

  find(id: string): StateDimensionDefinition | undefined {
    return this.#registry.find(id)
  }

  /** Throws unless the dimension is registered. */
  require(id: DimensionId | string): StateDimensionDefinition {
    const definition = this.#registry.find(id)
    if (definition === undefined) {
      throw new EpistemeError('unregistered_dimension', `state dimension "${id}" is not registered`)
    }
    return definition
  }

  list(): readonly StateDimensionDefinition[] {
    return this.#registry.list()
  }
}

/**
 * Tag namespaces.
 *
 * Namespaces keep unrelated vocabularies from colliding: `state:verified` and
 * `scene:learn` only coexist because both namespaces are registered.
 */
export class TagNamespaceRegistry {
  readonly #namespaces = new Map<string, TagNamespaceDefinition>()

  register(definition: TagNamespaceDefinition): TagNamespaceDefinition {
    if (this.#namespaces.has(definition.namespace)) {
      throw new EpistemeError(
        'duplicate_registration',
        `tag namespace "${definition.namespace}" is already registered`,
      )
    }
    this.#namespaces.set(definition.namespace, Object.freeze(definition))
    return definition
  }

  registerIfAbsent(definition: TagNamespaceDefinition): TagNamespaceDefinition {
    const existing = this.#namespaces.get(definition.namespace)
    if (existing !== undefined) return existing
    return this.register(definition)
  }

  has(namespace: string): boolean {
    return this.#namespaces.has(namespace)
  }

  find(namespace: string): TagNamespaceDefinition | undefined {
    return this.#namespaces.get(namespace)
  }

  list(): readonly TagNamespaceDefinition[] {
    return [...this.#namespaces.values()]
  }

  /**
   * Splits `scene:learn` into its namespace and value.
   *
   * A tag with no separator has no namespace; callers decide whether that is legal.
   */
  split(tag: string): { namespace: string | undefined; value: string } {
    const index = tag.indexOf(':')
    if (index < 0) return { namespace: undefined, value: tag }
    return { namespace: tag.slice(0, index), value: tag.slice(index + 1) }
  }

  /** Throws unless the tag's namespace is registered. */
  validate(tag: string): void {
    const { namespace } = this.split(tag)
    if (namespace === undefined) {
      throw new EpistemeError(
        'unregistered_tag_namespace',
        `tag "${tag}" has no namespace; register the namespace first`,
      )
    }
    if (!this.#namespaces.has(namespace)) {
      throw new EpistemeError(
        'unregistered_tag_namespace',
        `tag namespace "${namespace}" is not registered (tag: "${tag}")`,
      )
    }
  }
}
