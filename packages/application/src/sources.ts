import { readFile, rename, writeFile } from 'node:fs/promises'
import type { EpochMillis } from '@episteme/core'

/**
 * Learning material that has been distilled, kept beside the graph and outside it (ADR 0009).
 *
 * Raw material is a draft: it never becomes a node. It is kept so that what a learner accepts can be traced
 * back to the words it came from, through the origin each suggestion and each accepted node carries. Only the
 * graph's owner writes this file, because only a session holding the graph's lock opens it.
 */

export interface SourceEpisode {
  readonly id: string
  readonly span: { readonly start: number; readonly end: number }
  readonly time?: { readonly from: number; readonly to: number }
}

export interface Source {
  readonly id: string
  readonly title: string
  readonly text: string
  readonly kind: 'dialogue' | 'prose'
  readonly episodes: readonly SourceEpisode[]
  readonly addedAt: EpochMillis
  /** The client that asked for this material to be distilled, when one did. Provenance, not authority. */
  readonly requestedBy?: string
}

export const SOURCES_SCHEMA_VERSION = 1

interface SourceRecord {
  readonly schemaVersion: number
  readonly kind: 'source'
  readonly source: Source
}

/** The material distilled into one graph's suggestions, oldest first. In memory when given no path. */
export class SourceStore {
  readonly #filePath: string | undefined
  readonly #sources = new Map<string, Source>()

  private constructor(filePath: string | undefined) {
    this.#filePath = filePath
  }

  /** Reads the sources kept at `filePath`. A line this build cannot read throws rather than being skipped. */
  static async open(filePath?: string): Promise<SourceStore> {
    const store = new SourceStore(filePath)
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
      const record = JSON.parse(line) as Partial<SourceRecord> | null
      if (
        record?.schemaVersion !== SOURCES_SCHEMA_VERSION ||
        record.kind !== 'source' ||
        record.source === undefined
      ) {
        throw new Error(
          `line ${index + 1} of "${filePath}" is not a version ${SOURCES_SCHEMA_VERSION} source record`,
        )
      }
      store.#sources.set(record.source.id, record.source)
    }
    return store
  }

  list(): readonly Source[] {
    return [...this.#sources.values()]
  }

  get(id: string): Source | undefined {
    return this.#sources.get(id)
  }

  /** Keeps a source and writes it before returning, so a suggestion's origin never points at nothing. */
  async add(source: Source): Promise<void> {
    // Written first and kept in memory only once written, so a failed write leaves no source that the next
    // session would not have.
    if (this.#filePath !== undefined) {
      const lines = [...this.list(), source].map((kept) =>
        JSON.stringify({
          schemaVersion: SOURCES_SCHEMA_VERSION,
          kind: 'source',
          source: kept,
        } satisfies SourceRecord),
      )
      const temporary = `${this.#filePath}.tmp`
      await writeFile(temporary, `${lines.join('\n')}\n`, 'utf8')
      await rename(temporary, this.#filePath)
    }
    this.#sources.set(source.id, source)
  }
}
