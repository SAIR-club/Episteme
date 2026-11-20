import { createHash } from 'node:crypto'
import {
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { openSqliteStorage } from './index.js'
import { readThroughCopy } from './private-copy.js'
import { deserializeRecord, serializeRecord, type PersistedRecordKind } from './records.js'

/** The layout of a SQLite graph written before companion logs moved into the file (ADR 0017). */
const OLDER_SQLITE_FORMAT = 1

/** Where an older build kept each store: a file beside the graph, by the name of the log that replaces it. */
const OLDER_COMPANIONS = {
  suggestions: '.suggestions.jsonl',
  sources: '.sources.jsonl',
  threads: '.threads.jsonl',
  'scene-records': '.scene.jsonl',
} as const

export type GraphConversionRefusal =
  | 'same_file'
  | 'no_source'
  | 'not_a_file'
  | 'target_exists'
  | 'source_open'
  | 'unfinished_copy'
  | 'not_older_graph'
  | 'unreadable'
  | 'source_changed'
  | 'mismatch'

/** Why a graph was not converted. Whatever the reason, the older files are as they were and no target exists. */
export class GraphConversionError extends Error {
  readonly code: GraphConversionRefusal

  constructor(code: GraphConversionRefusal, message: string) {
    super(message)
    this.name = 'GraphConversionError'
    this.code = code
  }
}

export interface GraphConversion {
  readonly from: string
  readonly to: string
  readonly sourceFormat: 'jsonl' | 'sqlite-1'
  /** How many records of each kind came over: nodes, edges, branches, events and so on. */
  readonly records: Readonly<Partial<Record<PersistedRecordKind, number>>>
  /** How many records of each store came over: drafts, sources, threads, scene records. */
  readonly companions: Readonly<Record<string, number>>
  /** Each older file read, with its SHA-256, the same before and after. */
  readonly source: Readonly<Record<string, string>>
  /** Things found and left alone that a person may want to know about. */
  readonly notes: readonly string[]
}

export interface ConvertOptions {
  /**
   * One more check before the new graph lands, by a caller that knows more than storage does. It gets a throwaway
   * copy, so it may open it the way the application would. Throwing refuses the conversion.
   */
  readonly verify?: (graph: string) => Promise<void>
}

/**
 * Copies an older graph, a JSONL file or a format 1 SQLite file with its companion files, into a new format 2 graph.
 *
 * - **The older files are read, never opened in place.** They are fingerprinted before and after, and a difference
 *   refuses the conversion.
 * - **The target is only ever new.** It is built in a directory of its own beside the target, checked against the
 *   source, and linked into place, which fails rather than replaces a file that appeared in the meantime.
 * - **Bodies come over as they are.** Records and companion records are neither rewritten nor upgraded.
 */
export async function convertLegacyGraph(
  from: string,
  to: string,
  options: ConvertOptions = {},
): Promise<GraphConversion> {
  if (resolve(from) === resolve(to)) {
    throw new GraphConversionError('same_file', `"${from}" and "${to}" are the same file`)
  }
  if (!existsSync(from)) {
    throw new GraphConversionError('no_source', `there is no graph at "${from}"`)
  }
  if (!statSync(from).isFile()) {
    throw new GraphConversionError('not_a_file', `"${from}" is not a file`)
  }
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(`${to}${suffix}`)) {
      throw new GraphConversionError(
        'target_exists',
        `"${to}${suffix}" already exists; it was not replaced`,
      )
    }
  }
  const notes = refuseWhatIsStillInUse(from)

  const before = fingerprint(from)
  const sourceFormat = isSqliteFile(from) ? 'sqlite-1' : 'jsonl'
  const records = sourceFormat === 'jsonl' ? readLines(from) : readOlderSqlite(from)
  const parsed = records.map((body, index) => {
    try {
      return deserializeRecord(body, index + 1)
    } catch (error) {
      throw new GraphConversionError(
        'unreadable',
        `record ${index + 1} of "${from}" cannot be read: ${(error as Error).message}`,
      )
    }
  })
  const companions = new Map(
    Object.entries(OLDER_COMPANIONS).map(([name, suffix]) => [name, readCompanion(from, suffix)]),
  )

  mkdirSync(dirname(resolve(to)), { recursive: true })
  const directory = mkdtempSync(`${resolve(to)}.converting-`)
  try {
    const building = join(directory, 'graph.db')
    const storage = await openSqliteStorage(building)
    await storage.close()
    writeAll(building, records, companions)
    await checkAgainstSource(building, records, companions)
    if (options.verify !== undefined) {
      const throwaway = join(directory, 'verify.db')
      copyFileSync(building, throwaway)
      await options.verify(throwaway)
    }

    const after = fingerprint(from)
    if (JSON.stringify([...before]) !== JSON.stringify([...after])) {
      throw new GraphConversionError(
        'source_changed',
        `"${from}" changed while it was being read. Stop whatever has it open and run this again.`,
      )
    }
    land(building, to)
  } catch (error) {
    if (error instanceof GraphConversionError) throw error
    throw new GraphConversionError(
      'mismatch',
      `the graph built from "${from}" did not check out, so it was not kept: ${(error as Error).message}`,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }

  const counted: Partial<Record<PersistedRecordKind, number>> = {}
  for (const { kind } of parsed) counted[kind] = (counted[kind] ?? 0) + 1
  return {
    from,
    to,
    sourceFormat,
    records: counted,
    companions: Object.fromEntries(
      [...companions]
        .filter(([, bodies]) => bodies !== undefined)
        .map(([name, bodies]) => [name, bodies?.length ?? 0]),
    ),
    source: Object.fromEntries(before),
    notes,
  }
}

/**
 * Refuses a graph an older build is using, or was left halfway through copying into. A JSONL graph's lock file names
 * its owner; a SQLite owner cannot be seen without touching the file, which is why the fingerprints are compared.
 */
function refuseWhatIsStillInUse(from: string): readonly string[] {
  const notes: string[] = []
  const lock = `${from}.lock`
  if (existsSync(lock)) {
    const pid = lockOwner(lock)
    if (pid !== undefined && isRunning(pid)) {
      throw new GraphConversionError(
        'source_open',
        `"${from}" is open in process ${pid}. Stop it first, so what is converted is everything it saved.`,
      )
    }
    notes.push(`"${basename(lock)}" was left by a process that is gone; it was left in place`)
  }
  const copying = `${from}.copying`
  if (existsSync(copying) && unfinishedCopy(copying)) {
    throw new GraphConversionError(
      'unfinished_copy',
      `"${from}" is the target of a graph copy that did not finish, so it may be missing records. Run that copy again with the older build first.`,
    )
  }
  return notes
}

function lockOwner(lock: string): number | undefined {
  try {
    const { pid } = JSON.parse(readFileSync(lock, 'utf8')) as { pid?: unknown }
    return typeof pid === 'number' ? pid : undefined
  } catch {
    return undefined
  }
}

/** Signal 0 checks for existence without signalling. `EPERM` means it exists but belongs to someone else. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM'
  }
}

function unfinishedCopy(copying: string): boolean {
  return readThroughCopy(copying, (db) => {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'record'")
      .get()
    return table !== undefined && db.prepare('SELECT value FROM record').get() !== undefined
  })
}

/** The SHA-256 of every older file that exists, by name. */
function fingerprint(from: string): Map<string, string> {
  const files = [
    from,
    `${from}-wal`,
    `${from}-shm`,
    ...Object.values(OLDER_COMPANIONS).map((suffix) => `${from}${suffix}`),
  ]
  const found = new Map<string, string>()
  for (const file of files) {
    if (!existsSync(file)) continue
    found.set(basename(file), createHash('sha256').update(readFileSync(file)).digest('hex'))
  }
  return found
}

function isSqliteFile(file: string): boolean {
  const header = readFileSync(file).subarray(0, 16)
  // A graph killed before its first checkpoint can be an empty file with everything in the log.
  if (header.length === 0) return existsSync(`${file}-wal`)
  return header.toString('latin1') === 'SQLite format 3\0'
}

function readOlderSqlite(from: string): string[] {
  return readThroughCopy(from, (db) => {
    const version = db.pragma('user_version', { simple: true }) as number
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'records'")
      .get()
    if (version !== OLDER_SQLITE_FORMAT || table === undefined) {
      throw new GraphConversionError(
        'not_older_graph',
        `"${from}" is not a graph of the older layout (format ${version}), so there is nothing to convert`,
      )
    }
    const rows = db.prepare('SELECT body FROM records ORDER BY seq').all() as { body: string }[]
    return rows.map((row) => row.body)
  })
}

function readLines(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/** A companion file's records, checked only to be whole lines of JSON: what they mean is their store's business. */
function readCompanion(from: string, suffix: string): string[] | undefined {
  const file = `${from}${suffix}`
  if (!existsSync(file)) return undefined
  const lines = readLines(file)
  lines.forEach((line, index) => {
    try {
      JSON.parse(line)
    } catch (error) {
      throw new GraphConversionError(
        'unreadable',
        `line ${index + 1} of "${file}" cannot be read: ${(error as Error).message}`,
      )
    }
  })
  return lines
}

function writeAll(
  graph: string,
  records: readonly string[],
  companions: ReadonlyMap<string, readonly string[] | undefined>,
): void {
  const db = new Database(graph)
  try {
    const record = db.prepare('INSERT INTO records (seq, body) VALUES (?, ?)')
    const companion = db.prepare('INSERT INTO companions (name, seq, body) VALUES (?, ?, ?)')
    db.transaction(() => {
      records.forEach((body, index) => record.run(index + 1, body))
      for (const [name, bodies] of companions) {
        bodies?.forEach((body, index) => companion.run(name, index + 1, body))
      }
    })()
  } finally {
    db.close()
  }
}

/** Reads the new graph back, the rows as written and then the history as the storage restores it. */
async function checkAgainstSource(
  graph: string,
  records: readonly string[],
  companions: ReadonlyMap<string, readonly string[] | undefined>,
): Promise<void> {
  const db = new Database(graph, { readonly: true })
  try {
    const rows = db.prepare('SELECT body FROM records ORDER BY seq').all() as { body: string }[]
    same(
      rows.map((row) => row.body),
      records,
      'records',
    )
    for (const [name, bodies] of companions) {
      const stored = db
        .prepare('SELECT body FROM companions WHERE name = ? ORDER BY seq')
        .all(name) as { body: string }[]
      same(
        stored.map((row) => row.body),
        bodies ?? [],
        `the "${name}" log`,
      )
    }
  } finally {
    db.close()
  }
  const storage = await openSqliteStorage(graph)
  try {
    const restored = storage.records().map(serializeRecord).sort()
    const expected = records.map((body, index) =>
      serializeRecord(deserializeRecord(body, index + 1)),
    )
    same(restored, expected.sort(), 'the restored history')
  } finally {
    await storage.close()
  }
}

function same(actual: readonly string[], expected: readonly string[], what: string): void {
  if (actual.length !== expected.length) {
    throw new Error(
      `${what}: ${actual.length} in the new graph, ${expected.length} in the older one`,
    )
  }
  const differs = actual.findIndex((value, index) => value !== expected[index])
  if (differs !== -1) throw new Error(`${what}: number ${differs + 1} differs`)
}

/** Puts the finished file at `to`, failing rather than replacing anything that appeared there. */
function land(building: string, to: string): void {
  try {
    linkSync(building, to)
    return
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'EEXIST') {
      throw new GraphConversionError('target_exists', `"${to}" already exists; it was not replaced`)
    }
  }
  // A file system without hard links.
  try {
    copyFileSync(building, to, constants.COPYFILE_EXCL)
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') {
      throw new GraphConversionError('target_exists', `"${to}" already exists; it was not replaced`)
    }
    throw error
  }
}
