import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearnSession, SuggestionStore, type Proposal } from '@episteme/application'
import { seedTopic } from '@episteme/app-learn/seed'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Pending suggestions: an agent's proposals, kept as drafts outside the graph (ADR 0008).
 *
 * The properties that matter are what proposing does *not* do — it never touches the graph or the history —
 * and that a proposal which could never be accepted is refused at once, as a value, instead of becoming a
 * draft the learner later fails to accept.
 */

const AGENT = 'actor_agent_test-client'
const WHY = 'the learner keeps returning to why order matters'

let directory: string
let filePath: string
let session: LearnSession

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-suggest-'))
  filePath = join(directory, 'learn.jsonl')
  session = await LearnSession.open({ filePath })
  await seedTopic(session)
})

afterEach(async () => {
  await session.close()
  await rm(directory, { recursive: true, force: true })
})

async function propose(proposal: Proposal, rationale = WHY, proposedBy = AGENT) {
  return session.propose(proposal, { proposedBy, rationale })
}

describe('proposing', () => {
  it('keeps each kind of proposal as a pending draft, with who proposed it and why', async () => {
    const claim = await propose({
      kind: 'claim',
      label: '自注意力本身无法区分顺序',
      about: ['c_self_attention'],
    })
    const link = await propose({
      kind: 'link',
      from: 'c_rope',
      to: 'c_permutation_invariance',
      relation: 'refers_to',
    })
    const state = await propose({
      kind: 'state',
      target: 'q_why_order',
      dimension: 'confidence',
      level: 'medium',
    })

    for (const result of [claim, link, state]) expect(result.ok).toBe(true)
    const pending = session.pendingSuggestions()
    expect(pending.map((suggestion) => suggestion.proposal.kind)).toEqual([
      'claim',
      'link',
      'state',
    ])
    expect(pending.every((suggestion) => suggestion.proposedBy === AGENT)).toBe(true)
    expect(pending.every((suggestion) => suggestion.rationale === WHY)).toBe(true)
    expect(new Set(pending.map((suggestion) => suggestion.id)).size).toBe(3)
  })

  it('never changes the graph or the history', async () => {
    const nodesBefore = session.listNodes().length
    const eventsBefore = session.eventCount
    const edgesBefore = session.graph.listEdges().length

    await propose({ kind: 'claim', label: 'a claim nobody has accepted' })
    await propose({ kind: 'link', from: 'c_rope', to: 'c_transformer', relation: 'refers_to' })
    await propose({ kind: 'state', target: 'c_rope', dimension: 'confidence', level: 'high' })

    expect(session.listNodes().length).toBe(nodesBefore)
    expect(session.graph.listEdges().length).toBe(edgesBefore)
    expect(session.eventCount).toBe(eventsBefore)
    expect(session.understandingOf('c_rope')).toEqual([])
  })

  it('keeps drafts across a restart, beside the graph rather than in it', async () => {
    await propose({ kind: 'state', target: 'c_rope', dimension: 'articulation', level: 'low' })
    const graphBefore = await readFile(filePath, 'utf8')
    await session.close()

    session = await LearnSession.open({ filePath })
    expect(session.pendingSuggestions()).toHaveLength(1)
    expect(session.pendingSuggestions()[0]?.proposal).toEqual({
      kind: 'state',
      target: 'c_rope',
      dimension: 'articulation',
      level: 'low',
    })
    // The graph file is untouched by proposing; the draft is in its own file.
    expect(await readFile(filePath, 'utf8')).toBe(graphBefore)
    expect(await readFile(`${filePath}.suggestions.jsonl`, 'utf8')).toContain('"articulation"')
  })
})

describe('refusing what could never be accepted', () => {
  it('requires a reason', async () => {
    const result = await propose({ kind: 'claim', label: 'x' }, '   ')
    expect(result).toMatchObject({ ok: false, refusal: { code: 'missing_rationale' } })
  })

  it('refuses the human as a proposer: they record, they do not suggest to themselves', async () => {
    const result = await propose({ kind: 'claim', label: 'x' }, WHY, session.actorId)
    expect(result).toMatchObject({ ok: false, refusal: { code: 'not_an_agent' } })
  })

  it('refuses nodes that do not exist', async () => {
    const state = await propose({
      kind: 'state',
      target: 'c_missing',
      dimension: 'confidence',
      level: 'high',
    })
    const claim = await propose({ kind: 'claim', label: 'about nothing', about: ['c_missing'] })
    expect(state).toMatchObject({ ok: false, refusal: { code: 'unknown_node' } })
    expect(claim).toMatchObject({ ok: false, refusal: { code: 'unknown_node' } })
  })

  it('refuses a dimension or level the learner could not record themselves', async () => {
    const dimension = await propose({
      kind: 'state',
      target: 'c_rope',
      dimension: 'mastery',
      level: 'high',
    })
    const level = await propose({
      kind: 'state',
      target: 'c_rope',
      dimension: 'confidence',
      level: 'total',
    })
    expect(dimension).toMatchObject({ ok: false, refusal: { code: 'unregistered_dimension' } })
    expect(level).toMatchObject({ ok: false, refusal: { code: 'invalid_dimension_value' } })
  })

  it('refuses a link the graph itself would refuse, with the graph’s own reason', async () => {
    const unregistered = await propose({
      kind: 'link',
      from: 'c_rope',
      to: 'c_transformer',
      relation: 'vaguely_related',
    })
    // `supports` must point at a claim; a concept is not one.
    const wrongEndpoint = await propose({
      kind: 'link',
      from: 'c_rope',
      to: 'c_transformer',
      relation: 'supports',
    })
    expect(unregistered).toMatchObject({ ok: false, refusal: { code: 'unregistered_edge_type' } })
    expect(wrongEndpoint.ok).toBe(false)
  })

  it('keeps nothing when it refuses', async () => {
    await propose({ kind: 'claim', label: '' })
    expect(session.pendingSuggestions()).toHaveLength(0)
  })
})

describe('the draft file', () => {
  it('is disposable: removing a draft leaves nothing behind', async () => {
    const result = await propose({ kind: 'claim', label: 'to be dropped' })
    if (!result.ok) throw new Error(result.refusal.message)
    await session.close()

    const store = await SuggestionStore.open(`${filePath}.suggestions.jsonl`)
    expect(await store.remove(result.suggestion.id)).toBe(true)
    expect(await store.remove(result.suggestion.id)).toBe(false)
    expect(await readFile(`${filePath}.suggestions.jsonl`, 'utf8')).toBe('')

    session = await LearnSession.open({ filePath })
    expect(session.pendingSuggestions()).toHaveLength(0)
  })

  it('fails loudly on a line it cannot read, and does not keep the graph locked', async () => {
    await session.close()
    await writeFile(`${filePath}.suggestions.jsonl`, '{"schemaVersion":99}\n', 'utf8')

    await expect(LearnSession.open({ filePath })).rejects.toThrow(/version 1 suggestion/)
    const lockLeft = await access(`${filePath}.lock`).then(
      () => true,
      () => false,
    )
    expect(lockLeft).toBe(false)

    await rm(`${filePath}.suggestions.jsonl`)
    session = await LearnSession.open({ filePath })
  })

  it('works in memory for a session without a file', async () => {
    const inMemory = await LearnSession.open()
    await seedTopic(inMemory)
    const result = await inMemory.propose(
      { kind: 'state', target: 'c_rope', dimension: 'confidence', level: 'low' },
      { proposedBy: AGENT, rationale: WHY },
    )
    expect(result.ok).toBe(true)
    expect(inMemory.pendingSuggestions()).toHaveLength(1)
    await inMemory.close()
  })
})
