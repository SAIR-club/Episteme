import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CognitiveSession, type Reviewer } from '@episteme/application'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Every decision leaves a review record, a dismissal included, naming its channel and who decided
 * (ADR 0012, decision 5). The record is kept beside the drafts, survives a restart, and is not understanding.
 */

const REVIEWER: Reviewer = {
  actorId: 'actor_human',
  credentialId: 'tok_test',
  label: 'workspace',
  userAgent: 'vitest',
}

let directory: string
let filePath: string
let session: CognitiveSession

async function proposeConfidence(level: string): Promise<string> {
  const result = await session.propose(
    { kind: 'state', target: 'q_order', dimension: 'confidence', level },
    { proposedBy: 'actor_agent_test', rationale: 'test' },
  )
  if (!result.ok) throw new Error(result.refusal.message)
  return result.suggestion.id
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-reviews-'))
  filePath = join(directory, 'graph.jsonl')
  session = await CognitiveSession.open({ filePath })
  await session.addNode({ id: 'q_order', label: 'Why order?', kind: 'question' })
})

afterEach(async () => {
  await session.close()
  await rm(directory, { recursive: true, force: true })
})

describe('review records', () => {
  it('records a dismissal and an acceptance with their channel and reviewer', async () => {
    const dismissed = await proposeConfidence('low')
    const accepted = await proposeConfidence('high')

    await session.decide(dismissed, { action: 'dismiss' }, 'learn-review', REVIEWER)
    const result = await session.decide(accepted, { action: 'accept' }, 'mcp-elicitation')
    if (!result.ok) throw new Error(result.refusal.message)

    expect(session.reviews()).toMatchObject([
      {
        suggestionId: dismissed,
        outcome: 'dismissed',
        channel: 'learn-review',
        reviewer: REVIEWER,
      },
      { suggestionId: accepted, outcome: 'accepted', channel: 'mcp-elicitation' },
    ])
    expect(session.reviews()[1]?.reviewer).toBeUndefined()
    expect(session.reviews()[1]?.operationId).toBe(
      result.outcome === 'dismissed' ? undefined : result.operationId,
    )
  })

  it('keeps them across a restart, outside the understanding events', async () => {
    const dismissed = await proposeConfidence('low')
    await session.decide(dismissed, { action: 'dismiss' }, 'learn-review', REVIEWER)
    const events = session.eventCount
    await session.close()

    session = await CognitiveSession.open({ filePath })
    expect(session.reviews()).toMatchObject([{ suggestionId: dismissed, outcome: 'dismissed' }])
    expect(session.eventCount).toBe(events)
  })
})
