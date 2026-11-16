import { existsSync } from 'node:fs'
import { openSqliteStorage, type CompanionLog } from '@episteme/storage-sqlite'
import Database from 'better-sqlite3'

/**
 * What a graph's file holds, read with a connection of the test's own: the graph's records, or with `log` one
 * companion log's (ADR 0018), as the JSON bodies they were written as, oldest first. The graph must not be open,
 * since its owner holds the file exclusively. A file that does not exist holds nothing.
 */
export function storedRecords(graphPath: string, log?: string): string[] {
  let db: Database.Database
  try {
    db = new Database(graphPath, { readonly: true, fileMustExist: true })
  } catch (error) {
    if ((error as { code?: string }).code === 'SQLITE_CANTOPEN') return []
    throw error
  }
  try {
    const rows =
      log === undefined
        ? db.prepare('SELECT body FROM records ORDER BY seq').all()
        : db.prepare('SELECT body FROM companions WHERE name = ? ORDER BY seq').all(log)
    return (rows as { body: string }[]).map((row) => row.body)
  } finally {
    db.close()
  }
}

/** The same, as one string per log, for a test that only asks whether something is in it. */
export function storedText(graphPath: string, log?: string): string {
  return storedRecords(graphPath, log).join('\n')
}

/**
 * Writes records into a graph's file as an earlier build, or a damaged disk, would have left them, without going
 * through the stores that would check them: `records` replaces the graph's, and each entry of `logs` that companion
 * log's. The file is laid out first if it is new; one that exists is written into as it is, damaged or not.
 */
export async function writeStoredRecords(
  graphPath: string,
  contents: {
    readonly records?: readonly string[]
    readonly logs?: Record<string, readonly string[]>
  },
): Promise<void> {
  if (!existsSync(graphPath)) await (await openSqliteStorage(graphPath)).close()
  const db = new Database(graphPath)
  try {
    db.transaction(() => {
      if (contents.records !== undefined) {
        db.prepare('DELETE FROM records').run()
        const insert = db.prepare('INSERT INTO records (seq, body) VALUES (?, ?)')
        contents.records.forEach((body, index) => insert.run(index + 1, body))
      }
      for (const [name, bodies] of Object.entries(contents.logs ?? {})) {
        db.prepare('DELETE FROM companions WHERE name = ?').run(name)
        const insert = db.prepare('INSERT INTO companions (name, seq, body) VALUES (?, ?, ?)')
        bodies.forEach((body, index) => insert.run(name, index + 1, body))
      }
    })()
  } finally {
    db.close()
  }
}

/**
 * Runs `use` with one companion log of a graph that is not otherwise open, for a test that drives a store directly.
 * The graph is released when `use` settles, so the store must not be used after.
 */
export async function withCompanion<T>(
  graphPath: string,
  name: string,
  use: (log: CompanionLog) => Promise<T>,
): Promise<T> {
  const storage = await openSqliteStorage(graphPath)
  try {
    return await use(storage.companion(name))
  } finally {
    await storage.close()
  }
}
