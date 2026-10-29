import type { EpochMillis } from '@episteme/core'
import type { CompanionLog } from '@episteme/storage-sqlite'

/**
 * A scene's own records (ADR 0015, decision 7): what a scene needs to work, such as a learning project's goal or
 * the step a learner is on, kept per namespace and person, in versions.
 *
 * Never understanding. Anything that says how well a person understands something is a state event and goes
 * through the decision path. Episteme cannot tell a goal from a level, so that is the scene's rule to keep.
 */

export interface SceneRecord {
  readonly namespace: string
  readonly owner: string
  readonly key: string
  /** 1, 2, 3 … per namespace, owner and key. */
  readonly version: number
  /** JSON. `null` removes the record while keeping its history. */
  readonly value: unknown
  readonly by: string
  readonly at: EpochMillis
}

export const SCENE_RECORDS_SCHEMA_VERSION = 1

/** The largest value a record may hold, serialized. A scene's records are settings, not material. */
export const MAX_SCENE_RECORD_BYTES = 64 * 1024

function keyOf(namespace: string, owner: string, key: string): string {
  return JSON.stringify([namespace, owner, key])
}

/** The scene records of one graph. Append-only; a read returns the latest version. */
export class SceneRecordStore {
  readonly #log: CompanionLog | undefined
  readonly #latest = new Map<string, SceneRecord>()

  private constructor(log: CompanionLog | undefined) {
    this.#log = log
  }

  static async open(log?: CompanionLog): Promise<SceneRecordStore> {
    const store = new SceneRecordStore(log)
    if (log === undefined) return store
    for (const [index, body] of (await log.read()).entries()) {
      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch (error) {
        throw new Error(
          `record ${index + 1} of "${log.location}" is not valid JSON: ${(error as Error).message}`,
        )
      }
      const record = parsed as { schemaVersion?: unknown; kind?: unknown; record?: SceneRecord }
      if (
        record.schemaVersion !== SCENE_RECORDS_SCHEMA_VERSION ||
        record.kind !== 'scene-record' ||
        record.record === undefined
      ) {
        throw new Error(
          `record ${index + 1} of "${log.location}" is not a scene record this build reads`,
        )
      }
      store.#apply(record.record)
    }
    return store
  }

  /** The latest version of a record, or `undefined` when there is none or it was removed. */
  get(namespace: string, owner: string, key: string): SceneRecord | undefined {
    const record = this.#latest.get(keyOf(namespace, owner, key))
    return record === undefined || record.value === null ? undefined : record
  }

  /** A person's latest records in a namespace, optionally only keys starting with `prefix`. */
  list(namespace: string, owner: string, prefix = ''): readonly SceneRecord[] {
    return [...this.#latest.values()].filter(
      (record) =>
        record.namespace === namespace &&
        record.owner === owner &&
        record.key.startsWith(prefix) &&
        record.value !== null,
    )
  }

  /** Appends the next version of a record. */
  async put(record: Omit<SceneRecord, 'version'>): Promise<SceneRecord> {
    const previous = this.#latest.get(keyOf(record.namespace, record.owner, record.key))
    const next: SceneRecord = { ...record, version: (previous?.version ?? 0) + 1 }
    await this.#log?.append(
      JSON.stringify({
        schemaVersion: SCENE_RECORDS_SCHEMA_VERSION,
        kind: 'scene-record',
        record: next,
      }),
    )
    this.#apply(next)
    return next
  }

  #apply(record: SceneRecord): void {
    this.#latest.set(keyOf(record.namespace, record.owner, record.key), record)
  }
}
