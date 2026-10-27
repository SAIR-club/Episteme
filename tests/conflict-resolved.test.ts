import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CognitiveSession } from '@episteme/application'
import { isOpenConflict } from '@episteme/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Only `suspected` and `open` are open conflicts. A conflict the learner marks `resolved` has been worked through:
 * it no longer asks for attention, counts as open, or stops anything being built on.
 */

let directory: string
let session: CognitiveSession

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-conflict-'))
  session = await CognitiveSession.open({ filePath: join(directory, 'graph.jsonl') })
})

afterEach(async () => {
  await session.close()
  await rm(directory, { recursive: true, force: true })
})

const QUESTION = 'why does attention need position information'

describe('a resolved conflict', () => {
  it('is open only while suspected or open', () => {
    expect(['none', 'suspected', 'open', 'resolved', undefined].map(isOpenConflict)).toEqual([
      false,
      true,
      true,
      false,
      false,
    ])
  })

  it('leaves progress and recall once the learner moves it from open to resolved', async () => {
    const node = await session.addNode({
      label: 'Attention needs position information',
      kind: 'claim',
    })
    const nodeId = node.nodeId
    await session.record(nodeId, { confidence: 'low', conflict: 'open' })

    const open = session.progress()
    expect(open.withOpenConflict).toBe(1)
    expect(open.items.find((item) => item.nodeId === nodeId)).toMatchObject({
      openConflicts: ['open'],
      attention: 'conflict',
    })
    expect((await session.recall(QUESTION)).known[0]?.openConflicts).toEqual(['open'])
    expect((await session.recallSummary(QUESTION)).entries[0]?.openConflict).toBe(true)

    await session.record(nodeId, { conflict: 'resolved' })

    const resolved = session.progress()
    expect(resolved.withOpenConflict).toBe(0)
    expect(resolved.items.find((item) => item.nodeId === nodeId)).toMatchObject({
      openConflicts: [],
      attention: 'shaky',
    })
    expect((await session.recall(QUESTION)).known[0]?.openConflicts).toEqual([])
    expect((await session.recallSummary(QUESTION)).entries[0]?.openConflict).toBeUndefined()
  })
})
