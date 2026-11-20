import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

/**
 * Reads a SQLite file through a private copy of it and its write-ahead log.
 *
 * Opening a file left by a killed process recovers its log and folds it in when the connection closes, so even a look
 * rewrites it, and a read-only connection leaves a `-shm` beside it. A file that must come out exactly as it went in
 * is therefore never opened where it is. The copy lives in its own private directory and is gone when this returns.
 */
export function readThroughCopy<T>(file: string, read: (db: Database.Database) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'episteme-look-'))
  try {
    const copy = join(directory, 'copy.db')
    copyFileSync(file, copy)
    if (hasLog(file)) copyFileSync(`${file}-wal`, `${copy}-wal`)
    const db = new Database(copy, { timeout: 0 })
    try {
      return read(db)
    } finally {
      db.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/** Whether a write-ahead log with anything in it sits beside the file. */
export function hasLog(file: string): boolean {
  const log = `${file}-wal`
  return existsSync(log) && statSync(log).size > 0
}
