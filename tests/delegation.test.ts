import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CognitiveSession, type Proposal } from '@episteme/application'
import { startService, type EpistemeService } from '@episteme/service'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mcpWire } from './mcp-wire.js'

/**
 * Delegated confirmation (ADR 0016): a person may let the service confirm agent proposals for them, within a
 * scope, through the same decision path, recorded as delegated, never for a conflict, and always undoable.
 */

let directory: string
let session: CognitiveSession

const AGENT = { proposedBy: 'actor_agent_test', rationale: 'r' }
const state = (target: string, dimension: string, level: string): Proposal => ({
  kind: 'state',
  target,
  dimension,
  level,
})

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-delegation-'))
  session = await CognitiveSession.open({ filePath: join(directory, 'graph.jsonl'), sharing: true })
  await session.addNode({ id: 'q_order', label: 'Why order?', kind: 'question' })
})

afterEach(async () => {
  await session.close()
  await rm(directory, { recursive: true, force: true })
})

describe('without a delegation', () => {
  it('leaves a proposal waiting for the person', async () => {
    const result = await session.propose(state('q_order', 'confidence', 'high'), AGENT)
    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.delegated).toBeFalsy()
    expect(session.pendingSuggestions()).toHaveLength(1)
  })
})

describe('with a live delegation', () => {
  it('accepts a proposal at once, as the person, recorded as delegated', async () => {
    await session.grantDelegation('*')
    const result = await session.propose(state('q_order', 'confidence', 'high'), AGENT)
    expect(result.ok && result.delegated).toMatchObject({ ok: true, outcome: 'accepted' })
    expect(session.pendingSuggestions()).toEqual([])
    expect(session.understandingOf('q_order')).toEqual([{ id: 'confidence', level: 'high' }])
    const [event] = session.historyOf('q_order') ?? []
    expect(event?.dimensions).toEqual([
      [
        'confidence',
        expect.objectContaining({ authority: 'delegated', confirmedBy: 'actor_human' }),
      ],
    ])
    expect(session.reviews()).toMatchObject([
      { outcome: 'accepted', channel: 'delegation', reviewer: { label: 'delegation' } },
    ])
  })

  it('covers only its scope', async () => {
    await session.grantDelegation('ml-2026')
    const outside = await session.propose(state('q_order', 'confidence', 'low'), AGENT)
    expect(outside.ok && outside.delegated).toBeFalsy()
    const inside = await session.propose(state('q_order', 'articulation', 'low'), {
      ...AGENT,
      scope: 'ml-2026',
    })
    expect(inside.ok && inside.delegated).toMatchObject({ ok: true })
    expect(session.pendingSuggestions()).toHaveLength(1)
  })

  it('never decides a conflict', async () => {
    await session.grantDelegation('*')
    const result = await session.propose(state('q_order', 'conflict', 'suspected'), AGENT)
    expect(result.ok && result.delegated).toBeFalsy()
    expect(session.pendingSuggestions()).toHaveLength(1)
  })

  it('decides the drafts of a distillation too, and the claims it accepts show as delegated when published', async () => {
    await session.grantDelegation('*')
    const outcome = await session.distill({
      text: '学生：为什么需要位置编码？\n老师：因为自注意力本身不区分词的顺序。',
    })
    if (!outcome.ok) throw new Error(outcome.refusal.message)
    const claim = session.listNodes().find((node) => node.type === 'claim')
    expect(claim).toBeDefined()
    const published = await session.publish({ root: claim!.nodeId })
    if (!published.ok) throw new Error(published.refusal.message)
    const reader = session.forActor('actor_human_reader', 'Reader')
    expect(reader.publicationView(published.publication.id)?.nodes).toMatchObject([
      { nodeId: claim!.nodeId, confirmation: 'delegation' },
    ])
  })

  it('stops at revocation, keeping what it already decided until undone', async () => {
    const delegation = await session.grantDelegation('*')
    const first = await session.propose(state('q_order', 'confidence', 'high'), AGENT)
    await session.revokeDelegation(delegation.id)
    const second = await session.propose(state('q_order', 'articulation', 'high'), AGENT)
    expect(second.ok && second.delegated).toBeFalsy()
    expect(session.understandingOf('q_order')).toEqual([{ id: 'confidence', level: 'high' }])

    if (!first.ok) throw new Error('refused')
    const undone = await session.undoDelegated(first.suggestion.id)
    expect(undone.revoked).toHaveLength(1)
    expect(session.understandingOf('q_order')).toEqual([])
    expect(session.reviews().map((review) => review.outcome)).toEqual(['accepted', 'undone'])
    expect(session.delegations()[0]?.revokedAt).toBeDefined()
  })

  it('is its grantor’s alone: another person’s proposals still wait', async () => {
    await session.grantDelegation('*')
    const other = session.forActor('actor_human_other', 'Other')
    await other.addNode({ id: 'q_theirs', label: 'Theirs', kind: 'question' })
    const result = await other.propose(state('q_theirs', 'confidence', 'high'), AGENT)
    expect(result.ok && result.delegated).toBeFalsy()
    expect(other.pendingSuggestions()).toHaveLength(1)
  })
})

describe('over the service', () => {
  let service: EpistemeService

  beforeEach(async () => {
    await session.close()
    session = await CognitiveSession.open({})
    service = await startService({ port: 0, graph: join(directory, 'served.jsonl') })
  })

  afterEach(async () => {
    await service.close()
  })

  async function post(path: string, body: unknown, token?: string) {
    const response = await fetch(`${service.apiUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }

  it('needs the person’s token to grant, and tells an agent its proposal was accepted for the learner', async () => {
    expect((await post('/delegations', { scope: '*' })).status).toBe(401)
    expect((await post('/delegations', { scope: '*' }, service.humanToken)).status).toBe(200)

    const agent = mcpWire(() => service.mcpUrl, { name: 'Plain Host', version: '1' })
    const proposed = await agent.call('propose', {
      kind: 'state',
      target: 'q_why_order',
      dimension: 'confidence',
      level: 'medium',
      rationale: 'r',
    })
    expect(proposed.structuredContent).toMatchObject({ status: 'accepted', by: 'delegation' })

    const reviews = await fetch(`${service.apiUrl}/reviews?channel=delegation`)
    const listed = (await reviews.json()) as { reviews: { suggestionId: string }[] }
    expect(listed.reviews).toHaveLength(1)
    const undone = await post(
      `/reviews/${listed.reviews[0]?.suggestionId}/undo`,
      {},
      service.humanToken,
    )
    expect(undone.status).toBe(200)
  })
})
