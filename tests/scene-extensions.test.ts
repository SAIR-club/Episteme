import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SessionRefusal,
  defaultDistillationPolicy,
  defaultSessionPack,
  recordableDimensions,
  type SceneView,
  type SessionScene,
} from '@episteme/application'
import {
  asId,
  defineDomainPack,
  type DimensionId,
  type StateDimensionDefinition,
} from '@episteme/core'
import {
  startService,
  type EpistemeService,
  type SceneProfile,
  type SceneRoute,
  type SceneTool,
} from '@episteme/service'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mcpWire, type McpWire } from './mcp-wire.js'

/**
 * The application takes its scene from the profile, and a scene can add MCP tools and REST routes that never
 * reach a way to decide or write (ADR 0013, step M3 and scene extensions).
 *
 * The scene here records nothing Learn records: one dimension, `stance`, of its own.
 */

const STANCE: StateDimensionDefinition = {
  id: asId<DimensionId>('stance'),
  label: 'Stance',
  kind: 'categorical',
  levels: ['agree', 'disagree', 'unsure'],
}

const DEBATE_SCENE: SessionScene = {
  name: 'debate',
  // The session still writes the node and edge types of the default pack, so the scene composes with it and
  // adds its own dimension. Which dimensions are recordable is the scene's alone.
  packs: [defaultSessionPack, defineDomainPack('debate', { stateDimensions: [STANCE] })],
  distillationPolicy: defaultDistillationPolicy,
  recordableDimensions: recordableDimensions(
    [STANCE],
    [
      {
        id: STANCE.id,
        labelZh: '立场',
        levelLabelsZh: { agree: '同意', disagree: '反对', unsure: '不确定' },
        description: 'Where you stand on it.',
        descriptionZh: '你对它持什么立场。',
      },
    ],
  ),
}

/** The view each extension was handed, so a test can check what it holds. */
const handed: SceneView[] = []

const NODE_COUNT: SceneTool = {
  name: 'node_count',
  title: 'Count nodes',
  description: 'How many nodes the person can see.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  readOnly: true,
  handle: (_args, { view }) => {
    handed.push(view)
    const count = view.listNodes().length
    return { text: `${count} nodes`, structured: { count } }
  },
}

const SUGGEST_STANCE: SceneTool = {
  name: 'suggest_stance',
  title: 'Suggest a stance',
  description: 'Proposes a stance on a node; the person decides.',
  inputSchema: {
    type: 'object',
    properties: { target: { type: 'string' }, level: { type: 'string' } },
    required: ['target', 'level'],
    additionalProperties: false,
  },
  readOnly: false,
  handle: async (args, { view, agent }) => {
    const outcome = await view.propose(
      {
        kind: 'state',
        target: String(args['target']),
        dimension: 'stance',
        level: String(args['level']),
      },
      { proposedBy: agent, rationale: 'from a scene tool' },
    )
    if (!outcome.ok) throw new SessionRefusal(outcome.refusal.code, outcome.refusal.message)
    return { text: 'proposed', structured: { suggestion: outcome.suggestion.id } }
  },
}

const ROUTES: readonly SceneRoute[] = [
  {
    method: 'GET',
    path: '/summary',
    handle: ({ view, query }) => {
      handed.push(view)
      return { nodes: view.listNodes().length, topic: query.get('topic') }
    },
  },
  {
    method: 'POST',
    path: '/echo',
    handle: ({ body }) => ({ echoed: body }),
  },
  {
    method: 'POST',
    path: '/refuse',
    handle: () => {
      throw new SessionRefusal('scene_says_no', 'this scene refuses')
    },
  },
]

function debateProfile(overrides: Partial<SceneProfile> = {}): SceneProfile {
  return {
    name: 'debate',
    seed: {
      title: 'debate',
      nodes: [{ id: 'q_motion', label: 'Is the motion right?', kind: 'question' }],
    },
    scene: DEBATE_SCENE,
    mcpTools: [NODE_COUNT, SUGGEST_STANCE],
    routes: ROUTES,
    ...overrides,
  }
}

let directory: string
let service: EpistemeService
let agent: McpWire

async function api(
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(
    `${service.apiUrl}${path}`,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
  )
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

beforeEach(async () => {
  handed.length = 0
  directory = await mkdtemp(join(tmpdir(), 'episteme-scene-'))
  service = await startService({
    port: 0,
    graph: join(directory, 'debate.jsonl'),
    profile: debateProfile(),
  })
  agent = mcpWire(() => service.mcpUrl, { name: 'Scene Agent', version: '1' })
})

afterEach(async () => {
  await service.close()
  await rm(directory, { recursive: true, force: true })
})

describe('a session takes its scene from the profile', () => {
  it('offers only the scene’s recordable dimensions', async () => {
    const state = await api('/state')
    expect((state.body['dimensions'] as { id: string }[]).map((dimension) => dimension.id)).toEqual(
      ['stance'],
    )

    const vocabulary = await api('/vocabulary')
    const recordable = (vocabulary.body['dimensions'] as { id: string; recordable: boolean }[])
      .filter((dimension) => dimension.recordable)
      .map((dimension) => dimension.id)
    expect(recordable).toEqual(['stance'])
  })

  it('records the scene’s dimension and refuses one it does not offer', async () => {
    expect(
      (await api('/record', { target: 'q_motion', dimensions: { stance: 'agree' } })).status,
    ).toBe(200)
    const refused = await api('/record', { target: 'q_motion', dimensions: { confidence: 'high' } })
    expect(refused.status).toBe(422)
    expect(refused.body['code']).toBe('not_recordable')
  })

  it('tells an agent the scene’s dimensions in the propose tool', async () => {
    const { body } = await agent.rpc('tools/list')
    const tools = (
      body['result'] as { tools: { name: string; inputSchema: Record<string, unknown> }[] }
    ).tools
    const propose = tools.find((tool) => tool.name === 'propose')
    const properties = propose?.inputSchema['properties'] as Record<string, { enum?: string[] }>
    expect(properties['dimension']?.enum).toEqual(['stance'])
  })
})

describe('scene MCP tools', () => {
  it('are offered beside the built-in tools and answer through the scene view', async () => {
    const { body } = await agent.rpc('tools/list')
    const names = (body['result'] as { tools: { name: string }[] }).tools.map((tool) => tool.name)
    expect(names.sort()).toEqual([
      'distill',
      'node_count',
      'propose',
      'recall',
      'reflect',
      'suggest_stance',
    ])

    const counted = await agent.call('node_count', {})
    expect(counted.isError).toBeUndefined()
    expect(counted.structuredContent).toEqual({ count: 1 })
  })

  it('can propose, under the calling agent’s name, and the person still decides', async () => {
    const proposed = await agent.call('suggest_stance', { target: 'q_motion', level: 'disagree' })
    expect(proposed.isError).toBeUndefined()

    const pending = await api('/suggestions')
    const suggestions = pending.body['suggestions'] as { proposedBy: string }[]
    expect(suggestions.map((suggestion) => suggestion.proposedBy)).toEqual([
      'actor_agent_scene-agent',
    ])
    const state = await api('/state')
    expect((state.body['understanding'] as Record<string, unknown[]>)['q_motion']).toEqual([])
  })

  it('answer a refusal as a refusal', async () => {
    const refused = await agent.call('suggest_stance', { target: 'q_motion', level: 'high' })
    expect(refused.isError).toBe(true)
    expect(refused.structuredContent?.['code']).toBe('invalid_dimension_value')
  })
})

describe('scene REST routes', () => {
  it('are served under /api/v1/scene/<name> with the query and body', async () => {
    const summary = await api('/scene/debate/summary?topic=motions')
    expect(summary.status).toBe(200)
    expect(summary.body).toMatchObject({ nodes: 1, topic: 'motions' })

    const echoed = await api('/scene/debate/echo', { hello: 'world' })
    expect(echoed.body).toMatchObject({ echoed: { hello: 'world' } })
  })

  it('answer a refusal with 422 and an unknown path with 404', async () => {
    const refused = await api('/scene/debate/refuse', {})
    expect(refused.status).toBe(422)
    expect(refused.body['code']).toBe('scene_says_no')

    expect((await api('/scene/debate/nothing')).status).toBe(404)
    expect((await api('/scene/learn/summary')).status).toBe(404)
  })
})

describe('what an extension is handed', () => {
  it('can read, propose and distill, and holds nothing that decides or writes', async () => {
    await agent.call('node_count', {})
    await api('/scene/debate/summary')
    expect(handed).toHaveLength(2)

    for (const view of handed) {
      expect(Object.keys(view).sort()).toEqual([
        'distill',
        'historyOf',
        'listNodes',
        'pendingSuggestions',
        'progress',
        'propose',
        'recall',
        'recordableDimensions',
        'sceneName',
        'understandingOf',
        'vocabulary',
      ])
      for (const forbidden of ['decide', 'record', 'addNode', 'link', 'graph', 'log', 'close']) {
        expect(forbidden in view).toBe(false)
      }
      expect(Object.isFrozen(view)).toBe(true)
    }
  })
})

describe('a profile that cannot be served', () => {
  it('is refused at start without keeping the graph', async () => {
    const graph = join(directory, 'clash.jsonl')
    await expect(
      startService({
        port: 0,
        graph,
        profile: debateProfile({ mcpTools: [{ ...NODE_COUNT, name: 'propose' }] }),
      }),
    ).rejects.toThrow(/reuses the name/)
    await expect(
      startService({
        port: 0,
        graph,
        profile: debateProfile({ routes: [{ ...ROUTES[0]!, path: 'summary' }] }),
      }),
    ).rejects.toThrow(/must start with/)

    // Neither attempt left the graph locked.
    const second = await startService({ port: 0, graph, profile: debateProfile() })
    await second.close()
  })
})
