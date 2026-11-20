import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, openSync, rmSync, writeSync } from 'node:fs'
import { link, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { historyDigestOf } from '@episteme/epi-format'
import Database from 'better-sqlite3'
import { SERIALIZATION_SCHEMA_VERSION, deserializeRecord } from './records.js'
import { GraphLockedError, SQLITE_FORMAT_VERSION, openSqliteStorage } from './index.js'

/**
 * A whole graph as one file that can be read without this code and brought back into a new graph.
 *
 * Bodies stay the exact strings the graph wrote, because companion logs are not this package's to reparse, and what
 * comes back must be what went out. Everything in the graph is in here, private material and drafts included, and
 * no credentials: tokens live in the user file, never in the graph. Its file type is `.epi` (ADR 0022).
 */

export const GRAPH_EXPORT_FORMAT = 'episteme-graph-export'
export const GRAPH_EXPORT_VERSION = 1

/**
 * The file type a portable export is named by (ADR 0022). A name is only a convention for people and their
 * operating systems: identity is the `format` field above, so import reads any file and judges what is inside it.
 */
export const GRAPH_EXPORT_EXTENSION = '.epi'

export interface GraphExport {
  readonly format: typeof GRAPH_EXPORT_FORMAT
  readonly version: typeof GRAPH_EXPORT_VERSION
  readonly exportedAt: string
  /** What wrote it. The file's name only: where it sat on someone's disk does not travel. */
  readonly source: { readonly file: string; readonly build: string }
  readonly storedAs: { readonly sqliteFormat: number; readonly recordSchema: number }
  /**
   * Over `records` and `companions` as they are serialized here, so a damaged file is refused. Anyone editing the file
   * can recompute it, so it says nothing about who wrote the contents.
   */
  readonly sha256: string
  readonly counts: {
    readonly records: number
    readonly companions: Readonly<Record<string, number>>
  }
  readonly records: readonly string[]
  readonly companions: readonly {
    readonly name: string
    readonly seq: number
    readonly body: string
  }[]
}

/** What an export says about itself: everything but the records and companions it carries. */
export type GraphExportHead = Omit<GraphExport, 'records' | 'companions'>

/** How much an export gathers before writing it out. */
const WRITE_CHUNK = 1 << 20

export type GraphExportProblem =
  | 'no_graph'
  | 'target_exists'
  | 'not_an_export'
  | 'unsupported_version'
  | 'damaged'
  | 'no_publication'
  | 'ambiguous_publication'
  | 'withdrawn_publication'
  | 'unsafe_publication'

/** Export or import refused, with nothing written. */
export class GraphExportError extends Error {
  readonly code: GraphExportProblem

  constructor(code: GraphExportProblem, message: string) {
    super(message)
    this.name = 'GraphExportError'
    this.code = code
  }
}

/**
 * Reads the whole graph out of its file, under an exclusive hold, as a portable export object.
 *
 * This is `exportGraph` without the writing, so a v2 knowledge file can build on the same exclusive,
 * all-or-nothing read without passing through a temporary file.
 */
export function exportFromGraph(
  graph: string,
  options: { readonly build: string; readonly now?: () => Date },
): GraphExport {
  if (!existsSync(graph)) throw new GraphExportError('no_graph', `no graph at "${graph}"`)
  const db = new Database(graph, { timeout: 0, fileMustExist: true })
  let exported: GraphExport
  try {
    db.pragma('locking_mode = EXCLUSIVE')
    try {
      db.exec('BEGIN EXCLUSIVE')
    } catch (error) {
      if ((error as { code?: unknown }).code === 'SQLITE_BUSY') throw new GraphLockedError(graph)
      throw error
    }
    const sqliteFormat = db.pragma('user_version', { simple: true }) as number
    if (sqliteFormat !== SQLITE_FORMAT_VERSION) {
      throw new GraphExportError(
        'unsupported_version',
        `"${graph}" has format version ${sqliteFormat}; this build reads version ${SQLITE_FORMAT_VERSION}`,
      )
    }
    const records = (
      db.prepare('SELECT body FROM records ORDER BY seq').all() as { body: string }[]
    ).map((row) => row.body)
    const companions = db
      .prepare('SELECT name, seq, body FROM companions ORDER BY name, seq')
      .all() as { name: string; seq: number; body: string }[]
    db.exec('COMMIT')
    const counted: Record<string, number> = {}
    for (const { name } of companions) counted[name] = (counted[name] ?? 0) + 1
    exported = {
      format: GRAPH_EXPORT_FORMAT,
      version: GRAPH_EXPORT_VERSION,
      exportedAt: (options.now?.() ?? new Date()).toISOString(),
      source: { file: basename(graph), build: options.build },
      storedAs: { sqliteFormat, recordSchema: SERIALIZATION_SCHEMA_VERSION },
      sha256: historyDigestOf({ records, companions }),
      counts: { records: records.length, companions: counted },
      records,
      companions,
    }
  } finally {
    db.close()
  }
  return exported
}

/**
 * Publishes bytes at `target` under the rules a graph file must be written by: the content is staged
 * beside the target first, and linked into place only once the whole file exists. `link` refuses
 * atomically where a rename would replace, so a file that appeared in the meantime is never
 * overwritten, and a crash or a full disk leaves no partial file wearing the target's name — the
 * staging file is removed on every failure, and only a complete file is ever published.
 *
 * `0o600`: graph files hold private material, so only their owner reads them. Windows ignores the
 * mode and the file takes its folder's permissions. The staging name is unique to this call, so a
 * failed writer cleans up after itself and cannot remove another writer's staging file.
 */
export async function writeFileExclusively(bytes: string, target: string): Promise<void> {
  await writeStreamExclusively(target, (write) => write(bytes))
}

/**
 * The same staged publish as `writeFileExclusively`, one piece at a time: the producer writes into
 * the staging file, and only a complete file is linked into place.
 */
export async function writeStreamExclusively(
  target: string,
  produce: (write: (piece: string) => void) => void,
): Promise<void> {
  const staging = join(dirname(target), `${basename(target)}.${randomUUID()}.writing`)
  let file: number | undefined
  try {
    file = openSync(staging, 'wx', 0o600)
    const opened = file
    let pending = ''
    const flush = (): void => {
      if (pending !== '') writeSync(opened, pending, null, 'utf8')
      pending = ''
    }
    produce((piece) => {
      pending += piece
      if (pending.length >= WRITE_CHUNK) flush()
    })
    flush()
    closeSync(opened)
    file = undefined
    try {
      await link(staging, target)
    } catch (error) {
      if ((error as { code?: unknown }).code === 'EEXIST') {
        throw new GraphExportError(
          'target_exists',
          `"${target}" already exists; it was not replaced`,
        )
      }
      throw error
    }
  } finally {
    if (file !== undefined) closeSync(file)
    await rm(staging, { force: true })
  }
}

/**
 * Writes the graph to `target`. Refuses while anything holds the graph, because a copy of a graph in use could be a
 * state that never existed, and refuses to replace an existing file.
 *
 * Row by row, never the whole graph at once: one pass to count and checksum, one to write, both inside the same
 * exclusive transaction so they read the same graph. The file is byte for byte what serializing it whole would give,
 * which no single string could hold once a graph passes about half a gigabyte.
 */
export async function exportGraph(
  graph: string,
  target: string,
  options: { readonly build: string; readonly now?: () => Date },
): Promise<GraphExportHead> {
  if (!existsSync(graph)) throw new GraphExportError('no_graph', `no graph at "${graph}"`)
  const db = new Database(graph, { timeout: 0, fileMustExist: true })
  try {
    db.pragma('locking_mode = EXCLUSIVE')
    try {
      db.exec('BEGIN EXCLUSIVE')
    } catch (error) {
      if ((error as { code?: unknown }).code === 'SQLITE_BUSY') throw new GraphLockedError(graph)
      throw error
    }
    const sqliteFormat = db.pragma('user_version', { simple: true }) as number
    if (sqliteFormat !== SQLITE_FORMAT_VERSION) {
      throw new GraphExportError(
        'unsupported_version',
        `"${graph}" has format version ${sqliteFormat}; this build reads version ${SQLITE_FORMAT_VERSION}`,
      )
    }
    const records = db.prepare('SELECT body FROM records ORDER BY seq').pluck()
    const companions = db.prepare('SELECT name, seq, body FROM companions ORDER BY name, seq')
    /** The two arrays as `JSON.stringify` writes them, a piece at a time. */
    const each = (emit: (piece: string) => void): void => {
      let first = true
      for (const body of records.iterate() as IterableIterator<string>) {
        emit(`${first ? '' : ','}${JSON.stringify(body)}`)
        first = false
      }
      emit('],"companions":[')
      first = true
      for (const row of companions.iterate() as IterableIterator<{
        name: string
        seq: number
        body: string
      }>) {
        emit(
          `${first ? '' : ','}${JSON.stringify({ name: row.name, seq: row.seq, body: row.body })}`,
        )
        first = false
      }
    }

    const hash = createHash('sha256').update('{"records":[')
    each((piece) => hash.update(piece))
    hash.update(']}')
    const recordCount = db.prepare('SELECT count(*) FROM records').pluck().get() as number
    const counted: Record<string, number> = {}
    for (const { name, count } of db
      .prepare('SELECT name, count(*) AS count FROM companions GROUP BY name ORDER BY name')
      .all() as { name: string; count: number }[]) {
      counted[name] = count
    }
    const head: GraphExportHead = {
      format: GRAPH_EXPORT_FORMAT,
      version: GRAPH_EXPORT_VERSION,
      exportedAt: (options.now?.() ?? new Date()).toISOString(),
      source: { file: basename(graph), build: options.build },
      storedAs: { sqliteFormat, recordSchema: SERIALIZATION_SCHEMA_VERSION },
      sha256: hash.digest('hex'),
      counts: { records: recordCount, companions: counted },
    }

    // The same staged publish as a `.epi` file: a partial write never wears the graph's name.
    await writeStreamExclusively(target, (write) => {
      write(`${JSON.stringify(head).slice(0, -1)},"records":[`)
      each(write)
      write(']}')
    })
    db.exec('COMMIT')
    return head
  } finally {
    db.close()
  }
}

/** Reads and checks an export without touching any graph. */
export async function readGraphExport(file: string): Promise<GraphExport> {
  let parsed: Partial<GraphExport>
  try {
    parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<GraphExport>
  } catch {
    throw new GraphExportError('not_an_export', `"${file}" is not a graph export`)
  }
  if (
    parsed.format !== GRAPH_EXPORT_FORMAT ||
    !Array.isArray(parsed.records) ||
    !Array.isArray(parsed.companions)
  ) {
    throw new GraphExportError('not_an_export', `"${file}" is not a graph export`)
  }
  if (
    parsed.version !== GRAPH_EXPORT_VERSION ||
    parsed.storedAs?.sqliteFormat !== SQLITE_FORMAT_VERSION ||
    parsed.storedAs.recordSchema !== SERIALIZATION_SCHEMA_VERSION
  ) {
    throw new GraphExportError(
      'unsupported_version',
      `"${file}" was written in a format this build does not read`,
    )
  }
  if (historyDigestOf(parsed as Pick<GraphExport, 'records' | 'companions'>) !== parsed.sha256) {
    throw new GraphExportError('damaged', `"${file}" does not match its checksum`)
  }
  return parsed as GraphExport
}

/**
 * Brings an export back as a new graph at `target`, without reading a file: what `importGraph` does
 * after it has read, and what restoring the archive section of a v2 knowledge file calls directly.
 *
 * Only ever a new file: merging into a graph with its own history would be an irreversible rewrite of that history.
 * It is built beside the target and moved into place once it opens as a graph, so a failure leaves nothing at
 * `target`.
 */
export async function importFromExport(
  exported: GraphExport,
  target: string,
): Promise<GraphExport> {
  if (existsSync(target)) {
    throw new GraphExportError('target_exists', `"${target}" already exists; it was not replaced`)
  }
  exported.records.forEach((body, index) => {
    try {
      deserializeRecord(body, index + 1)
    } catch (error) {
      throw new GraphExportError(
        'damaged',
        `record ${index + 1} of the export cannot be read: ${(error as Error).message}`,
      )
    }
  })
  const building = join(dirname(target), `${basename(target)}.importing`)
  const clean = (): void => {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${building}${suffix}`, { force: true })
  }
  clean()
  try {
    // The storage lays the file out, so an import can never produce a layout a graph would not have.
    const laidOut = await openSqliteStorage(building)
    await laidOut.close()
    const db = new Database(building)
    try {
      const addRecord = db.prepare('INSERT INTO records (seq, body) VALUES (?, ?)')
      const addCompanion = db.prepare('INSERT INTO companions (name, seq, body) VALUES (?, ?, ?)')
      db.transaction(() => {
        exported.records.forEach((body, index) => addRecord.run(index + 1, body))
        for (const { name, seq, body } of exported.companions) addCompanion.run(name, seq, body)
      })()
      db.pragma('wal_checkpoint(TRUNCATE)')
    } finally {
      db.close()
    }
    const opened = await openSqliteStorage(building)
    await opened.close()
    await rename(building, target)
  } finally {
    clean()
  }
  return exported
}

/** Reads a portable export file and brings it back as a new graph at `target`. */
export async function importGraph(file: string, target: string): Promise<GraphExport> {
  return importFromExport(await readGraphExport(file), target)
}
