import type { EpochMillis } from '@episteme/core'
import type { CompanionLog } from '@episteme/storage-sqlite'

/**
 * Conversation threads (ADR 0015): a person's dialogue with their agents, kept beside the graph and never in it.
 *
 * Turns are the raw archive, read only by their owner. Summaries are what can be recalled and shared. A fork is a
 * thread whose parent is a turn of another, and reads that thread up to the turn, then its own (ADR 0005).
 */

export interface Thread {
  readonly id: string
  /** The person whose conversation it is. */
  readonly owner: string
  readonly title: string
  /** The application-defined scope it belongs to (ADR 0015, decision 6). */
  readonly scope?: string
  /** Set on a fork: the turn it continues from. */
  readonly parent?: { readonly thread: string; readonly turn: string }
  /** The host's own id for the conversation. Provenance only. */
  readonly hostSession?: string
  readonly createdAt: EpochMillis
}

export interface Turn {
  readonly id: string
  readonly thread: string
  /** 1, 2, 3 … among the thread's own turns. */
  readonly seq: number
  readonly speaker: 'learner' | 'agent'
  /** The raw words, canonical. The archive. */
  readonly text: string
  /** Who sent it: the agent that relayed the turn, or the person. */
  readonly by: string
  readonly at: EpochMillis
}

export interface TurnSummary {
  readonly turn: string
  readonly text: string
  /** Words of the turn it rests on, verbatim. Required for a learner's turn (ADR 0015, decision 2). */
  readonly quotes: readonly string[]
  /** The agent whose model wrote it. */
  readonly by: string
  readonly at: EpochMillis
}

export const THREADS_SCHEMA_VERSION = 1

type ThreadRecord =
  | { readonly schemaVersion: number; readonly kind: 'thread'; readonly thread: Thread }
  | { readonly schemaVersion: number; readonly kind: 'turn'; readonly turn: Turn }
  | { readonly schemaVersion: number; readonly kind: 'summary'; readonly summary: TurnSummary }

/**
 * The threads of one graph, in the order they were written.
 *
 * Append-only in the graph's database as in memory: a turn is never edited, and a newer summary of a turn is appended
 * beside the earlier ones. Memory follows the database, so a failed write leaves nothing the next session would not have.
 */
export class ThreadStore {
  readonly #log: CompanionLog | undefined
  readonly #threads = new Map<string, Thread>()
  readonly #turns = new Map<string, Turn>()
  readonly #turnsOf = new Map<string, Turn[]>()
  readonly #summaries = new Map<string, TurnSummary[]>()

  private constructor(log: CompanionLog | undefined) {
    this.#log = log
  }

  /** Reads the threads kept in `log`, or starts an empty in-memory store. An unreadable record throws. */
  static async open(log?: CompanionLog): Promise<ThreadStore> {
    const store = new ThreadStore(log)
    if (log === undefined) return store
    for (const [index, body] of (await log.read()).entries()) {
      store.#apply(parseRecord(body, index + 1, log.location))
    }
    return store
  }

  /** A person's threads, newest first, optionally only one scope's. */
  threadsOf(owner: string, scope?: string): readonly Thread[] {
    return [...this.#threads.values()]
      .filter((thread) => thread.owner === owner && (scope === undefined || thread.scope === scope))
      .reverse()
  }

  thread(id: string): Thread | undefined {
    return this.#threads.get(id)
  }

  turn(id: string): Turn | undefined {
    return this.#turns.get(id)
  }

  /** The thread's own turns, in order. */
  ownTurns(threadId: string): readonly Turn[] {
    return this.#turnsOf.get(threadId) ?? []
  }

  /** What reading the thread shows: its parent's turns up to the fork turn, recursively, then its own. */
  turnsOf(threadId: string): readonly Turn[] {
    const thread = this.#threads.get(threadId)
    if (thread === undefined) return []
    const own = this.ownTurns(threadId)
    if (thread.parent === undefined) return own
    const inherited = this.turnsOf(thread.parent.thread)
    const cut = inherited.findIndex((turn) => turn.id === thread.parent?.turn)
    return [...(cut < 0 ? inherited : inherited.slice(0, cut + 1)), ...own]
  }

  /** The current summary of a turn: the latest written. */
  summaryOf(turnId: string): TurnSummary | undefined {
    const all = this.#summaries.get(turnId)
    return all?.[all.length - 1]
  }

  /** Every summary of a turn, oldest first. */
  summariesOf(turnId: string): readonly TurnSummary[] {
    return this.#summaries.get(turnId) ?? []
  }

  addThread(thread: Thread): Promise<void> {
    return this.#write({ schemaVersion: THREADS_SCHEMA_VERSION, kind: 'thread', thread })
  }

  addTurn(turn: Turn): Promise<void> {
    return this.#write({ schemaVersion: THREADS_SCHEMA_VERSION, kind: 'turn', turn })
  }

  addSummary(summary: TurnSummary): Promise<void> {
    return this.#write({ schemaVersion: THREADS_SCHEMA_VERSION, kind: 'summary', summary })
  }

  async #write(record: ThreadRecord): Promise<void> {
    await this.#log?.append(JSON.stringify(record))
    this.#apply(record)
  }

  #apply(record: ThreadRecord): void {
    switch (record.kind) {
      case 'thread':
        this.#threads.set(record.thread.id, record.thread)
        return
      case 'turn': {
        this.#turns.set(record.turn.id, record.turn)
        const list = this.#turnsOf.get(record.turn.thread)
        if (list === undefined) this.#turnsOf.set(record.turn.thread, [record.turn])
        else list.push(record.turn)
        return
      }
      case 'summary': {
        const list = this.#summaries.get(record.summary.turn)
        if (list === undefined) this.#summaries.set(record.summary.turn, [record.summary])
        else list.push(record.summary)
        return
      }
    }
  }
}

function parseRecord(line: string, position: number, location: string): ThreadRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    throw new Error(
      `record ${position} of "${location}" is not valid JSON: ${(error as Error).message}`,
    )
  }
  const record = parsed as Partial<{
    schemaVersion: unknown
    kind: unknown
    thread: Thread
    turn: Turn
    summary: TurnSummary
  }> | null
  if (record?.schemaVersion !== THREADS_SCHEMA_VERSION) {
    throw new Error(
      `record ${position} of "${location}" is not a threads record this build reads (version ${THREADS_SCHEMA_VERSION})`,
    )
  }
  if (record.kind === 'thread' && record.thread !== undefined) {
    return { schemaVersion: THREADS_SCHEMA_VERSION, kind: 'thread', thread: record.thread }
  }
  if (record.kind === 'turn' && record.turn !== undefined) {
    return { schemaVersion: THREADS_SCHEMA_VERSION, kind: 'turn', turn: record.turn }
  }
  if (record.kind === 'summary' && record.summary !== undefined) {
    return { schemaVersion: THREADS_SCHEMA_VERSION, kind: 'summary', summary: record.summary }
  }
  throw new Error(`record ${position} of "${location}" is not a thread, a turn or a summary`)
}
