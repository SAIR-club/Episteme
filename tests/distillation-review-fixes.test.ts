import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearnSession, MAX_PENDING, type Suggestion } from '@episteme/application'
import { seedTopic } from '@episteme/app-learn/seed'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Defects an independent review of distillation found, each held here so it stays fixed: a claim about a
 * candidate that could never be accepted, a node's text left at the distiller's wording, a pending limit a
 * single run could overshoot, and drafts kept in memory that a failed write never stored.
 */

const MATERIAL = '学生：为什么 Transformer 需要位置编码？\n老师：因为自注意力本身不区分词的顺序。'
const agent = { proposedBy: 'actor_agent_test', rationale: 'test' }

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-distil-fixes-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function distilled(session: LearnSession): Promise<readonly Suggestion[]> {
  const outcome = await session.distill({ text: MATERIAL })
  if (!outcome.ok) throw new Error(outcome.refusal.message)
  return outcome.suggestions
}

const questionOf = (suggestions: readonly Suggestion[]): Suggestion => {
  const question = suggestions.find(
    (suggestion) =>
      suggestion.proposal.kind === 'node' && suggestion.proposal.nodeType === 'question',
  )
  if (question === undefined) throw new Error('no question was distilled')
  return question
}

const revokedClaims = (session: LearnSession) =>
  Array.from({ length: 10 }, (_, index) =>
    session.graph.getNode(`claim_${index + 1}` as never),
  ).filter((node) => node?.revoked === true)

describe('a claim about a candidate', () => {
  it('waits for the candidate, then is accepted about the node it became, leaving nothing revoked', async () => {
    const session = await LearnSession.open()
    await seedTopic(session)
    const question = questionOf(await distilled(session))
    const proposed = await session.propose(
      { kind: 'claim', label: 'about the distilled question', about: [`cand:${question.id}`] },
      agent,
    )
    if (!proposed.ok) throw new Error(proposed.refusal.message)

    const early = await session.decide(proposed.suggestion.id, { action: 'accept' }, 'learn-review')
    expect(early.ok).toBe(false)
    if (!early.ok) expect(early.refusal.code).toBe('depends_on_pending')
    expect(revokedClaims(session)).toEqual([])

    const accepted = await session.decide(question.id, { action: 'accept' }, 'learn-review')
    if (!accepted.ok || accepted.outcome === 'dismissed') throw new Error('expected the question')
    const claim = await session.decide(proposed.suggestion.id, { action: 'accept' }, 'learn-review')
    expect(claim.ok).toBe(true)
    if (!claim.ok || claim.outcome === 'dismissed') throw new Error('expected the claim')

    const edges = session.graph.listEdges().filter((edge) => edge.from === claim.committed.id)
    expect(edges.map((edge) => edge.to)).toEqual([accepted.committed.id])
    expect(revokedClaims(session)).toEqual([])
    await session.close()
  })

  it('is refused, leaving nothing revoked, once the candidate was dismissed', async () => {
    const session = await LearnSession.open()
    await seedTopic(session)
    const question = questionOf(await distilled(session))
    const proposed = await session.propose(
      { kind: 'claim', label: 'about a dismissed question', about: [`cand:${question.id}`] },
      agent,
    )
    if (!proposed.ok) throw new Error(proposed.refusal.message)
    await session.decide(question.id, { action: 'dismiss' }, 'learn-review')

    const result = await session.decide(
      proposed.suggestion.id,
      { action: 'accept' },
      'learn-review',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.code).toBe('unresolved_candidate')
    expect(revokedClaims(session)).toEqual([])
    await session.close()
  })
})

describe('a distilled node put in the learner’s own words', () => {
  it('keeps its text with the label as decided', async () => {
    const session = await LearnSession.open()
    await seedTopic(session)
    const question = questionOf(await distilled(session))
    const decided = await session.decide(
      question.id,
      {
        action: 'modify',
        // As the review queue sends it: the suggestion as it was, with only the label changed.
        proposal: { ...question.proposal, label: '位置编码为什么必要？' } as never,
      },
      'learn-review',
    )
    if (!decided.ok || decided.outcome === 'dismissed') throw new Error('expected a node')
    const node = session.graph.getNode(decided.committed.id)
    expect(node?.label).toBe('位置编码为什么必要？')
    expect(node?.properties['text']).toBe('位置编码为什么必要？')
    await session.close()
  })
})

describe('the pending limit', () => {
  it('refuses a run that would take the queue past it, keeping nothing', async () => {
    const session = await LearnSession.open()
    await seedTopic(session)
    for (let index = 0; index < MAX_PENDING - 1; index += 1) {
      const proposed = await session.propose({ kind: 'claim', label: `claim ${index}` }, agent)
      if (!proposed.ok) throw new Error(proposed.refusal.message)
    }
    const before = session.pendingSuggestions().length
    const outcome = await session.distill({ text: MATERIAL })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.refusal.code).toBe('too_many_pending')
    expect(session.pendingSuggestions()).toHaveLength(before)
    expect(session.sources()).toEqual([])
    await session.close()
  })
})

describe('a distillation whose drafts fail to be written', () => {
  const fsPromises = createRequire(import.meta.url)('node:fs/promises') as {
    rename: (from: string, to: string) => Promise<void>
  }
  const realRename = fsPromises.rename
  afterEach(() => {
    fsPromises.rename = realRename
    syncBuiltinESMExports()
  })

  it('keeps no draft in memory that the file does not hold', async () => {
    const filePath = join(directory, 'learn.jsonl')
    const session = await LearnSession.open({ filePath })
    await seedTopic(session)
    fsPromises.rename = async (from: string, to: string) => {
      if (to.endsWith('.suggestions.jsonl')) throw new Error('injected: no space left on device')
      return realRename(from, to)
    }
    syncBuiltinESMExports()
    await expect(session.distill({ text: MATERIAL })).rejects.toThrow('injected')
    expect(session.pendingSuggestions()).toEqual([])

    fsPromises.rename = realRename
    syncBuiltinESMExports()
    await session.close()
    const reopened = await LearnSession.open({ filePath })
    expect(reopened.pendingSuggestions()).toEqual([])
    await reopened.close()
  })
})
