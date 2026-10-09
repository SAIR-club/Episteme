import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import type { EpochMillis } from '@episteme/core'

/**
 * Pending suggestions: what an agent proposed and a human has not yet decided.
 *
 * A suggestion is a **draft** in the sense of Draft → Thought → Reference (ADR 0008). Core refuses a
 * `suggested` state value at commit, so a proposal cannot live in the event log, and it must not live in the
 * graph either: the graph is what the learner's understanding is reduced from, and nothing an agent inferred
 * belongs there before a person accepts it. So drafts are kept here, beside the graph and outside it.
 *
 * Disposable by construction. Losing this file costs pending drafts, never understanding, and nothing in it
 * can corrupt the graph. Removing a draft is not a deletion of cognitive record, because the graph never saw
 * it. Only the graph's owner writes it, because it is opened only by a session that holds the graph's lock.
 */

/** What an agent can propose. Each kind becomes an ordinary, validated mutation only when a human accepts it. */
export type Proposal =
  /** A new claim, optionally about existing concepts or questions. */
  | {
      readonly kind: 'claim'
      readonly label: string
      /** Ids of the concepts or questions the claim is about. Accepting it links the claim to each. */
      readonly about?: readonly string[]
    }
  /**
   * A node of any registered type, such as one distilled from material (ADR 0009). Its properties are the
   * ones its type requires; accepting it records which suggestion and which words it came from.
   */
  | {
      readonly kind: 'node'
      readonly nodeType: string
      readonly label: string
      readonly properties?: Readonly<Record<string, unknown>>
    }
  /**
   * A connection with a registered edge type. Either end is an existing node id, or `cand:<suggestion id>`
   * for a node suggested alongside it, which must be accepted first.
   */
  | { readonly kind: 'link'; readonly from: string; readonly to: string; readonly relation: string }
  /**
   * A change on one state dimension of a node, for the human whose graph this is. The target may be
   * `cand:<suggestion id>`, as for a link.
   */
  | {
      readonly kind: 'state'
      readonly target: string
      readonly dimension: string
      readonly level: string
    }

/** Where a suggestion came from in learning material: the words it rests on (ADR 0009). */
export interface SuggestionOrigin {
  readonly sourceId: string
  readonly episodeId: string
  readonly span: { readonly start: number; readonly end: number }
  readonly excerpt: string
  readonly time?: { readonly from: number; readonly to: number }
  /** Who said those words, when they lie in one speaker's turn of a dialogue (ADR 0011). */
  readonly speaker?: string
}

/** How a proposal names a node suggested alongside it. */
export const SUGGESTED_NODE_PREFIX = 'cand:'

export interface Suggestion {
  readonly id: string
  readonly proposal: Proposal
  /** Why the agent proposes it. Required: a person cannot judge a suggestion that does not say why. */
  readonly rationale: string
  /** The agent actor that proposed it. Provenance, not authentication (ADR 0008). */
  readonly proposedBy: string
  readonly proposedAt: EpochMillis
  /** The words it was distilled from, when it came from material. */
  readonly origin?: SuggestionOrigin
  /** The client that asked for the distillation it came from. Provenance, not authority. */
  readonly requestedBy?: string
  /**
   * Whether the learner said it or it is a reading of what was said, for a distilled suggestion (ADR 0011).
   * Neither proves the learner has mastered anything.
   */
  readonly basis?: 'stated' | 'inferred'
}

/**
 * The version this build writes. Bump only together with a migration, as for the graph file.
 *
 * Version 2 added resolution records. A version 1 file holds only suggestions and reads unchanged.
 */
export const SUGGESTIONS_SCHEMA_VERSION = 2
const READABLE_VERSIONS: readonly number[] = [1, 2]

/**
 * A decision that has started committing and has not been settled: a write-ahead record.
 *
 * The graph and the drafts are two files, and no write covers both. So before a decision commits anything,
 * it records here what it is about to commit, under a stable operation id, with the ids of the nodes and
 * edges it will create chosen in advance. Once the graph is written, one write of this file removes the draft
 * and this record together. A crash in between leaves this record behind, and the graph itself then says
 * whether the decision landed: if it did, the draft is removed; if not, the record is dropped and the draft
 * waits to be decided again. Either way the decision lands once.
 */
export interface Resolution {
  readonly operationId: string
  readonly suggestionId: string
  readonly outcome: 'accepted' | 'modified'
  /** What the decision commits: the agent's proposal, or the human's modification of it. */
  readonly proposal: Proposal
  /** Ids chosen before committing, so the graph can be asked whether they are there. */
  readonly planned: { readonly nodeId?: string; readonly edgeIds: readonly string[] }
  readonly channel: string
}

type StoreRecord =
  | { readonly schemaVersion: number; readonly kind: 'suggestion'; readonly suggestion: Suggestion }
  | { readonly schemaVersion: number; readonly kind: 'resolution'; readonly resolution: Resolution }

/**
 * The drafts of one graph, in proposal order.
 *
 * In memory when given no path, which is what an in-memory session uses. Every change is written before the
 * call returns, so a draft the agent was told about is one the next session can show.
 */
export class SuggestionStore {
  readonly #filePath: string | undefined
  readonly #pending = new Map<string, Suggestion>()
  readonly #resolutions = new Map<string, Resolution>()
  #writeChain: Promise<void> = Promise.resolve()

  private constructor(filePath: string | undefined) {
    this.#filePath = filePath
  }

  /**
   * Reads the drafts kept at `filePath`, or starts an empty in-memory store.
   *
   * A missing file is no drafts. A line this build cannot read **throws** rather than being skipped, for the
   * same reason the graph file does: a silently dropped draft is a suggestion the learner never gets to see.
   */
  static async open(filePath?: string): Promise<SuggestionStore> {
    const store = new SuggestionStore(filePath)
    if (filePath === undefined) return store

    let contents: string
    try {
      contents = await readFile(filePath, 'utf8')
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return store
      throw error
    }

    for (const [index, raw] of contents.split('\n').entries()) {
      const line = raw.trim()
      if (line === '') continue
      const record = parseRecord(line, index + 1, filePath)
      if (record.kind === 'suggestion') store.#pending.set(record.suggestion.id, record.suggestion)
      else store.#resolutions.set(record.resolution.operationId, record.resolution)
    }
    return store
  }

  get filePath(): string | undefined {
    return this.#filePath
  }

  /** Every pending draft, oldest first. */
  list(): readonly Suggestion[] {
    return [...this.#pending.values()]
  }

  get(id: string): Suggestion | undefined {
    return this.#pending.get(id)
  }

  /**
   * Keeps a new draft and writes it.
   *
   * The id is random rather than counted. A counter restarts once every draft has been resolved, and an agent
   * still holding an old id would then refer to a different suggestion than it was told about.
   */
  async add(draft: Omit<Suggestion, 'id'>): Promise<Suggestion> {
    const suggestion: Suggestion = { id: `sug_${randomUUID()}`, ...draft }
    await this.#change((pending) => pending.set(suggestion.id, suggestion))
    return suggestion
  }

  /**
   * Keeps several drafts in one write, such as everything one distillation yields.
   *
   * Their ids are chosen before any is kept, so a draft may refer to another of the same batch: `refer`
   * receives the ids in order and returns the drafts to keep.
   */
  async addAll(
    count: number,
    refer: (ids: readonly string[]) => readonly Omit<Suggestion, 'id'>[],
  ): Promise<readonly Suggestion[]> {
    const ids = Array.from({ length: count }, () => `sug_${randomUUID()}`)
    const kept = refer(ids).map((draft, index): Suggestion => ({
      id: ids[index] ?? `sug_${randomUUID()}`,
      ...draft,
    }))
    if (kept.length > 0) {
      await this.#change((pending) => {
        for (const suggestion of kept) pending.set(suggestion.id, suggestion)
      })
    }
    return kept
  }

  /** Drops a draft that has been decided, and writes the change. Returns whether it was pending. */
  async remove(id: string): Promise<boolean> {
    if (!this.#pending.has(id)) return false
    await this.#change((pending) => pending.delete(id))
    return true
  }

  /** Decisions that started and were not settled, oldest first. Empty unless a write failed or the host died. */
  resolutions(): readonly Resolution[] {
    return [...this.#resolutions.values()]
  }

  /** The unsettled decision on a draft, if there is one. */
  resolutionOf(suggestionId: string): Resolution | undefined {
    return this.resolutions().find((resolution) => resolution.suggestionId === suggestionId)
  }

  /** Records, before anything is committed, what a decision is about to commit. */
  async begin(resolution: Resolution): Promise<void> {
    await this.#change((_, resolutions) => resolutions.set(resolution.operationId, resolution))
  }

  /** The decision landed: removes its draft and its record in one write. */
  async complete(operationId: string): Promise<void> {
    const resolution = this.#resolutions.get(operationId)
    if (resolution === undefined) return
    await this.#change((pending, resolutions) => {
      pending.delete(resolution.suggestionId)
      resolutions.delete(operationId)
    })
  }

  /** The decision did not land: drops its record and keeps the draft pending. */
  async abandon(operationId: string): Promise<void> {
    if (!this.#resolutions.has(operationId)) return
    await this.#change((_, resolutions) => resolutions.delete(operationId))
  }

  /**
   * Writes the store as `change` leaves it, and only then changes what this store holds in memory.
   *
   * One write at a time, so concurrent changes cannot interleave. Memory follows the disk rather than leading
   * it: when a write fails, the store still says what the file says. Otherwise a failed write would show a
   * draft as decided, or a decision as settled, that the next session would find otherwise, and an id planned
   * for an unsettled decision could be handed to something else in the meantime.
   */
  #change(
    change: (pending: Map<string, Suggestion>, resolutions: Map<string, Resolution>) => void,
  ): Promise<void> {
    const next = this.#writeChain.then(async () => {
      const pending = new Map(this.#pending)
      const resolutions = new Map(this.#resolutions)
      change(pending, resolutions)
      await this.#writeNow(pending, resolutions)
      replace(this.#pending, pending)
      replace(this.#resolutions, resolutions)
    })
    // The chain must survive a failed write without staying rejected, while the caller still sees the failure.
    this.#writeChain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  async #writeNow(
    pending: ReadonlyMap<string, Suggestion>,
    resolutions: ReadonlyMap<string, Resolution>,
  ): Promise<void> {
    if (this.#filePath === undefined) return
    const lines = [
      ...[...pending.values()].map((suggestion) =>
        JSON.stringify({
          schemaVersion: SUGGESTIONS_SCHEMA_VERSION,
          kind: 'suggestion',
          suggestion,
        } satisfies StoreRecord),
      ),
      ...[...resolutions.values()].map((resolution) =>
        JSON.stringify({
          schemaVersion: SUGGESTIONS_SCHEMA_VERSION,
          kind: 'resolution',
          resolution,
        } satisfies StoreRecord),
      ),
    ]
    const temporary = `${this.#filePath}.tmp`
    await writeFile(temporary, lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8')
    await rename(temporary, this.#filePath)
  }
}

function replace<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void {
  target.clear()
  for (const [key, value] of source) target.set(key, value)
}

function parseRecord(line: string, lineNumber: number, filePath: string): StoreRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    throw new Error(
      `suggestion on line ${lineNumber} of "${filePath}" is not valid JSON: ${(error as Error).message}`,
    )
  }
  const record = parsed as {
    schemaVersion?: unknown
    kind?: unknown
    suggestion?: Suggestion
    resolution?: Resolution
  } | null
  const version = record?.schemaVersion
  if (typeof version !== 'number' || !READABLE_VERSIONS.includes(version)) {
    throw new Error(
      `line ${lineNumber} of "${filePath}" is not a suggestions record this build reads (version ${READABLE_VERSIONS.join(' or ')})`,
    )
  }
  if (record?.kind === 'suggestion' && record.suggestion !== undefined) {
    return { schemaVersion: version, kind: 'suggestion', suggestion: record.suggestion }
  }
  if (version >= 2 && record?.kind === 'resolution' && record.resolution !== undefined) {
    return { schemaVersion: version, kind: 'resolution', resolution: record.resolution }
  }
  throw new Error(`line ${lineNumber} of "${filePath}" is neither a suggestion nor a resolution`)
}
