import type { DimensionId, DomainPack, StateDimensionDefinition } from '@episteme/core'
import type { DistillationPolicy } from '@episteme/distillation'

/**
 * What a session is composed with for one scene: its vocabulary, how material is read into it, and what a person
 * may record by hand (ADR 0013, step M3).
 *
 * The application holds no scene of its own. Learn, a discussion scene or a test scene each supply one, so the
 * same use cases serve all of them over one graph.
 */
export interface SessionScene {
  /** A short name, for logs and for the service's `/state`. */
  readonly name: string
  /** The packs the graph is composed with, applied in order. */
  readonly packs: readonly DomainPack[]
  /** How `distill` reads material when the caller names no policy. */
  readonly distillationPolicy: DistillationPolicy
  /** The dimensions a person may set by hand, in the order they are offered. */
  readonly recordableDimensions: readonly RecordableDimension[]
}

/** A dimension a person can record, with the levels the scene's pack allows. */
export interface RecordableDimension {
  readonly id: DimensionId
  readonly label: string
  /** The same label in Simplified Chinese, shown first to the learner. */
  readonly labelZh: string
  readonly levels: readonly string[]
  /** Levels with their Chinese names, in the same order as `levels`. */
  readonly levelLabelsZh: readonly { readonly level: string; readonly label: string }[]
  readonly description: string
  readonly descriptionZh: string
}

/** What this surface adds to a registered dimension: its Chinese names and its prose. */
export interface DimensionPresentation {
  readonly id: DimensionId
  readonly labelZh: string
  /** The Chinese name of every current level, keyed by level token. */
  readonly levelLabelsZh: Readonly<Record<string, string>>
  readonly description: string
  readonly descriptionZh: string
}

/** The levels of a registered dimension that may be offered for new input: all of them but the legacy ones. */
function currentLevels(definition: StateDimensionDefinition): readonly string[] {
  const legacy = definition.legacyLevels ?? []
  return (definition.levels ?? []).filter((level) => !legacy.includes(level))
}

/**
 * Joins each presentation to the dimension it presents, in the order given.
 *
 * The levels come from the definitions, never from a presentation: Core refuses any level the pack did not
 * register, so a list kept beside it could only drift into offering buttons that fail. A dimension that is not
 * registered with levels, a current level without a Chinese name, or a name for a level that is not current,
 * throws when the scene is built rather than rendering a raw token or a dead button.
 */
export function recordableDimensions(
  definitions: readonly StateDimensionDefinition[],
  presentations: readonly DimensionPresentation[],
): readonly RecordableDimension[] {
  return presentations.map((presentation) => {
    const registered = definitions.find((candidate) => candidate.id === presentation.id)
    if (registered?.levels === undefined) {
      throw new Error(
        `dimension ${presentation.id} is not registered with levels by the scene's pack`,
      )
    }
    const levels = currentLevels(registered)
    const named = Object.keys(presentation.levelLabelsZh)
    const missing = levels.filter((level) => !named.includes(level))
    const extra = named.filter((level) => !levels.includes(level))
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `Chinese level names for ${presentation.id} do not match its current levels ` +
          `(missing: ${missing.join(', ') || '-'}; not current: ${extra.join(', ') || '-'})`,
      )
    }
    return {
      id: presentation.id,
      label: registered.label,
      labelZh: presentation.labelZh,
      levels,
      levelLabelsZh: levels.map((level) => ({ level, label: presentation.levelLabelsZh[level]! })),
      description: presentation.description,
      descriptionZh: presentation.descriptionZh,
    }
  })
}
