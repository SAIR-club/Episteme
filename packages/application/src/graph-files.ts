import { access, copyFile, rm } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { openLocalStorage, type RecordStorage } from '@episteme/storage-local'
import type { HeldRecord as HeldRecordType } from '@episteme/storage-sqlite'

/**
 * The files of one graph: the graph itself, in whichever backend its path names, and the files kept beside it and
 * owned with it (ADR 0015). The one place that knows them, so opening a graph and copying one cannot disagree.
 */

/** The files beside a graph, each named by appending its suffix to the graph's path. */
export const COMPANION_FILES = {
  suggestions: '.suggestions.jsonl',
  sources: '.sources.jsonl',
  threads: '.threads.jsonl',
  records: '.scene.jsonl',
} as const

/** Where one of a graph's companion files is. */
export function companionPath(graphPath: string, file: keyof typeof COMPANION_FILES): string {
  return `${graphPath}${COMPANION_FILES[file]}`
}

const SQLITE_EXTENSIONS = new Set(['.db', '.sqlite', '.sqlite3'])

/** Whether a graph path names the SQLite backend (ADR 0017). Every other path is a JSONL graph, as before. */
export function isSqliteGraph(graphPath: string): boolean {
  return SQLITE_EXTENSIONS.has(extname(graphPath).toLowerCase())
}

/** A graph a copy was writing into and did not finish. It is refused until the copy is run again. */
export class UnfinishedGraphCopyError extends Error {
  readonly graphPath: string

  constructor(graphPath: string) {
    super(
      `"${graphPath}" is the target of a graph copy that did not finish, so it may be missing records or companion files. Run the same copy again; it removes what the unfinished one wrote and starts over.`,
    )
    this.name = 'UnfinishedGraphCopyError'
    this.graphPath = graphPath
  }
}

/** A graph a copy is writing into right now. Neither opened nor copied into until that copy ends. */
export class GraphCopyInProgressError extends Error {
  readonly graphPath: string

  constructor(graphPath: string) {
    super(`a graph copy into "${graphPath}" is running now; wait for it to finish`)
    this.name = 'GraphCopyInProgressError'
    this.graphPath = graphPath
  }
}

/**
 * The record a copy into `graphPath` keeps beside it: a SQLite file the running copy holds with an operating-system
 * lock, holding the list of files that copy has written until it finishes (`HeldRecord`). Held means a copy is
 * running; not held but holding a list means a copy started and its process is gone.
 */
function copyRecordPath(graphPath: string): string {
  return `${graphPath}.copying`
}

/** What a copy writes into its record before it writes each file, so only those files are ever removed for it. */
interface CopyRecord {
  readonly from: string
  readonly to: string
  readonly files: readonly string[]
}

/** Every file a copy into `graphPath` may write, by either backend: the graph, its backend's files, its companions. */
function targetFiles(graphPath: string): string[] {
  const graph = resolve(graphPath)
  return [
    graph,
    ...BACKEND_SUFFIXES.map((suffix) => `${graph}${suffix}`),
    ...Object.values(COMPANION_FILES).map((suffix) => `${graph}${suffix}`),
  ]
}

/** What either backend may keep beside a graph while it is open or saving. */
const BACKEND_SUFFIXES = ['-wal', '-shm', '-journal', '.lock', '.tmp'] as const

/** Refuses a graph a copy is writing into now, or one a copy left unfinished. */
async function assertNoCopyInto(graphPath: string): Promise<void> {
  const record = copyRecordPath(graphPath)
  if (!(await exists(record))) return
  const { HeldRecord } = await import('@episteme/storage-sqlite')
  const state = HeldRecord.peek(record)
  if (state.held) throw new GraphCopyInProgressError(graphPath)
  if (state.value !== undefined) throw new UnfinishedGraphCopyError(graphPath)
}

/**
 * Opens a graph's storage, taking ownership of it: SQLite for a `.db`, `.sqlite` or `.sqlite3` path, JSONL for
 * any other. The SQLite driver is loaded only for a SQLite graph. Throws `GraphCopyInProgressError` for a graph a
 * copy is writing into now, and `UnfinishedGraphCopyError` for one a copy did not finish.
 */
export async function openGraphStorage(graphPath: string): Promise<RecordStorage> {
  await assertNoCopyInto(graphPath)
  return openBackend(graphPath)
}

async function openBackend(graphPath: string): Promise<RecordStorage> {
  if (!isSqliteGraph(graphPath)) return openLocalStorage(graphPath)
  const { openSqliteStorage } = await import('@episteme/storage-sqlite')
  return openSqliteStorage(graphPath)
}

/** What a copy moved. */
export interface GraphCopy {
  readonly records: number
  readonly companions: readonly string[]
  /** The source of an earlier copy into the same target that did not finish, whose files this copy removed first. */
  readonly recoveredFrom?: string
}

export interface CopyGraphOptions {
  /** Called once the graph is saved into the target and before its companion files are copied. */
  readonly afterGraph?: () => Promise<void>
}

/**
 * Copies a graph to a new path, in the backend the new path names: from JSONL to SQLite to import, the other way to
 * export. The companion files are copied with it, so drafts, sources, threads and scene records come along.
 *
 * - **One copy into a target at a time.** The copy holds the target's record (`<target>.copying`) with an
 *   operating-system lock from start to end. A second copy into the same target, from any source, is refused
 *   with `GraphCopyInProgressError` and touches nothing; so is opening the target.
 * - **Never over anything.** No file the copy would write may exist yet, so every file it writes is its own.
 * - **Only its own files are removed.** Before writing a file the copy adds it to the record. A copy that fails
 *   removes the files in its record and nothing else. A copy whose process is gone leaves its record unheld but
 *   not empty: the target is refused as unfinished, and the next copy into it takes the record, checks that it
 *   names this target and only this target's files, removes exactly those and starts over.
 * - **Nothing changes underneath.** Both graphs are held for the whole copy.
 */
export async function copyGraph(
  from: string,
  to: string,
  options: CopyGraphOptions = {},
): Promise<GraphCopy> {
  if (resolve(from) === resolve(to)) throw new Error(`"${from}" and "${to}" are the same graph`)
  if (!(await exists(from))) throw new Error(`there is no graph at "${from}"`)
  await assertNoCopyInto(from)

  const { HeldRecord, RecordHeldError } = await import('@episteme/storage-sqlite')
  let held: HeldRecordType
  try {
    held = HeldRecord.take(copyRecordPath(to))
  } catch (error) {
    if (error instanceof RecordHeldError) throw new GraphCopyInProgressError(to)
    throw error
  }

  let finished = false
  try {
    // Held, so no copy into this target is running: a list left in the record is a copy whose process is gone.
    const left = held.read()
    const recoveredFrom = left === undefined ? undefined : await recover(to, left)
    if (left !== undefined) held.write(undefined)

    for (const path of targetFiles(to)) {
      if (await exists(path)) throw new Error(`"${path}" already exists`)
    }

    const files: string[] = []
    const own = (paths: readonly string[]): void => {
      files.push(...paths)
      const record: CopyRecord = { from: resolve(from), to: resolve(to), files }
      held.write(JSON.stringify(record))
    }
    try {
      const copied = await copyInto(from, to, own, options)
      held.write(undefined)
      finished = true
      return recoveredFrom === undefined ? copied : { ...copied, recoveredFrom }
    } catch (error) {
      await removeFiles(files)
      held.write(undefined)
      throw error
    }
  } finally {
    held.close()
    // The target now exists, so a copy that takes the record in between refuses at once: removing it is safe. After
    // a failure it stays, empty, because a new copy may already hold it.
    if (finished) await rm(copyRecordPath(to), { force: true }).catch(() => undefined)
  }
}

/**
 * Removes what a copy whose process is gone wrote into `to`, after checking that its record is about this target
 * and lists only this target's files. Anything else is refused with nothing removed. Returns that copy's source.
 */
async function recover(to: string, left: string): Promise<string> {
  const allowed = new Set(targetFiles(to))
  let record: Partial<CopyRecord> | undefined
  try {
    record = JSON.parse(left) as Partial<CopyRecord>
  } catch {
    record = undefined
  }
  const files: unknown = record?.files
  if (
    record === undefined ||
    typeof record.from !== 'string' ||
    record.to !== resolve(to) ||
    !Array.isArray(files) ||
    !files.every((file) => typeof file === 'string' && allowed.has(file))
  ) {
    throw new Error(
      `the record of an unfinished copy into "${to}" (${copyRecordPath(to)}) cannot be checked, so nothing was removed; look at the files and remove them by hand`,
    )
  }
  await removeFiles(files as string[])
  return record.from
}

async function copyInto(
  from: string,
  to: string,
  own: (paths: readonly string[]) => void,
  options: CopyGraphOptions,
): Promise<GraphCopy> {
  const source = await openBackend(from)
  try {
    const graph = resolve(to)
    own([graph, ...BACKEND_SUFFIXES.map((suffix) => `${graph}${suffix}`)])
    const target = await openBackend(to)
    try {
      const records = source.records()
      target.adopt(records)
      await target.save()
      await options.afterGraph?.()
      const companions: string[] = []
      for (const suffix of Object.values(COMPANION_FILES)) {
        if (!(await exists(`${from}${suffix}`))) continue
        own([`${graph}${suffix}`])
        await copyFile(`${from}${suffix}`, `${to}${suffix}`)
        companions.push(`${to}${suffix}`)
      }
      return { records: records.length, companions }
    } finally {
      await target.close()
    }
  } finally {
    await source.close()
  }
}

async function removeFiles(files: readonly string[]): Promise<void> {
  for (const file of files) await rm(file, { force: true })
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}
