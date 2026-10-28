import { access, copyFile, rm, writeFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { openLocalStorage, type RecordStorage } from '@episteme/storage-local'

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
  readonly markerPath: string

  constructor(graphPath: string) {
    const markerPath = copyMarkerPath(graphPath)
    super(
      `"${graphPath}" is the target of a graph copy that did not finish, so it may be missing records or companion files. Run the same copy again; it starts over.`,
    )
    this.name = 'UnfinishedGraphCopyError'
    this.graphPath = graphPath
    this.markerPath = markerPath
  }
}

/** The file that marks a copy into `graphPath` as under way. While it exists the graph is not opened. */
function copyMarkerPath(graphPath: string): string {
  return `${graphPath}.copying`
}

/**
 * Opens a graph's storage, taking ownership of it: SQLite for a `.db`, `.sqlite` or `.sqlite3` path, JSONL for
 * any other. The SQLite driver is loaded only for a SQLite graph. Throws `UnfinishedGraphCopyError` for the target
 * of a copy that did not finish.
 */
export async function openGraphStorage(graphPath: string): Promise<RecordStorage> {
  if (await exists(copyMarkerPath(graphPath))) throw new UnfinishedGraphCopyError(graphPath)
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
}

/**
 * Copies a graph to a new path, in the backend the new path names: from JSONL to SQLite to import, the other way to
 * export. The companion files are copied with it, so drafts, sources, threads and scene records come along.
 *
 * - **Never over anything.** The source must exist, and no file of the target may exist yet: neither the graph nor
 *   a companion file. So every file at the target was written by this copy.
 * - **All or nothing.** A marker beside the target is written first and removed last; while it exists the target
 *   is refused as unfinished, so a graph with only some of its files is never opened as if it were whole. A copy
 *   that fails removes what it wrote, marker included. A copy that is killed leaves the marker, and running the
 *   same copy again removes what the killed one wrote and starts over.
 * - **Nothing changes underneath.** Both graphs are held for the whole copy.
 */
export async function copyGraph(from: string, to: string): Promise<GraphCopy> {
  if (resolve(from) === resolve(to)) throw new Error(`"${from}" and "${to}" are the same graph`)
  if (!(await exists(from))) throw new Error(`there is no graph at "${from}"`)
  if (await exists(copyMarkerPath(from))) throw new UnfinishedGraphCopyError(from)

  const marker = copyMarkerPath(to)
  // A marker means everything at the target is what an unfinished copy wrote, so it can go.
  if (await exists(marker)) await removeTarget(to)
  for (const path of [to, ...companionPaths(to)]) {
    if (await exists(path)) throw new Error(`"${path}" already exists`)
  }

  await writeFile(marker, `${JSON.stringify({ from: resolve(from) })}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  })
  try {
    const copied = await copyInto(from, to)
    await rm(marker)
    return copied
  } catch (error) {
    // Best effort: if removing fails too, the marker stays and the target stays refused until the copy is rerun.
    await removeTarget(to).catch(() => undefined)
    throw error
  }
}

async function copyInto(from: string, to: string): Promise<GraphCopy> {
  const source = await openBackend(from)
  try {
    const target = await openBackend(to)
    try {
      const records = source.records()
      target.adopt(records)
      await target.save()
      const companions: string[] = []
      for (const suffix of Object.values(COMPANION_FILES)) {
        if (!(await exists(`${from}${suffix}`))) continue
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

function companionPaths(graphPath: string): string[] {
  return Object.values(COMPANION_FILES).map((suffix) => `${graphPath}${suffix}`)
}

/** Every file a copy into `graphPath` may have written, by either backend, and last the marker. */
async function removeTarget(graphPath: string): Promise<void> {
  const written = [
    graphPath,
    ...['-wal', '-shm', '-journal', '.lock', '.tmp'].map((suffix) => `${graphPath}${suffix}`),
    ...companionPaths(graphPath),
  ]
  for (const path of written) await rm(path, { force: true })
  await rm(copyMarkerPath(graphPath), { force: true })
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}
