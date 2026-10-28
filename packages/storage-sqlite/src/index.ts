import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { EpistemeError, type EventLogState } from '@episteme/core'
import {
  GraphLockedError,
  RecordStorage,
  deserializeRecord,
  serializeRecord,
  type LoadedState,
} from '@episteme/storage-local'
import Database from 'better-sqlite3'

/**
 * The layout of the file, kept in SQLite's own `user_version`. 0 is a file this backend has never written, which it
 * lays out; anything other than this number is refused rather than misread. Bump only together with a migration.
 */
export const SQLITE_FORMAT_VERSION = 1

/**
 * A durable backend in one SQLite file (ADR 0017): the same records as the JSONL backend, one row each, in the
 * order they are written.
 *
 * - **One owner.** The file is opened with `locking_mode=EXCLUSIVE` and locked at once, so a second opener, in this
 *   process or another, is refused with `GraphLockedError` (ADR 0008). The lock is the operating system's: a
 *   process that exits in any way, killed outright included, gives it up, so no lock is ever left behind.
 * - **Crash safety.** A save is one transaction in WAL mode with `synchronous=FULL`. A crash mid-save leaves the
 *   previous save, which SQLite recovers from the write-ahead log the next time the file is opened.
 * - **Same semantics.** The whole history is read into memory on open and written on save, exactly as with JSONL,
 *   so nothing above this adapter can tell the two apart.
 */
export class SqliteStorageAdapter extends RecordStorage {
  readonly name = 'sqlite'

  readonly #filePath: string
  #db: Database.Database | undefined

  constructor(filePath: string) {
    super()
    this.#filePath = filePath
  }

  get filePath(): string {
    return this.#filePath
  }

  protected get location(): string {
    return this.#filePath
  }

  /**
   * Takes the file and reads it into memory. A missing file is an empty history, not an error.
   *
   * Throws `GraphLockedError` when another connection holds it, and an `EpistemeError` for a file in a layout this
   * build does not read. Either way nothing stays open.
   */
  open(): Promise<LoadedState> {
    return settled(() => this.#openNow())
  }

  #openNow(): LoadedState {
    mkdirSync(dirname(this.#filePath), { recursive: true })
    // `timeout: 0`: a held graph is refused at once, as the JSONL backend does, rather than waited for.
    const db = new Database(this.#filePath, { timeout: 0 })
    try {
      this.#take(db)
      const rows = db.prepare('SELECT seq, body FROM records ORDER BY seq').all() as {
        seq: number
        body: string
      }[]
      const loaded = this.restore(rows.map((row) => deserializeRecord(row.body, row.seq)))
      this.#db = db
      return loaded
    } catch (error) {
      db.close()
      if (isBusy(error)) {
        throw new GraphLockedError(this.#filePath, this.#filePath, undefined, { running: true })
      }
      throw error
    }
  }

  /** Releases the file. Does not save (ADR 0006). Closing twice, or before opening, is a no-op. */
  close(): Promise<void> {
    return settled(() => {
      this.markClosed()
      this.#db?.close()
      this.#db = undefined
    })
  }

  /**
   * Writes the whole history in one transaction, absorbing `state` first when the event log offers it. Either every
   * record is written or, after a crash, none of this save is.
   */
  save(state?: EventLogState): Promise<void> {
    return settled(() => {
      if (state !== undefined) this.absorb(state)
      this.assertOpen()
      const db = this.#open()
      const insert = db.prepare('INSERT INTO records (seq, body) VALUES (?, ?)')
      const records = this.records()
      db.transaction(() => {
        db.prepare('DELETE FROM records').run()
        records.forEach((record, index) => insert.run(index + 1, serializeRecord(record)))
      })()
    })
  }

  /**
   * Copies the database as last saved, through SQLite's online backup. Copying the file itself would miss whatever
   * the write-ahead log has not yet folded into it.
   */
  async backUp(target: string): Promise<void> {
    await this.#open().backup(target)
  }

  #open(): Database.Database {
    if (this.#db === undefined) {
      throw new EpistemeError(
        'guard_rejected',
        `storage "${this.#filePath}" was used before open() or after close(); call open() first`,
      )
    }
    return this.#db
  }

  /** Locks the file for this connection alone and lays it out if it is new. */
  #take(db: Database.Database): void {
    // Exclusive before WAL, so the log keeps no shared-memory index other connections could use, and the lock,
    // once taken by the first write, is held until the connection closes instead of released after it.
    db.pragma('locking_mode = EXCLUSIVE')
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = FULL')
    db.exec('BEGIN EXCLUSIVE')
    try {
      const version = db.pragma('user_version', { simple: true }) as number
      if (version === 0) {
        db.exec('CREATE TABLE records (seq INTEGER PRIMARY KEY, body TEXT NOT NULL)')
        db.pragma(`user_version = ${SQLITE_FORMAT_VERSION}`)
      } else if (version !== SQLITE_FORMAT_VERSION) {
        throw new EpistemeError(
          'guard_rejected',
          `storage "${this.#filePath}" has format version ${version}; this build reads version ${SQLITE_FORMAT_VERSION}`,
        )
      }
      db.exec('COMMIT')
    } catch (error) {
      if (db.inTransaction) db.exec('ROLLBACK')
      throw error
    }
  }
}

/**
 * The driver is synchronous and the ports are not: runs `work` now and hands back its result, or its failure as a
 * rejected promise rather than a throw, as an `async` method would.
 */
function settled<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work())
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
}

/** Whether SQLite refused because another connection holds the file. */
function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown }).code
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED'
}

/** Opens a SQLite-backed adapter and reads whatever is already there. */
export async function openSqliteStorage(filePath: string): Promise<SqliteStorageAdapter> {
  const storage = new SqliteStorageAdapter(filePath)
  await storage.open()
  return storage
}
