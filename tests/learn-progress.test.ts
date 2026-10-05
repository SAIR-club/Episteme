import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearnSession } from '@episteme/application'
import { seedTopic } from '@episteme/app-learn/seed'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * The learning-state summary.
 *
 * The retrieval panel answers "what is relevant to this question" and the graph listing answers "what
 * exists". Neither answers *"what did I get out of this"*, which is the question a learner has after using
 * the loop a while. This is the only thing on the surface that says whether a session changed anything.
 *
 * It deliberately reuses the same reading of state that ranking uses, so it cannot tell a learner their
 * understanding is settled while the cognitive signal is treating it as shaky.
 */

let directory: string
let filePath: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-progress-'))
  filePath = join(directory, 'learn.jsonl')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function session(): Promise<LearnSession> {
  const opened = await LearnSession.open({ filePath })
  await seedTopic(opened)
  return opened
}

describe('an empty graph has learned nothing', () => {
  it('says so plainly rather than showing zeros', async () => {
    const opened = await session()
    const progress = opened.progress()

    expect(progress.touched).toBe(0)
    expect(progress.settled).toBe(0)
    expect(progress.items).toEqual([])
    expect(progress.summary).toContain('还没有记录过')
    // The total is still reported, so "0 of 9" is distinguishable from "0 of 0".
    expect(progress.totalNodes).toBeGreaterThan(0)
  })
})

describe('classification', () => {
  it('counts touched and settled, and reports them in one line', async () => {
    const opened = await session()
    await opened.record('q_why_order', { confidence: 'high', articulation: 'high' })
    await opened.record('c_rope', { confidence: 'low' })

    const progress = opened.progress()
    expect(progress.touched).toBe(2)
    expect(progress.settled).toBe(1)
    expect(progress.summary).toContain('2 个节点')
    expect(progress.summary).toContain('1 个已经可以往下建')
  })

  it('treats an open conflict as the first thing to look at', async () => {
    const opened = await session()
    await opened.record('q_why_order', { confidence: 'high', articulation: 'high' })
    await opened.record('c_rope', { confidence: 'high', articulation: 'high', conflict: 'open' })

    const progress = opened.progress()

    // Ordering is the point: a conflict is the one state the system refuses to build on, so it cannot sit
    // below an item that is merely unfinished.
    expect(progress.items[0]?.nodeId).toBe('c_rope')
    expect(progress.items[0]?.attention).toBe('conflict')
    expect(progress.withOpenConflict).toBe(1)
    expect(progress.items[1]?.attention).toBe('settled')
  })

  it('separates "believes it but cannot explain it" from merely unfinished', async () => {
    const opened = await session()
    await opened.record('c_rope', { confidence: 'high', articulation: 'low' })
    await opened.record('c_transformer', { confidence: 'low', articulation: 'low' })

    const progress = opened.progress()
    const rope = progress.items.find((item) => item.nodeId === 'c_rope')
    const transformer = progress.items.find((item) => item.nodeId === 'c_transformer')

    // The first is what a scaffold is for; the second has no ground under it yet, so it is not the same
    // problem and must not be given the same advice.
    expect(rope?.attention).toBe('unexplained')
    expect(transformer?.attention).toBe('shaky')
    expect(rope?.settled).toBe(false)
  })

  it('orders the remaining groups conflict, unexplained, shaky, settled', async () => {
    const opened = await session()
    await opened.record('c_transformer', { confidence: 'low' })
    await opened.record('c_rope', { confidence: 'high', articulation: 'high' })
    // Confidence is recorded explicitly: "explains it badly while believing it" is only distinguishable
    // from "no ground yet" when the belief is actually recorded. With articulation alone this is `shaky`,
    // which is correct — the learner has not said they hold it.
    await opened.record('c_self_attention', { confidence: 'high', articulation: 'low' })
    await opened.record('c_positional_encoding', { confidence: 'high', conflict: 'open' })

    const order = opened.progress().items.map((item) => item.attention)
    // `shaky` before `unexplained`: an item with no ground under it is the more urgent of the two, because
    // there is nothing to build on at all. "Cannot yet explain it" is further along, not behind.
    expect(order).toEqual(['conflict', 'shaky', 'unexplained', 'settled'])
  })

  it('treats a node with no recorded confidence as shaky, not as something believed', async () => {
    const opened = await session()
    await opened.record('c_rope', { articulation: 'low' })

    const item = opened.progress().items[0]
    // Nothing says the learner believes it, so the system must not assume they do. This is the distinction
    // that keeps `unexplained` meaningful rather than a synonym for "articulation is low".
    expect(item?.attention).toBe('shaky')
  })
})

describe('agreement with the cognitive relevance signal', () => {
  it('uses the same settled reading that ranking uses', async () => {
    // `retrieveWith` marks an item settled when confidence and articulation are both in their settled band.
    // If this panel used a different rule, it could tell a learner their understanding is ready while the
    // ranker was treating it as shaky — two answers to one question.
    const opened = await session()
    await opened.record('c_rope', { confidence: 'medium', articulation: 'medium' })

    const item = opened.progress().items[0]
    expect(item?.settled).toBe(true)
    expect(item?.attention).toBe('settled')
  })

  it('does not count untouched reference material as progress', async () => {
    const opened = await session()
    // The seed creates reference nodes. None of them is the learner's understanding of anything.
    expect(opened.listNodes().length).toBeGreaterThan(5)
    expect(opened.progress().touched).toBe(0)
  })
})

describe('it survives a restart like everything else', () => {
  it('reports the same summary from a second session over the same file', async () => {
    const first = await session()
    await first.record('q_why_order', { confidence: 'high', articulation: 'high' })
    await first.record('c_rope', { confidence: 'low' })
    const before = first.progress()

    const second = await LearnSession.open({ filePath })
    const after = second.progress()

    expect(after.touched).toBe(before.touched)
    expect(after.settled).toBe(before.settled)
    expect(after.summary).toBe(before.summary)
    expect(after.items.map((item) => item.nodeId)).toEqual(before.items.map((item) => item.nodeId))
  })
})
