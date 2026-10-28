import { access, copyFile } from 'node:fs/promises'
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

/**
 * Opens a graph's storage, taking ownership of it: SQLite for a `.db`, `.sqlite` or `.sqlite3` path, JSONL for
 * any other. The SQLite driver is loaded only for a SQLite graph.
 */
export async function openGraphStorage(graphPath: string): Promise<RecordStorage> {
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
 * Both graphs are held for the whole copy, so neither changes underneath it. The source must exist and the target
 * must not hold a history or any companion file yet: a copy never merges into or overwrites another graph.
 */
export async function copyGraph(from: string, to: string): Promise<GraphCopy> {
  if (resolve(from) === resolve(to)) throw new Error(`"${from}" and "${to}" are the same graph`)
  if (!(await exists(from))) throw new Error(`there is no graph at "${from}"`)
  for (const suffix of Object.values(COMPANION_FILES)) {
    if (await exists(`${to}${suffix}`)) throw new Error(`"${to}${suffix}" already exists`)
  }

  const source = await openGraphStorage(from)
  try {
    const target = await openGraphStorage(to)
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

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}
