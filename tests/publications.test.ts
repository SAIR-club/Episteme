import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CognitiveSession } from '@episteme/application'
import { asId, type NodeId } from '@episteme/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NODE, createFixture, learnTags } from './fixtures.js'
import { storedRecords } from './stored.js'

/**
 * Publications (ADR 0014, step S4): a person's deliberate act of making part of their understanding public.
 *
 * Checked here: every refusal, that what a preview shows is what is written, what becomes visible to someone
 * else and what stays private, withdrawal, and that publications survive a restart.
 */

let directory: string
let filePath: string
let owner: CognitiveSession
let lin: CognitiveSession
let wei: CognitiveSession

/** Lin's work: a claim answering a question, an unrelated claim, and a concept everyone can see. */
async function linsWork(): Promise<{
  claim: string
  question: string
  other: string
  concept: string
}> {
  const claim = (
    await lin.addNode({ label: 'Attention alone does not encode order', kind: 'claim' })
  ).nodeId
  const question = (
    await lin.addNode({ label: 'Why does a transformer need positions?', kind: 'question' })
  ).nodeId
  const other = (await lin.addNode({ label: 'Heads specialise', kind: 'claim' })).nodeId
  const concept = (await lin.addNode({ label: 'Self-attention', kind: 'concept' })).nodeId
  await lin.link(claim, question)
  await lin.link(claim, concept)
  await lin.record(claim, { confidence: 'high' })
  return { claim, question, other, concept }
}

async function open(sharing = true): Promise<void> {
  owner = await CognitiveSession.open({ filePath, sharing })
  lin = owner.forActor('actor_human_lin', 'Lin')
  wei = owner.forActor('actor_human_wei', 'Wei')
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-publications-'))
  filePath = join(directory, 'shared.db')
  await open()
})

afterEach(async () => {
  await owner.close()
  await rm(directory, { recursive: true, force: true })
})

const ids = (session: CognitiveSession) => session.listNodes().map((node) => node.nodeId)

describe('publishing', () => {
  it('makes the root and what it reaches through the author’s relations visible, and nothing else', async () => {
    const work = await linsWork()
    expect(ids(wei)).not.toContain(work.claim)

    const published = await lin.publish({ root: work.claim, include: [work.question] })
    if (!published.ok) throw new Error(published.refusal.message)
    expect(published.publication).toMatchObject({
      actorId: 'actor_human_lin',
      root: work.claim,
      members: [work.claim, work.question],
    })
    // The edge to the concept goes with it: everyone can already see the concept.
    expect(published.publication.edges).toHaveLength(2)

    expect(ids(wei)).toEqual(expect.arrayContaining([work.claim, work.question, work.concept]))
    expect(ids(wei)).not.toContain(work.other)
    // Lin's state is hers: publishing a claim does not publish how sure she is of it.
    expect(wei.understandingOf(work.claim)).toEqual([])
    expect(wei.publications().map((publication) => publication.id)).toEqual([
      published.publication.id,
    ])
  })

  it('writes exactly what the preview showed', async () => {
    const work = await linsWork()
    const preview = lin.previewPublication({ root: work.claim, include: [work.question] })
    const published = await lin.publish({ root: work.claim, include: [work.question] })
    if (!preview.ok || !published.ok) throw new Error('refused')
    const { id: _a, createdAt: _b, ...shown } = preview.publication
    const { id: _c, createdAt: _d, ...written } = published.publication
    expect(written).toEqual(shown)
  })
})

describe('what cannot be published', () => {
  it('refuses a node written by someone else', async () => {
    const work = await linsWork()
    const result = await wei.publish({ root: work.claim })
    expect(result).toMatchObject({ ok: false, refusal: { code: 'not_publishable' } })
  })

  it('refuses a node that does not exist', async () => {
    const result = await lin.publish({ root: 'claim_absent' })
    expect(result).toMatchObject({ ok: false, refusal: { code: 'not_publishable' } })
  })

  it('refuses an unrelated node slipped into the include list', async () => {
    const work = await linsWork()
    const result = await lin.publish({ root: work.claim, include: [work.other] })
    expect(result).toMatchObject({ ok: false, refusal: { code: 'outside_closure' } })
    expect(ids(wei)).not.toContain(work.claim)
  })

  it('refuses to supersede what is not the author’s own live publication', async () => {
    const work = await linsWork()
    const weiNode = (await wei.addNode({ label: 'Wei’s claim', kind: 'claim' })).nodeId
    const weis = await wei.publish({ root: weiNode })
    if (!weis.ok) throw new Error(weis.refusal.message)
    for (const supersedes of ['pub_absent', weis.publication.id]) {
      const result = await lin.publish({ root: work.claim, supersedes })
      expect(result).toMatchObject({ ok: false, refusal: { code: 'invalid_supersedes' } })
    }
  })

  it('refuses an agent: publishing is a person’s decision', () => {
    const context = createFixture()
    context.graph.addNode({
      id: asId<NodeId>('k_agent'),
      type: NODE.claim,
      label: 'k',
      properties: { text: 'k' },
      tags: learnTags('transformer'),
      tier: 'thought',
      source: 'session:1',
      actorId: context.agentId,
    })
    const result = context.log.publish({ id: 'pub_1', actorId: context.agentId, root: 'k_agent' })
    expect(result).toMatchObject({ ok: false, refusal: { code: 'agent_cannot_publish' } })
  })

  it('refuses everything when sharing is off', async () => {
    await owner.close()
    await open(false)
    const node = (await lin.addNode({ label: 'mine', kind: 'claim' })).nodeId
    expect(lin.previewPublication({ root: node })).toMatchObject({
      ok: false,
      refusal: { code: 'sharing_disabled' },
    })
    expect(await lin.publish({ root: node })).toMatchObject({
      ok: false,
      refusal: { code: 'sharing_disabled' },
    })
  })
})

describe('withdrawing', () => {
  it('stops new readers, keeps what someone already holds state on, and is the author’s alone', async () => {
    const work = await linsWork()
    const published = await lin.publish({ root: work.claim })
    if (!published.ok) throw new Error(published.refusal.message)
    await wei.record(work.claim, { confidence: 'medium' })
    const mei = owner.forActor('actor_human_mei', 'Mei')
    expect(ids(mei)).toContain(work.claim)

    expect(await wei.withdrawPublication(published.publication.id)).toMatchObject({
      ok: false,
      refusal: { code: 'not_the_author' },
    })
    expect((await lin.withdrawPublication(published.publication.id)).ok).toBe(true)

    expect(ids(mei)).not.toContain(work.claim)
    expect(ids(wei)).toContain(work.claim)
    expect(wei.historyOf(work.claim)).toHaveLength(1)
    expect(wei.publications()).toEqual([])
  })
})

describe('persistence', () => {
  it('keeps publications and withdrawals across a restart, and copies the graph aside before the first', async () => {
    const work = await linsWork()
    // The graph's file is its owner's alone while it is open, so it is read between two owners.
    await owner.close()
    const before = storedRecords(filePath)
    await open()
    const first = await lin.publish({ root: work.claim })
    const second = await lin.publish({ root: work.question })
    if (!first.ok || !second.ok) throw new Error('refused')
    await lin.withdrawPublication(first.publication.id)

    const backup = `${filePath}.before-sharing`
    await access(backup)

    await owner.close()
    expect(storedRecords(backup)).toEqual(before)
    expect(storedRecords(filePath)).not.toEqual(before)
    await open()
    expect(wei.publications().map((publication) => publication.id)).toEqual([second.publication.id])
    expect(ids(wei)).toContain(work.question)
    expect(ids(wei)).not.toContain(work.claim)
  })
})
