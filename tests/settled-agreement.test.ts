import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CognitiveSession } from '@episteme/application'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Recall and progress answer the same question — can the learner build on this yet? — so they must give the same
 * answer for the same node. Progress asks for both confidence and articulation to be firm; recall used to accept
 * either one, and called a node settled that the progress page called shaky.
 */

let directory: string
let session: CognitiveSession

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-settled-'))
  session = await CognitiveSession.open({ filePath: join(directory, 'graph.db') })
})

afterEach(async () => {
  await session.close()
  await rm(directory, { recursive: true, force: true })
})

const QUESTION = 'why does attention need position information'

async function settledIn(nodeId: string): Promise<{ recall: boolean; progress: boolean }> {
  const recall = (await session.recall(QUESTION)).known.find((entry) => entry.nodeId === nodeId)
  const progress = session.progress().items.find((item) => item.nodeId === nodeId)
  return { recall: recall?.settled ?? false, progress: progress?.settled ?? false }
}

describe('whether a node is settled', () => {
  it('is the same in recall and in progress', async () => {
    const { nodeId } = await session.addNode({
      label: 'Attention needs position information',
      kind: 'claim',
    })

    await session.record(nodeId, { confidence: 'high', articulation: 'low' })
    expect(await settledIn(nodeId)).toEqual({ recall: false, progress: false })

    await session.record(nodeId, { articulation: 'medium' })
    expect(await settledIn(nodeId)).toEqual({ recall: true, progress: true })
  })
})
