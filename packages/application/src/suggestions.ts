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
  /** A connection between two existing nodes, with a registered edge type. */
  | { readonly kind: 'link'; readonly from: string; readonly to: string; readonly relation: string }
  /** A change on one state dimension of an existing node, for the human whose graph this is. */
  | {
      readonly kind: 'state'
      readonly target: string
      readonly dimension: string
      readonly level: string
    }

export interface Suggestion {
  readonly id: string
  readonly proposal: Proposal
  /** Why the agent proposes it. Required: a person cannot judge a suggestion that does not say why. */
  readonly rationale: string
  /** The agent actor that proposed it. Provenance, not authentication (ADR 0008). */
  readonly proposedBy: string
  readonly proposedAt: EpochMillis
}

/** Bump only together with a migration, as for the graph file. */
export const SUGGESTIONS_SCHEMA_VERSION = 1

interface SuggestionRecord {
  readonly schemaVersion: number
  readonly kind: 'suggestion'
  readonly suggestion: Suggestion
}

/**
 * The drafts of one graph, in proposal order.
 *
 * In memory when given no path, which is what an in-memory session uses. Every change is written before the
 * call returns, so a draft the agent was told about is one the next session can show.
 */
export class SuggestionStore {
  readonly #filePath: string | undefined
  readonly #pending = new Map<string, Suggestion>()
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
      const suggestion = parseRecord(line, index + 1, filePath)
      store.#pending.set(suggestion.id, suggestion)
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
    this.#pending.set(suggestion.id, suggestion)
    await this.#write()
    return suggestion
  }

  /** Drops a draft that has been decided, and writes the change. Returns whether it was pending. */
  async remove(id: string): Promise<boolean> {
    const removed = this.#pending.delete(id)
    if (removed) await this.#write()
    return removed
  }

  /** Writes the whole file atomically, one write at a time, so concurrent changes cannot interleave. */
  #write(): Promise<void> {
    const next = this.#writeChain.then(() => this.#writeNow())
    // The chain must survive a failed write without staying rejected, while the caller still sees the failure.
    this.#writeChain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  async #writeNow(): Promise<void> {
    if (this.#filePath === undefined) return
    const lines = this.list().map((suggestion) =>
      JSON.stringify({
        schemaVersion: SUGGESTIONS_SCHEMA_VERSION,
        kind: 'suggestion',
        suggestion,
      } satisfies SuggestionRecord),
    )
    const temporary = `${this.#filePath}.tmp`
    await writeFile(temporary, lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8')
    await rename(temporary, this.#filePath)
  }
}

function parseRecord(line: string, lineNumber: number, filePath: string): Suggestion {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    throw new Error(
      `suggestion on line ${lineNumber} of "${filePath}" is not valid JSON: ${(error as Error).message}`,
    )
  }
  const record = parsed as Partial<SuggestionRecord> | null
  if (record?.schemaVersion !== SUGGESTIONS_SCHEMA_VERSION || record.kind !== 'suggestion') {
    throw new Error(
      `suggestion on line ${lineNumber} of "${filePath}" is not a version ${SUGGESTIONS_SCHEMA_VERSION} suggestion record`,
    )
  }
  if (record.suggestion === undefined) {
    throw new Error(`suggestion on line ${lineNumber} of "${filePath}" has no suggestion`)
  }
  return record.suggestion
}
