import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { EpistemeError, type EventLogState } from '@episteme/core'
import Database from 'better-sqlite3'
import { RecordStorage, deserializeRecord, serializeRecord, type LoadedState } from './records.js'

export * from './records.js'

/**
 * The layout of the file, kept in SQLite's own `user_version`. 0 is a file this backend has never written, which it
 * lays out; anything other than this number is refused rather than misread. Bump only together with a migration.
 */
export const SQLITE_FORMAT_VERSION = 2

/**
 * Another connection holds the graph, so this one refused to open it.
 *
 * One graph file has exactly one owner (ADR 0008). Two owners would each write their own history over the other's
 * without any error, so refusing to open is the only safe answer. Waiting would hang a second surface indefinitely.
 * The lock is the operating system's, so it is held only while its process runs: there is never a stale one to clear.
 */
export class GraphLockedError extends Error {
  readonly graphPath: string

  constructor(graphPath: string) {
    super(
      `the graph "${graphPath}" is already open in another connection, in this process or another. Use that process (for example the running service) or stop it first.`,
    )
    this.name = 'GraphLockedError'
    this.graphPath = graphPath
  }
}

/**
 * Durable storage for one graph in one SQLite file (ADR 0017, ADR 0018): its history, one record per row in the order
 * they are written, and the named logs of the stores kept with it (`companion`).
 *
 * - **One owner.** The file is opened with `locking_mode=EXCLUSIVE` and locked at once, so a second opener, in this
 *   process or another, is refused with `GraphLockedError` (ADR 0008). The lock is the operating system's: a
 *   process that exits in any way, killed outright included, gives it up, so no lock is ever left behind.
 * - **Crash safety.** A save is one transaction in WAL mode with `synchronous=FULL`. A crash mid-save leaves the
 *   previous save, which SQLite recovers from the write-ahead log the next time the file is opened.
 * - **Whole history in memory.** The history is read into memory on open and written back on save.
 */
export class SqliteStorageAdapter extends RecordStorage {
  readonly name = 'sqlite'

  readonly #filePath: string
  #db: Database.Database | undefined
  #insertRecordStmt: Database.Statement | undefined
  #deleteRecordsStmt: Database.Statement | undefined

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
    // `timeout: 0`: a held graph is refused at once rather than waited for.
    const db = new Database(this.#filePath, { timeout: 0 })
    try {
      this.#take(db)
      const rows = db.prepare('SELECT seq, body FROM records ORDER BY seq').all() as {
        seq: number
        body: string
      }[]
      const loaded = this.restore(rows.map((row) => deserializeRecord(row.body, row.seq)))
      this.#db = db
      this.#insertRecordStmt = db.prepare('INSERT INTO records (seq, body) VALUES (?, ?)')
      this.#deleteRecordsStmt = db.prepare('DELETE FROM records')
      return loaded
    } catch (error) {
      db.close()
      if (isBusy(error)) throw new GraphLockedError(this.#filePath)
      throw error
    }
  }

  /** Releases the file. Does not save (ADR 0006). Closing twice, or before opening, is a no-op. */
  close(): Promise<void> {
    return settled(() => {
      this.markClosed()
      this.#insertRecordStmt = undefined
      this.#deleteRecordsStmt = undefined
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
      const insert =
        this.#insertRecordStmt ?? db.prepare('INSERT INTO records (seq, body) VALUES (?, ?)')
      const deleteStmt = this.#deleteRecordsStmt ?? db.prepare('DELETE FROM records')
      const records = this.records()
      db.transaction(() => {
        deleteStmt.run()
        records.forEach((record, index) => insert.run(index + 1, serializeRecord(record)))
      })()
    })
  }

  /**
   * Copies the database as last saved, companion logs included, through SQLite's online backup. Copying the file
   * itself would miss whatever the write-ahead log has not yet folded into it.
   */
  async backUp(target: string): Promise<void> {
    await this.#open().backup(target)
  }

  /**
   * The named log of a store kept with this graph, such as its drafts. It shares this connection, so it has the
   * graph's one owner, and is usable only while the graph is open.
   */
  companion(name: string): CompanionLog {
    if (!/^[a-z][a-z-]*$/.test(name)) throw new Error(`"${name}" is not a companion log name`)
    return new CompanionLog(this.#open(), name, `${this.#filePath} (${name})`)
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
    db.pragma('foreign_keys = ON')
    db.exec('BEGIN EXCLUSIVE')
    try {
      const version = db.pragma('user_version', { simple: true }) as number
      if (version === 0) {
        db.exec('CREATE TABLE records (seq INTEGER PRIMARY KEY, body TEXT NOT NULL)')
        db.exec(
          'CREATE TABLE companions (name TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (name, seq))',
        )
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
 * One store's records in the graph's database, in the order they were written (ADR 0018). The bodies are the store's
 * own: this log neither reads nor checks them. Every write is durable when it returns, and a failed one changes
 * nothing.
 */
export class CompanionLog {
  readonly #db: Database.Database
  readonly #name: string
  /** Where the log is, for a store's messages. */
  readonly location: string
  readonly #readStmt: Database.Statement
  readonly #appendStmt: Database.Statement
  readonly #deleteStmt: Database.Statement
  readonly #insertStmt: Database.Statement

  constructor(db: Database.Database, name: string, location: string) {
    this.#db = db
    this.#name = name
    this.location = location
    this.#readStmt = db.prepare('SELECT body FROM companions WHERE name = ? ORDER BY seq')
    this.#appendStmt = db.prepare(
      'INSERT INTO companions (name, seq, body) VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM companions WHERE name = ?), ?)',
    )
    this.#deleteStmt = db.prepare('DELETE FROM companions WHERE name = ?')
    this.#insertStmt = db.prepare('INSERT INTO companions (name, seq, body) VALUES (?, ?, ?)')
  }

  /** Every body, oldest first. */
  read(): Promise<readonly string[]> {
    return settled(() => {
      this.#assertOpen()
      const rows = this.#readStmt.all(this.#name) as { body: string }[]
      return rows.map((row) => row.body)
    })
  }

  /** Adds one body after the others. */
  append(body: string): Promise<void> {
    return settled(() => {
      this.#assertOpen()
      this.#appendStmt.run(this.#name, this.#name, body)
    })
  }

  /** Replaces every body at once. */
  replace(bodies: readonly string[]): Promise<void> {
    return settled(() => {
      this.#assertOpen()
      this.#db.transaction(() => {
        this.#deleteStmt.run(this.#name)
        bodies.forEach((body, index) => this.#insertStmt.run(this.#name, index + 1, body))
      })()
    })
  }

  /** Refuses when the companion log was used after its graph was closed. */
  #assertOpen(): void {
    if (!this.#db.open) {
      throw new EpistemeError(
        'guard_rejected',
        `companion log "${this.location}" was used after its graph was closed`,
      )
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

/** Opens a graph's storage and reads whatever is already there. */
export async function openSqliteStorage(filePath: string): Promise<SqliteStorageAdapter> {
  const storage = new SqliteStorageAdapter(filePath)
  await storage.open()
  return storage
}
