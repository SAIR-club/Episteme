import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CognitiveSession, type Suggestion } from '@episteme/application'
import { startService, type EpistemeService } from '@episteme/service'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mcpWire } from './mcp-wire.js'

/**
 * A scope travels with a suggestion and lands as a `scope:<id>` tag when the suggestion becomes a node
 * (ADR 0015, decision 6): from `propose`, from `distill`, by the person or under a delegation.
 */

const AGENT = { proposedBy: 'actor_agent_test', rationale: 'r' }
const DIALOGUE = '学生：为什么需要位置编码？\n老师：因为自注意力本身不区分词的顺序。'

let directory: string
let session: CognitiveSession

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-scope-'))
  session = await CognitiveSession.open({
    filePath: join(directory, 'graph.jsonl'),
  })
})

afterEach(async () => {
  await session.close()
  await rm(directory, { recursive: true, force: true })
})

const tagsOf = (nodeId: string): readonly string[] => session.graph.getNode(nodeId)?.tags ?? []

async function nodeOf(suggestion: Suggestion, decision: Parameters<typeof session.decide>[1]) {
  const decided = await session.decide(suggestion.id, decision, 'learn-review')
  if (!decided.ok || decided.outcome === 'dismissed') throw new Error('not decided')
  if (decided.committed.kind !== 'node') throw new Error('not a node')
  return decided.committed.id
}

describe('propose with a scope', () => {
  it('tags the node when the person accepts it', async () => {
    const proposed = await session.propose(
      { kind: 'claim', label: 'Order matters' },
      { ...AGENT, scope: 'ml-2026' },
    )
    if (!proposed.ok) throw new Error(proposed.refusal.message)
    expect(proposed.suggestion.scope).toBe('ml-2026')
    expect(tagsOf(await nodeOf(proposed.suggestion, { action: 'accept' }))).toContain(
      'scope:ml-2026',
    )
  })

  it('keeps the scope when the person rewords it before accepting', async () => {
    const proposed = await session.propose(
      { kind: 'claim', label: 'Order matters' },
      { ...AGENT, scope: 'ml-2026' },
    )
    if (!proposed.ok) throw new Error(proposed.refusal.message)
    const id = await nodeOf(proposed.suggestion, {
      action: 'modify',
      proposal: { kind: 'claim', label: 'Word order matters to attention' },
    })
    expect(session.graph.getNode(id)?.label).toBe('Word order matters to attention')
    expect(tagsOf(id)).toContain('scope:ml-2026')
  })

  it('tags the node when it is accepted under a delegation', async () => {
    await session.grantDelegation('ml-2026')
    const proposed = await session.propose(
      { kind: 'claim', label: 'Order matters' },
      { ...AGENT, scope: 'ml-2026' },
    )
    if (!proposed.ok || proposed.delegated?.ok !== true) throw new Error('not delegated')
    if (proposed.delegated.outcome === 'dismissed') throw new Error('dismissed')
    const committed = proposed.delegated.committed
    if (committed.kind !== 'node') throw new Error('not a node')
    expect(tagsOf(committed.id)).toContain('scope:ml-2026')
  })

  it('adds no scope tag when none was given', async () => {
    const proposed = await session.propose({ kind: 'claim', label: 'Order matters' }, AGENT)
    if (!proposed.ok) throw new Error(proposed.refusal.message)
    expect(proposed.suggestion.scope).toBeUndefined()
    const tags = tagsOf(await nodeOf(proposed.suggestion, { action: 'accept' }))
    expect(tags.some((tag) => tag.startsWith('scope:'))).toBe(false)
  })

  it('refuses a bad scope with invalid_scope, keeping nothing', async () => {
    for (const scope of ['', '   ', '*', 'x'.repeat(101), 'a\nb']) {
      const result = await session.propose(
        { kind: 'claim', label: 'Order matters' },
        { ...AGENT, scope },
      )
      expect(result).toMatchObject({
        ok: false,
        refusal: { code: 'invalid_scope' },
      })
    }
    expect(session.pendingSuggestions()).toEqual([])
  })

  it('makes recall with that scope prefer the accepted node', async () => {
    for (let index = 0; index < 6; index += 1) {
      await session.addNode({
        label: `Attention head note ${index}`,
        kind: 'claim',
      })
    }
    await session.addNode({
      id: 'k_general',
      label: 'Attention needs position information',
      kind: 'claim',
    })
    const proposed = await session.propose(
      {
        kind: 'claim',
        label: 'Attention needs position information in this course',
      },
      { ...AGENT, scope: 'ml-2026' },
    )
    if (!proposed.ok) throw new Error(proposed.refusal.message)
    const id = await nodeOf(proposed.suggestion, { action: 'accept' })
    const scoped = await session.recall('why does attention need position information', {
      scope: 'ml-2026',
    })
    expect(scoped.ranked[0]?.nodeId).toBe(id)
    expect(scoped.ranked[0]?.reasons.map((reason) => reason.signal)).toContain('scope')
  })
})

describe('distill with a scope', () => {
  it('tags every node accepted from it', async () => {
    const outcome = await session.distill({ text: DIALOGUE }, { scope: 'ml-2026' })
    if (!outcome.ok) throw new Error(outcome.refusal.message)
    expect(outcome.suggestions.length).toBeGreaterThan(0)
    expect(outcome.suggestions.every((suggestion) => suggestion.scope === 'ml-2026')).toBe(true)
    let nodes = 0
    for (const suggestion of outcome.suggestions) {
      if (suggestion.proposal.kind !== 'node' && suggestion.proposal.kind !== 'claim') continue
      const decided = await session.decide(suggestion.id, { action: 'accept' }, 'learn-review')
      if (!decided.ok || decided.outcome === 'dismissed' || decided.committed.kind !== 'node')
        continue
      expect(tagsOf(decided.committed.id)).toContain('scope:ml-2026')
      nodes += 1
    }
    expect(nodes).toBeGreaterThan(0)
  })

  it('tags the nodes of a distillation decided under a delegation', async () => {
    await session.grantDelegation('ml-2026')
    const outcome = await session.distill({ text: DIALOGUE }, { scope: 'ml-2026' })
    if (!outcome.ok) throw new Error(outcome.refusal.message)
    expect(session.pendingSuggestions()).toEqual([])
    const scoped = session
      .listNodes()
      .filter((node) => tagsOf(node.nodeId).includes('scope:ml-2026'))
    expect(scoped.length).toBeGreaterThan(0)
  })

  it('adds no scope tag without one', async () => {
    const outcome = await session.distill({ text: DIALOGUE })
    if (!outcome.ok) throw new Error(outcome.refusal.message)
    expect(outcome.suggestions.some((suggestion) => suggestion.scope !== undefined)).toBe(false)
  })

  it('refuses a bad scope before keeping anything', async () => {
    const outcome = await session.distill({ text: DIALOGUE }, { scope: '*' })
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { code: 'invalid_scope' },
    })
    expect(session.pendingSuggestions()).toEqual([])
  })
})

describe('distilling a thread', () => {
  async function threadIn(scope: string | undefined): Promise<string> {
    const thread = await session.openThread({
      title: '位置编码',
      ...(scope === undefined ? {} : { scope }),
    })
    await session.appendTurn(thread.id, { speaker: 'learner', text: '为什么需要位置编码？' })
    await session.appendTurn(thread.id, {
      speaker: 'agent',
      text: '因为自注意力本身不区分词的顺序。',
    })
    return thread.id
  }

  it('uses the thread’s own scope when none is given', async () => {
    const outcome = await session.distillThread(await threadIn('ml-2026'))
    if (!outcome.ok) throw new Error(outcome.refusal.message)
    expect(outcome.suggestions.length).toBeGreaterThan(0)
    expect(outcome.suggestions.every((suggestion) => suggestion.scope === 'ml-2026')).toBe(true)
  })

  it('lets a scope given by the caller win over the thread’s', async () => {
    const outcome = await session.distillThread(await threadIn('ml-2026'), { scope: 'stats-101' })
    if (!outcome.ok) throw new Error(outcome.refusal.message)
    expect(outcome.suggestions.every((suggestion) => suggestion.scope === 'stats-101')).toBe(true)
  })

  it('has no scope for a thread opened without one', async () => {
    const outcome = await session.distillThread(await threadIn(undefined))
    if (!outcome.ok) throw new Error(outcome.refusal.message)
    expect(outcome.suggestions.some((suggestion) => suggestion.scope !== undefined)).toBe(false)
  })

  it('openThread refuses an invalid scope', async () => {
    await expect(session.openThread({ title: 't', scope: '*' })).rejects.toMatchObject({
      code: 'invalid_scope',
    })
  })

  it('distillThread refuses an invalid scope override', async () => {
    const thread = await session.openThread({ title: 't', scope: 'stats-101' })
    const outcome = await session.distillThread(thread.id, { scope: '*' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected refusal')
    expect(outcome.refusal.code).toBe('invalid_scope')
  })

  it('grantDelegation accepts * and valid scopes, and refuses an invalid scope', async () => {
    await expect(session.grantDelegation('*')).resolves.toMatchObject({ scope: '*' })
    await expect(session.grantDelegation('stats-101')).resolves.toMatchObject({
      scope: 'stats-101',
    })
    await expect(session.grantDelegation('invalid*scope')).rejects.toMatchObject({
      code: 'invalid_scope',
    })
  })
})

describe('addNode with a scope', () => {
  it('refuses a bad one', async () => {
    await expect(session.addNode({ label: 'x', kind: 'claim', scope: ' ' })).rejects.toMatchObject({
      code: 'invalid_scope',
    })
  })
})

describe('over the wire', () => {
  let service: EpistemeService

  beforeEach(async () => {
    service = await startService({
      port: 0,
      graph: join(directory, 'served.jsonl'),
    })
  })

  afterEach(async () => {
    await service.close()
  })

  async function post(path: string, body: unknown) {
    const response = await fetch(`${service.url}/api/v1${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${service.humanToken ?? ''}`,
      },
      body: JSON.stringify(body),
    })
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    }
  }

  const state = async () =>
    (await (await fetch(`${service.url}/api/v1/state`)).json()) as {
      nodes: { nodeId: string; tags?: string[] }[]
    }

  it('POST /nodes takes a scope for a node added by hand, and refuses a bad one', async () => {
    const added = await post('/nodes', {
      label: 'Mine',
      kind: 'claim',
      scope: 'ml-2026',
    })
    expect(added.status).toBe(200)
    const mine = (await state()).nodes.find(
      (node) => node.nodeId === (added.body['node'] as { nodeId: string }).nodeId,
    )
    expect(mine?.tags).toContain('scope:ml-2026')

    const bad = await post('/nodes', {
      label: 'Mine',
      kind: 'claim',
      scope: '*',
    })
    expect(bad.status).toBe(422)
    expect(JSON.stringify(bad.body)).toContain('invalid_scope')
  })

  it('REST distill with a scope, then accept, tags the node; MCP takes it too', async () => {
    const distilled = await post('/distill', {
      text: DIALOGUE,
      scope: 'ml-2026',
    })
    expect(distilled.status).toBe(200)
    const node = (
      distilled.body['suggestions'] as {
        id: string
        proposal: { kind: string }
      }[]
    ).find((suggestion) => suggestion.proposal.kind === 'node')
    expect(node).toBeDefined()
    const decided = await post('/suggestions/decide', {
      id: node!.id,
      action: 'accept',
    })
    expect(decided.status).toBe(200)
    expect((await state()).nodes.some((n) => n.tags?.includes('scope:ml-2026'))).toBe(true)

    const agent = mcpWire(() => service.mcpUrl, {
      name: 'Notes Agent',
      version: '1',
    })
    const bad = await agent.call('distill', { text: DIALOGUE, scope: '*' })
    expect(bad.isError).toBe(true)
    const proposed = await agent.call('propose', {
      kind: 'claim',
      label: 'Order matters',
      rationale: 'r',
      scope: 'ml-2026',
    })
    expect(proposed.isError).toBeUndefined()
    expect(proposed.structuredContent?.['suggestion']).toMatchObject({
      scope: 'ml-2026',
    })
  })
})
