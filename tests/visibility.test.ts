import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  asId,
  isNodeVisible,
  visibleTo,
  type ActorId,
  type EpistemeError,
  type NodeId,
} from '@episteme/core'
import { humanActor } from '@episteme/sdk'
import { addPerson, addToken, startService, type EpistemeService } from '@episteme/service'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DIMENSION, NODE, EDGE, createFixture, dimensions, learnTags, level } from './fixtures.js'
import { mcpWire, type McpWire } from './mcp-wire.js'

/**
 * What one person may see of a shared graph (ADR 0014, steps S2 and S3).
 *
 * A node is visible to a person when they wrote it, when it is reference material, or when they hold state on
 * it. One function says so, and every read goes through it: here checked in Core, and then through every read
 * a second person has, over REST and MCP.
 */

describe('the visibility rule, in Core', () => {
  const B = asId<ActorId>('actor_human_b')

  function graphOfTwo() {
    const context = createFixture()
    context.registerActor(humanActor(B, 'B'))
    const node = (id: string, actorId: ActorId, tier: 'thought' | 'reference') =>
      context.graph.addNode({
        id: asId<NodeId>(id),
        type: tier === 'reference' ? NODE.concept : NODE.claim,
        label: id,
        properties: { text: id },
        tags: learnTags('transformer'),
        tier,
        source: 'session:1',
        actorId,
      })
    node('a_private', context.humanId, 'thought')
    node('a_reference', context.humanId, 'reference')
    node('b_private', B, 'thought')
    const edge = (id: string, from: string, to: string, actorId: ActorId) =>
      context.graph.addEdge({
        id: asId(id),
        type: EDGE.refersTo,
        from: asId<NodeId>(from),
        to: asId<NodeId>(to),
        actorId,
      })
    edge('a_edge', 'a_private', 'a_reference', context.humanId)
    edge('b_edge', 'b_private', 'a_reference', B)
    return context
  }

  it('shows each person their own nodes and reference material, and nothing of the other’s', () => {
    const context = graphOfTwo()
    const ids = (actor: ActorId) =>
      visibleTo(context.graph, actor)
        .listNodes()
        .map((node) => node.id)
        .sort()
    expect(ids(context.humanId)).toEqual(['a_private', 'a_reference'])
    expect(ids(B)).toEqual(['a_reference', 'b_private'])

    const forB = visibleTo(context.graph, B)
    expect(forB.getNode('a_private')).toBeUndefined()
    expect(forB.edgesOf('a_reference').map((edge) => edge.id)).toEqual(['b_edge'])
    expect(forB.neighbors('a_private')).toEqual({ incoming: [], outgoing: [] })
    expect(forB.getEdge('a_edge')).toBeUndefined()
    expect(forB.stats()).toEqual({ nodes: 2, edges: 1 })
  })

  it('keeps a node visible to someone who holds state on it', () => {
    const context = graphOfTwo()
    const node = context.graph.getNode('a_private')!
    const facts = { isNodePublished: () => false, isEdgePublished: () => false }
    expect(isNodeVisible(node, B, { ...facts, hasState: () => false })).toBe(false)
    expect(
      isNodeVisible(node, B, {
        ...facts,
        hasState: (target, actor) => target === node.id && actor === B,
      }),
    ).toBe(true)
  })

  it('refuses a person’s state on a node they cannot see, and allows it on reference material', () => {
    const context = graphOfTwo()
    let refusal: EpistemeError | undefined
    try {
      context.log.commit({
        target: asId<NodeId>('a_private'),
        actorId: B,
        dimensions: dimensions([DIMENSION.confidence, level('high')]),
      })
    } catch (error) {
      refusal = error as EpistemeError
    }
    expect(refusal?.code).toBe('guard_rejected')
    expect(context.log.hasState(asId<NodeId>('a_private'), B)).toBe(false)

    context.log.commit({
      target: asId<NodeId>('a_reference'),
      actorId: B,
      dimensions: dimensions([DIMENSION.confidence, level('low')]),
    })
    expect(context.log.hasState(asId<NodeId>('a_reference'), B)).toBe(true)
  })

  it('leaves an agent’s state alone: it is its own axis, not a person’s private space', () => {
    const context = graphOfTwo()
    context.log.commit({
      target: asId<NodeId>('a_private'),
      actorId: context.agentId,
      dimensions: dimensions([DIMENSION.confidence, level('low')]),
    })
    expect(context.log.hasState(asId<NodeId>('a_private'), context.agentId)).toBe(true)
  })
})

describe('isolation through every read, in a shared service', () => {
  const SECRET = 'Lin thinks positional encoding is optional'
  const MATERIAL = '学生：位置编码可以省略吗？\n老师：不能，自注意力本身不区分词的顺序。'

  let directory: string
  let service: EpistemeService
  let lin: { human: string; agent: string }
  let wei: { human: string; agent: string }
  let linAgent: McpWire
  let weiAgent: McpWire
  let secretNode: string

  async function call(path: string, token: string, body?: unknown) {
    const response = await fetch(`${service.apiUrl}${path}`, {
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
    })
    return { status: response.status, text: await response.text() }
  }

  async function asAgent(
    wire: McpWire,
    token: string,
    name: string,
    args: Record<string, unknown>,
  ) {
    return wire.call(name, args, {}, { headers: { authorization: `Bearer ${token}` } })
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'episteme-isolation-'))
    const users = join(directory, 'users.json')
    const linId = await addPerson(users, 'Lin')
    const weiId = await addPerson(users, 'Wei')
    lin = {
      human: await addToken(users, linId, 'human', 'workspace'),
      agent: await addToken(users, linId, 'agent', 'claude-code'),
    }
    wei = {
      human: await addToken(users, weiId, 'human', 'workspace'),
      agent: await addToken(users, weiId, 'agent', 'claude-code'),
    }
    service = await startService({
      port: 0,
      graph: join(directory, 'shared.jsonl'),
      mode: 'shared',
      users,
      publicOrigin: 'https://episteme.example.edu',
    })
    linAgent = mcpWire(() => service.mcpUrl, { name: 'Lin Host', version: '1' })
    weiAgent = mcpWire(() => service.mcpUrl, { name: 'Wei Host', version: '1' })

    // Lin writes a private claim, records her understanding of it, and her agent proposes and distills.
    const added = await call('/nodes', lin.human, { label: SECRET })
    expect(added.status).toBe(200)
    secretNode = (JSON.parse(added.text) as { node: { nodeId: string } }).node.nodeId
    expect(
      (await call('/record', lin.human, { target: secretNode, dimensions: { confidence: 'high' } }))
        .status,
    ).toBe(200)
    expect(
      (
        await asAgent(linAgent, lin.agent, 'propose', {
          kind: 'state',
          target: secretNode,
          dimension: 'articulation',
          level: 'medium',
          rationale: 'she explained it',
        })
      ).isError,
    ).toBeUndefined()
    expect(
      (await asAgent(linAgent, lin.agent, 'distill', { text: MATERIAL })).isError,
    ).toBeUndefined()
  })

  afterEach(async () => {
    await service.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('lets Lin see her own work', async () => {
    const state = await call('/state', lin.human)
    expect(state.text).toContain(SECRET)
    expect(state.text).toContain('位置编码可以省略吗')
  })

  it('shows Wei none of it, through any REST read', async () => {
    for (const path of ['/state', '/suggestions', '/reflect', '/reviews', '/vocabulary']) {
      const answer = await call(path, wei.human)
      expect({ path, status: answer.status }).toEqual({ path, status: 200 })
      expect({
        path,
        leaks: answer.text.includes(SECRET) || answer.text.includes(secretNode),
      }).toEqual({
        path,
        leaks: false,
      })
      expect(answer.text.includes('位置编码可以省略吗')).toBe(false)
    }
    const recalled = await call('/recall', wei.human, {
      question: 'is positional encoding optional',
    })
    expect(recalled.text.includes(SECRET)).toBe(false)
    expect((await call(`/nodes/${secretNode}/history`, wei.human)).status).toBe(404)
  })

  it('shows Wei’s agent none of it, through any MCP read', async () => {
    for (const [name, args] of [
      ['recall', { question: 'is positional encoding optional' }],
      ['reflect', {}],
    ] as const) {
      const answer = await asAgent(weiAgent, wei.agent, name, args)
      const text = JSON.stringify(answer)
      expect({ name, leaks: text.includes(SECRET) || text.includes(secretNode) }).toEqual({
        name,
        leaks: false,
      })
    }
  })

  it('does not let Wei decide, record on or propose about Lin’s work', async () => {
    const [linDraft] = (
      JSON.parse((await call('/suggestions', lin.human)).text) as { suggestions: { id: string }[] }
    ).suggestions
    const decided = await call('/suggestions/decide', wei.human, {
      id: linDraft?.id,
      action: 'accept',
    })
    expect(decided.status).toBe(422)
    expect(decided.text).toContain('unknown_suggestion')

    const recorded = await call('/record', wei.human, {
      target: secretNode,
      dimensions: { confidence: 'low' },
    })
    expect(recorded.status).toBe(422)

    const proposed = await asAgent(weiAgent, wei.agent, 'propose', {
      kind: 'state',
      target: secretNode,
      dimension: 'confidence',
      level: 'low',
      rationale: 'r',
    })
    expect(proposed.isError).toBe(true)

    // Lin's draft is still hers, and still pending.
    expect((await call('/suggestions', lin.human)).text).toContain(linDraft?.id ?? '')
  })

  it('keeps distilled material apart: the same words from Wei are a source of his own', async () => {
    const answer = await asAgent(weiAgent, wei.agent, 'distill', { text: MATERIAL })
    expect(answer.isError).toBeUndefined()
    const weiState = await call('/state', wei.human)
    const linState = await call('/state', lin.human)
    const weiIds = (JSON.parse(weiState.text) as { suggestions: { id: string }[] }).suggestions.map(
      (suggestion) => suggestion.id,
    )
    const linIds = (JSON.parse(linState.text) as { suggestions: { id: string }[] }).suggestions.map(
      (suggestion) => suggestion.id,
    )
    expect(weiIds.length).toBeGreaterThan(0)
    expect(weiIds.filter((id) => linIds.includes(id))).toEqual([])
  })
})
