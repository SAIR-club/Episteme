import { LearnSession } from '@episteme/application'
import { seedTopic } from '@episteme/application/seed'
import { describe, expect, it } from 'vitest'

/**
 * The revision a read reports (ADR 0010): equal and even means the same state, so a Workspace drawing the
 * graph, the review queue and a history from several reads can tell whether they describe one moment.
 */

async function seeded(): Promise<LearnSession> {
  const session = await LearnSession.open()
  await seedTopic(session)
  return session
}

describe('the session revision', () => {
  it('is even and unchanged while nothing changes, however much is read', async () => {
    const session = await seeded()
    const before = session.revision
    expect(before % 2).toBe(0)

    session.listNodes()
    session.pendingSuggestions()
    session.progress()
    await session.recall('why does attention need positions')

    expect(session.revision).toBe(before)
    await session.close()
  })

  it('advances across every change, and is even again once the change is done', async () => {
    const session = await seeded()
    const before = session.revision

    await session.record('q_why_order', { confidence: 'medium' })
    const recorded = session.revision
    expect(recorded).toBeGreaterThan(before)
    expect(recorded % 2).toBe(0)

    const proposed = await session.propose(
      { kind: 'claim', label: 'attention ignores order' },
      { proposedBy: 'actor_agent_test', rationale: 'test' },
    )
    expect(proposed.ok).toBe(true)
    expect(session.revision).toBeGreaterThan(recorded)
    expect(session.revision % 2).toBe(0)
    await session.close()
  })

  it('is odd while a change is in progress, so a read in the middle promises nothing', async () => {
    const session = await seeded()
    let during = -1
    await session.batch(() => {
      during = session.revision
    })
    expect(during % 2).toBe(1)
    expect(session.revision % 2).toBe(0)
    await session.close()
  })

  it('advances for a refused change too, since what was tried may have touched something', async () => {
    const session = await seeded()
    const before = session.revision
    const refused = await session.propose(
      { kind: 'state', target: 'no_such_node', dimension: 'confidence', level: 'high' },
      { proposedBy: 'actor_agent_test', rationale: 'test' },
    )
    expect(refused.ok).toBe(false)
    expect(session.revision).toBeGreaterThan(before)
    expect(session.revision % 2).toBe(0)
    await session.close()
  })
})
