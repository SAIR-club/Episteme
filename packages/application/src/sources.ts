import { ownerOf } from './suggestions.js'
import { createHash } from 'node:crypto'
import type { EpochMillis } from '@episteme/core'
import type { CompanionLog } from '@episteme/storage-sqlite'
import { canonicalText } from '@episteme/distillation'

/**
 * Learning material that has been distilled, kept beside the graph and outside it (ADR 0009).
 *
 * Raw material is a draft: it never becomes a node. It is kept so that what a learner accepts can be traced
 * back to the words it came from, through the origin each suggestion and each accepted node carries. Only the
 * graph's owner writes it, because it is kept in the graph's own database, on the owner's connection.
 */

export interface SourceEpisode {
  readonly id: string
  readonly span: { readonly start: number; readonly end: number }
  readonly time?: { readonly from: number; readonly to: number }
}

/** Who read the material: Episteme's own reader, or a host's model (ADR 0011). */
export type SourceReader = 'episteme' | 'host'

/**
 * A keyed submission that stored this source, remembered so that a retry is answered, not repeated
 * (ADR 0011 §5). Its scope is the submitting agent and its `submissionId`.
 */
export interface SourceSubmission {
  /** The agent actor that submitted it. Provenance, not authentication. */
  readonly by: string
  readonly id: string
  /** Digest of the whole canonical payload, so a different request under the same id is never a retry. */
  readonly payloadDigest: string
  readonly at: EpochMillis
  /** What the submission came to when it was made, under the names the submitter used. */
  readonly receipt: {
    readonly kept: readonly { readonly ref: string; readonly suggestionId: string }[]
    readonly refused: readonly { readonly ref: string; readonly code: string }[]
  }
}

export interface Source {
  readonly id: string
  /** The person it was distilled for; see `ownerOf`. Material is private to them. */
  readonly owner?: string
  readonly title: string
  /** Canonical (`canonicalText`) for anything stored since ADR 0011; every span points into it. */
  readonly text: string
  readonly kind: 'dialogue' | 'prose'
  readonly episodes: readonly SourceEpisode[]
  readonly addedAt: EpochMillis
  /** The client that asked for this material to be distilled, when one did. Provenance, not authority. */
  readonly requestedBy?: string
  readonly reader: SourceReader
  /** Digest of `text`, so the same words sent again reuse this source. */
  readonly digest: string
  /** The host's own identifier for the conversation, when it gave one. Opaque, provenance only. */
  readonly hostSession?: string
  readonly submissions?: readonly SourceSubmission[]
  /** The thread and turns the material was built from (ADR 0015, decision 5). */
  readonly thread?: { readonly id: string; readonly turns: readonly string[] }
}

/**
 * Version 2 added `reader`, `digest`, `hostSession` and `submissions`. A version 1 record reads as Episteme's
 * reader with the digest of its text, and is written back as version 2.
 */
export const SOURCES_SCHEMA_VERSION = 2
const READABLE_VERSIONS: readonly number[] = [1, 2]

interface SourceRecord {
  readonly schemaVersion: number
  readonly kind: 'source'
  readonly source: Source
}

/** The digest of a text as a source stores it. */
export function textDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * The digest of a submission's whole payload (ADR 0011 §5).
 *
 * Every string is put in canonical form, object keys are sorted, an absent field is left out (so it differs from
 * an empty one), and lists keep their order (so reordered candidates are a different payload).
 */
export function payloadDigest(payload: {
  readonly text: string
  readonly title?: string
  readonly learner?: string
  readonly hostSession?: string
  readonly candidates: readonly unknown[]
}): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalValue(payload)), 'utf8')
    .digest('hex')
}

function canonicalValue(value: unknown): unknown {
  if (typeof value === 'string') return canonicalText(value)
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, field]) => field !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return Object.fromEntries(entries.map(([key, field]) => [key, canonicalValue(field)]))
  }
  return value
}

/** The material distilled into one graph's suggestions, oldest first. In memory when given no path. */
export class SourceStore {
  readonly #log: CompanionLog | undefined
  readonly #sources = new Map<string, Source>()

  private constructor(log: CompanionLog | undefined) {
    this.#log = log
  }

  /** Reads the sources kept in `log`. A record this build cannot read throws rather than being skipped. */
  static async open(log?: CompanionLog): Promise<SourceStore> {
    const store = new SourceStore(log)
    if (log === undefined) return store
    for (const [index, body] of (await log.read()).entries()) {
      const record = JSON.parse(body) as Partial<SourceRecord> | null
      if (
        typeof record?.schemaVersion !== 'number' ||
        !READABLE_VERSIONS.includes(record.schemaVersion) ||
        record.kind !== 'source' ||
        record.source === undefined
      ) {
        throw new Error(
          `record ${index + 1} of "${log.location}" is not a source record this build reads (version ${READABLE_VERSIONS.join(' or ')})`,
        )
      }
      const source = record.source as Partial<Source> & Omit<Source, 'reader' | 'digest'>
      store.#sources.set(source.id, {
        ...source,
        reader: source.reader ?? 'episteme',
        digest: source.digest ?? textDigest(source.text),
      })
    }
    return store
  }

  list(): readonly Source[] {
    return [...this.#sources.values()]
  }

  get(id: string): Source | undefined {
    return this.#sources.get(id)
  }

  /**
   * The source a keyed submission stored, with that submission, when there is one. A submission is complete
   * only once its drafts' landing record exists among the drafts; until then it is a record of an attempt.
   */
  submission(
    owner: string,
    by: string,
    id: string,
  ): { readonly source: Source; readonly submission: SourceSubmission } | undefined {
    for (const source of this.#sources.values()) {
      if (ownerOf(source) !== owner) continue
      const submission = source.submissions?.find((entry) => entry.by === by && entry.id === id)
      if (submission !== undefined) return { source, submission }
    }
    return undefined
  }

  /** A source holding exactly this text, read by the same reader in the same host conversation, if any. */
  reusable(
    owner: string,
    text: string,
    reader: SourceReader,
    hostSession: string | undefined,
  ): Source | undefined {
    const digest = textDigest(text)
    return [...this.#sources.values()].find(
      (source) =>
        ownerOf(source) === owner &&
        source.digest === digest &&
        source.text === text &&
        source.reader === reader &&
        source.hostSession === hostSession,
    )
  }

  /**
   * Keeps a source, new or replacing the one with its id, and writes it before returning, so a suggestion's
   * origin never points at nothing.
   */
  async put(source: Source): Promise<void> {
    // Written first and kept in memory only once written, so a failed write leaves no source that the next
    // session would not have.
    const next = new Map(this.#sources)
    next.set(source.id, source)
    if (this.#log !== undefined) {
      const lines = [...next.values()].map((kept) =>
        JSON.stringify({
          schemaVersion: SOURCES_SCHEMA_VERSION,
          kind: 'source',
          source: kept,
        } satisfies SourceRecord),
      )
      await this.#log.replace(lines)
    }
    this.#sources.set(source.id, source)
  }
}
