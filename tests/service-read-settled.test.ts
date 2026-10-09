import { LearnSession } from '@episteme/application'
import { seedTopic } from './fixtures.js'
import { readSettled } from '@episteme/service'
import { describe, expect, it } from 'vitest'

/**
 * A read that awaits reports the state it saw, or says it cannot (ADR 0010). Reads are not queued, so a change
 * can land while `recall` waits on embeddings; claiming the result describes the state the change left would
 * break the revision's promise.
 */

describe('a read that awaits', () => {
  it('reports the even revision it read at when nothing changed meanwhile', async () => {
    const session = await LearnSession.open()
    await seedTopic(session)
    const before = session.revision
    const read = await readSettled(session, () =>
      session.recall('why does attention need positions'),
    )
    expect(read.revision).toBe(before)
    expect(read.revision % 2).toBe(0)
    expect(read.epoch).toBe(session.epoch)
    await session.close()
  })

  it('reports an odd revision when a change landed while it waited, even once the change is done', async () => {
    const session = await LearnSession.open()
    await seedTopic(session)
    const read = await readSettled(session, async () => {
      const recalled = await session.recall('why does attention need positions')
      // A change that completes before the read returns: it may or may not be in the result.
      await session.record('q_why_order', { confidence: 'high' })
      return recalled
    })
    expect(session.revision % 2).toBe(0)
    expect(read.revision % 2).toBe(1)
    await session.close()
  })
})
