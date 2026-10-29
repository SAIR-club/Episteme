import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearnSession, SuggestionStore } from '@episteme/application'
import { CompanionLog, openSqliteStorage } from '@episteme/storage-sqlite'
import { seedTopic } from './fixtures.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * A failed write of the drafts log leaves the store saying what the log says.
 *
 * Memory used to change before the write, so a failure could show a draft as decided, or a decision as
 * settled, that the next session would find otherwise. These tests make one write fail and hold the store, and
 * the session's decisions, to the file.
 */

// eslint-disable-next-line @typescript-eslint/unbound-method -- kept to be put back, and called with its own `this`
const realReplace = CompanionLog.prototype.replace
/** Writes of the drafts log to let through before the next one fails. */
let skip = 0
let failNext = false

function failDraftsWrite(after = 0): void {
  skip = after
  failNext = true
}

beforeEach(() => {
  CompanionLog.prototype.replace = function (this: CompanionLog, bodies) {
    if (failNext && this.location.endsWith('(suggestions)')) {
      if (skip > 0) skip -= 1
      else {
        failNext = false
        return Promise.reject(
          Object.assign(new Error('injected: no space left on device'), { code: 'ENOSPC' }),
        )
      }
    }
    return realReplace.call(this, bodies)
  }
})

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-write-failure-'))
})

afterEach(async () => {
  failNext = false
  CompanionLog.prototype.replace = realReplace
  await rm(directory, { recursive: true, force: true })
})

const agent = { proposedBy: 'actor_agent_test', rationale: 'test' }
const draft = {
  proposal: { kind: 'claim', label: 'a draft' } as const,
  proposedBy: 'actor_agent_test',
  rationale: 'test',
  proposedAt: 1,
} as const

describe('the drafts store when a write fails', () => {
  it('keeps neither a new draft nor a removal that did not reach the file', async () => {
    const file = join(directory, 'learn.db')
    const storage = await openSqliteStorage(file)
    const store = await SuggestionStore.open(storage.companion('suggestions'))
    const kept = await store.add(draft)

    failDraftsWrite()
    await expect(store.add(draft)).rejects.toThrow('injected')
    expect(store.list().map((suggestion) => suggestion.id)).toEqual([kept.id])

    failDraftsWrite()
    await expect(store.remove(kept.id)).rejects.toThrow('injected')
    expect(store.get(kept.id)).toBeDefined()

    const reopened = await SuggestionStore.open(storage.companion('suggestions'))
    expect(reopened.list().map((suggestion) => suggestion.id)).toEqual([kept.id])
    await storage.close()
  })

  it('keeps an unsettled decision on record while settling it fails', async () => {
    const storage = await openSqliteStorage(join(directory, 'learn.db'))
    const log = storage.companion('suggestions')
    const store = await SuggestionStore.open(log)
    const kept = await store.add(draft)
    const resolution = {
      operationId: 'dec_test',
      suggestionId: kept.id,
      outcome: 'accepted',
      proposal: draft.proposal,
      planned: { nodeId: 'claim_9', edgeIds: [] },
      channel: 'learn-review',
    } as const
    await store.begin(resolution)

    failDraftsWrite()
    await expect(store.complete('dec_test', 0)).rejects.toThrow('injected')
    expect(store.get(kept.id)).toBeDefined()
    expect(store.resolutionOf(kept.id)?.operationId).toBe('dec_test')

    failDraftsWrite()
    await expect(store.abandon('dec_test')).rejects.toThrow('injected')
    expect(store.resolutionOf(kept.id)?.operationId).toBe('dec_test')

    const onDisk = (await log.read()).join(' ')
    expect(onDisk).toContain('dec_test')
    await storage.close()
  })
})

describe('a decision whose completing write fails', () => {
  it('reports the failure, keeps the draft on record, and settles it once on the next decision', async () => {
    const filePath = join(directory, 'learn.db')
    const session = await LearnSession.open({ filePath })
    await seedTopic(session)
    const proposed = await session.propose({ kind: 'claim', label: 'committed once' }, agent)
    if (!proposed.ok) throw new Error(proposed.refusal.message)

    // `begin` writes first; the second write of the drafts file is the one that completes the decision.
    failDraftsWrite(1)
    await expect(
      session.decide(proposed.suggestion.id, { action: 'accept' }, 'learn-review'),
    ).rejects.toThrow('injected')
    const committed = session.listNodes().filter((node) => node.label === 'committed once')
    expect(committed).toHaveLength(1)
    // The file still holds the draft and its record, and so does memory.
    expect(session.pendingSuggestions().map((suggestion) => suggestion.id)).toContain(
      proposed.suggestion.id,
    )

    // A new claim of the learner's own cannot take an id an unsettled decision planned.
    const own = await session.addNode({ label: 'my own claim', kind: 'claim' })
    expect(own.nodeId).not.toBe(committed[0]?.nodeId)

    // Deciding again settles the first decision instead of committing a second time.
    const again = await session.decide(proposed.suggestion.id, { action: 'accept' }, 'learn-review')
    expect(again.ok).toBe(false)
    expect(session.listNodes().filter((node) => node.label === 'committed once')).toHaveLength(1)
    expect(session.pendingSuggestions().map((suggestion) => suggestion.id)).not.toContain(
      proposed.suggestion.id,
    )
    await session.close()

    const reopened = await LearnSession.open({ filePath })
    expect(reopened.recovered).toEqual([])
    expect(reopened.listNodes().filter((node) => node.label === 'committed once')).toHaveLength(1)
    await reopened.close()
  })
})
