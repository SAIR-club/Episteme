import { createHash } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { SERIALIZATION_SCHEMA_VERSION, deserializeRecord } from './records.js'
import { GraphLockedError, SQLITE_FORMAT_VERSION, openSqliteStorage } from './index.js'

/**
 * A whole graph as one file that can be read without this code and brought back into a new graph.
 *
 * Bodies stay the exact strings the graph wrote, because companion logs are not this package's to reparse, and what
 * comes back must be what went out. Everything in the graph is in here, private material and drafts included, and
 * no credentials: tokens live in the user file, never in the graph.
 */

export const GRAPH_EXPORT_FORMAT = 'episteme-graph-export'
export const GRAPH_EXPORT_VERSION = 1

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

export type GraphExportProblem =
  | 'no_graph'
  | 'target_exists'
  | 'not_an_export'
  | 'unsupported_version'
  | 'damaged'

/** Export or import refused, with nothing written. */
export class GraphExportError extends Error {
  readonly code: GraphExportProblem

  constructor(code: GraphExportProblem, message: string) {
    super(message)
    this.name = 'GraphExportError'
    this.code = code
  }
}

function digestOf(records: GraphExport['records'], companions: GraphExport['companions']): string {
  return createHash('sha256').update(JSON.stringify({ records, companions })).digest('hex')
}

/**
 * Writes the graph to `target`. Refuses while anything holds the graph, because a copy of a graph in use could be a
 * state that never existed, and refuses to replace an existing file.
 */
export async function exportGraph(
  graph: string,
  target: string,
  options: { readonly build: string; readonly now?: () => Date },
): Promise<GraphExport> {
  if (!existsSync(graph)) throw new GraphExportError('no_graph', `no graph at "${graph}"`)
  if (existsSync(target)) {
    throw new GraphExportError('target_exists', `"${target}" already exists; it was not replaced`)
  }
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
      sha256: digestOf(records, companions),
      counts: { records: records.length, companions: counted },
      records,
      companions,
    }
  } finally {
    db.close()
  }
  // `wx`: a file that appeared in the meantime is still not replaced. `0o600`: the file holds everyone's private
  // material, so only its owner reads it. Windows ignores the mode and the file takes its folder's permissions.
  await writeFile(target, JSON.stringify(exported), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return exported
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
  if (digestOf(parsed.records, parsed.companions) !== parsed.sha256) {
    throw new GraphExportError('damaged', `"${file}" does not match its checksum`)
  }
  return parsed as GraphExport
}

/**
 * Brings an export back as a new graph at `target`.
 *
 * Only ever a new file: merging into a graph with its own history would be an irreversible rewrite of that history.
 * It is built beside the target and moved into place once it opens as a graph, so a failure leaves nothing at
 * `target`.
 */
export async function importGraph(file: string, target: string): Promise<GraphExport> {
  if (existsSync(target)) {
    throw new GraphExportError('target_exists', `"${target}" already exists; it was not replaced`)
  }
  const exported = await readGraphExport(file)
  exported.records.forEach((body, index) => {
    try {
      deserializeRecord(body, index + 1)
    } catch (error) {
      throw new GraphExportError(
        'damaged',
        `record ${index + 1} of "${file}" cannot be read: ${(error as Error).message}`,
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
