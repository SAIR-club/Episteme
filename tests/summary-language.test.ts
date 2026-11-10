import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CognitiveSession } from '@episteme/application'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * A scene may be English or Chinese. The one-line summaries of recall and progress used to be Chinese only, so an
 * English scene and the agents reading it got Chinese. `summary` is now English and `summaryZh` Chinese.
 */

let directory: string
let session: CognitiveSession

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-summary-'))
  session = await CognitiveSession.open({ filePath: join(directory, 'graph.db') })
})

afterEach(async () => {
  await session.close()
  await rm(directory, { recursive: true, force: true })
})

const QUESTION = 'why does attention need position information'
const HAN = /\p{Script=Han}/u

describe('the one-line summaries', () => {
  it('are English in summary and Chinese in summaryZh, before and after anything is recorded', async () => {
    const empty = await session.recall(QUESTION)
    expect(empty.summary).toBe('nothing is recorded about this yet')
    expect(empty.summaryZh).toBe('关于这个，你还没有记录过任何东西')
    expect(session.progress().summary).toBe('you have recorded no understanding yet')
    expect(session.progress().summaryZh).toBe('你还没有记录过任何理解')

    const { nodeId } = await session.addNode({
      label: 'Attention needs position information',
      kind: 'claim',
    })
    const kept = await session.recall(QUESTION)
    expect(kept.summary).toBe(
      'you kept related items but have recorded no level of understanding for them yet',
    )
    expect(kept.summaryZh).toBe('你保存过相关内容，但还没有标记理解程度')

    await session.record(nodeId, { confidence: 'high', articulation: 'high' })
    const recorded = await session.recall(QUESTION)
    expect(recorded.summary).toContain('confidence=high')
    expect(recorded.summaryZh).toBe(recorded.summary)
    const progress = session.progress()
    expect(progress.summary).toBe('you have recorded understanding of 1 node; 1 can be built on')
    expect(progress.summary).not.toMatch(HAN)
    expect(progress.summaryZh).toBe('你为 1 个节点记录过理解，其中 1 个已经可以往下建')
  })
})
