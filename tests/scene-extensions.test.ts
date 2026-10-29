import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CognitiveSession,
  SessionRefusal,
  defaultDistillationPolicy,
  defaultSessionPack,
  recordableDimensions,
  sceneViewOf,
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
  addPerson,
  addToken,
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
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${service.humanToken ?? ''}`,
          },
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
    graph: join(directory, 'debate.db'),
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
      'expand',
      'node_count',
      'propose',
      'recall',
      'reflect',
      'suggest_stance',
      'thread_append',
      'thread_fork',
      'thread_open',
      'thread_summarize',
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
        'browsePublications',
        'distill',
        'historyOf',
        'listNodes',
        'pendingSuggestions',
        'progress',
        'propose',
        'publicationView',
        'recall',
        'recordableDimensions',
        'records',
        'sceneName',
        'threadView',
        'threads',
        'understandingOf',
        'vocabulary',
      ])
      for (const forbidden of [
        'decide',
        'record',
        'addNode',
        'link',
        'graph',
        'log',
        'close',
        'adopt',
        'publish',
        'withdrawPublication',
        'openThread',
        'appendTurn',
        'forActor',
      ]) {
        expect(forbidden in view).toBe(false)
      }
      expect(Object.isFrozen(view)).toBe(true)
    }
  })
})

describe('what a view reads of two people on one graph', () => {
  let shared: string
  let owner: CognitiveSession
  let lin: CognitiveSession
  let wei: CognitiveSession

  beforeEach(async () => {
    shared = await mkdtemp(join(tmpdir(), 'episteme-scene-view-'))
    owner = await CognitiveSession.open({ filePath: join(shared, 'shared.db'), sharing: true })
    lin = owner.forActor('actor_human_lin', 'Lin')
    wei = owner.forActor('actor_human_wei', 'Wei')
  })

  afterEach(async () => {
    await owner.close()
    await rm(shared, { recursive: true, force: true })
  })

  it('lists the caller’s own threads and never reads another person’s', async () => {
    const course = await lin.openThread({ title: 'Positions', scope: 'ml-2026' })
    await lin.appendTurn(course.id, {
      speaker: 'learner',
      text: 'Why do transformers need positions?',
    })
    const other = await lin.openThread({ title: 'Elsewhere' })
    const weis = await wei.openThread({ title: 'Wei’s own', scope: 'ml-2026' })

    const linView = sceneViewOf(lin)
    const weiView = sceneViewOf(wei)

    expect(linView.threads().map((thread) => thread.id)).toEqual(
      expect.arrayContaining([course.id, other.id]),
    )
    expect(linView.threads()).toHaveLength(2)
    expect(linView.threads('ml-2026').map((thread) => thread.id)).toEqual([course.id])
    expect(linView.threadView(course.id)?.turns.map((turn) => turn.text)).toEqual([
      'Why do transformers need positions?',
    ])

    expect(weiView.threads().map((thread) => thread.id)).toEqual([weis.id])
    expect(weiView.threads('ml-2026').map((thread) => thread.id)).toEqual([weis.id])
    expect(weiView.threadView(course.id)).toBeUndefined()
    expect(weiView.threadView(other.id)).toBeUndefined()
    expect(linView.threadView(weis.id)).toBeUndefined()
  })

  it('browses only live publications, by scope, and shows no adopter', async () => {
    const claim = (
      await lin.addNode({
        label: 'Attention alone does not encode order',
        kind: 'claim',
        scope: 'ml-2026',
      })
    ).nodeId
    const elsewhere = (await lin.addNode({ label: 'Heads specialise', kind: 'claim' })).nodeId
    const unpublished = (
      await lin.addNode({ label: 'A private hunch', kind: 'claim', scope: 'ml-2026' })
    ).nodeId
    const live = await lin.publish({ root: claim })
    const withdrawn = await lin.publish({ root: elsewhere })
    if (!live.ok || !withdrawn.ok) throw new Error('refused')
    await lin.withdrawPublication(withdrawn.publication.id)

    const weiView = sceneViewOf(wei)
    const browsed = weiView.browsePublications()
    expect(browsed.map((summary) => summary.id)).toEqual([live.publication.id])
    expect(weiView.browsePublications({ scope: 'ml-2026' }).map((summary) => summary.id)).toEqual([
      live.publication.id,
    ])
    expect(weiView.browsePublications({ scope: 'other-course' })).toEqual([])
    expect(weiView.browsePublications({ q: 'hunch' })).toEqual([])
    expect(weiView.browsePublications({ author: 'actor_human_lin' })).toHaveLength(1)
    expect(JSON.stringify(browsed)).not.toContain(unpublished)
    expect(JSON.stringify(browsed)).not.toContain(withdrawn.publication.id)

    // Adopting is the adopter's own state event, visible only to them (ADR 0014, decision 2): browsing shows
    // neither who adopted nor how many did.
    const third = owner.forActor('actor_human_qin', 'Qin')
    await wei.adopt(live.publication.id, claim, { confidence: 'high' })
    await third.adopt(live.publication.id, claim, { confidence: 'low' })
    const after = sceneViewOf(lin).browsePublications()
    expect(after).toEqual(browsed)
    expect(Object.keys(after[0] ?? {}).sort()).toEqual([
      'author',
      'createdAt',
      'id',
      'members',
      'rootLabel',
      'version',
    ])
    const text = JSON.stringify(after)
    for (const adopter of ['actor_human_wei', 'actor_human_qin']) {
      expect(text).not.toContain(adopter)
    }
  })
})

describe('a publication read through a view, on a shared service', () => {
  let sharedDirectory: string
  let sharedService: EpistemeService
  let people: Record<'lin' | 'wei' | 'qin', { id: string; token: string }>

  /** A scene route that answers with what the caller's view reads of one publication. */
  const READ_PUBLICATION: SceneRoute = {
    method: 'GET',
    path: '/publication',
    handle: ({ view, query }) => ({ view: view.publicationView(query.get('id') ?? '') ?? null }),
  }

  async function get(path: string, token: string) {
    const response = await fetch(`${sharedService.apiUrl}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }

  async function post(path: string, token: string, body: unknown) {
    const response = await fetch(`${sharedService.apiUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }

  /** A body without the revision it was read at, which every route adds. */
  function content(body: Record<string, unknown>): Record<string, unknown> {
    const { epoch: _epoch, revision: _revision, ...rest } = body
    return rest
  }

  async function viewed(id: string, token: string): Promise<unknown> {
    const answer = await get(`/scene/debate/publication?id=${encodeURIComponent(id)}`, token)
    expect(answer.status).toBe(200)
    return answer.body['view']
  }

  async function linPublishes(label: string): Promise<{ node: string; publication: string }> {
    const created = await post('/nodes', people.lin.token, { label })
    const node = (created.body['node'] as { nodeId: string }).nodeId
    const published = await post('/publications', people.lin.token, { root: node })
    expect(published.status).toBe(200)
    return { node, publication: (published.body['publication'] as { id: string }).id }
  }

  beforeEach(async () => {
    sharedDirectory = await mkdtemp(join(tmpdir(), 'episteme-scene-shared-'))
    const users = join(sharedDirectory, 'users.json')
    const person = async (name: string) => {
      const id = await addPerson(users, name)
      return { id, token: await addToken(users, id, 'human', 'workspace') }
    }
    people = { lin: await person('Lin'), wei: await person('Wei'), qin: await person('Qin') }
    sharedService = await startService({
      port: 0,
      graph: join(sharedDirectory, 'shared.db'),
      mode: 'shared',
      users,
      publicOrigin: 'https://episteme.example.edu',
      sharing: true,
      profile: debateProfile({ routes: [READ_PUBLICATION] }),
    })
  })

  afterEach(async () => {
    await sharedService.close()
    await rm(sharedDirectory, { recursive: true, force: true })
  })

  it('reads a live publication exactly as the REST route does for the same caller', async () => {
    const { publication } = await linPublishes('The motion confuses cause and effect')

    for (const caller of [people.lin, people.wei]) {
      const rest = await get(`/publications/${publication}`, caller.token)
      expect(rest.status).toBe(200)
      expect(await viewed(publication, caller.token)).toEqual(content(rest.body))
    }
    expect(await viewed('publication_nowhere', people.wei.token)).toBeNull()
  })

  it('reads a withdrawn publication as REST does: gone for others, still there for its author', async () => {
    const { publication } = await linPublishes('A position I take back')
    expect((await post(`/publications/${publication}/withdraw`, people.lin.token, {})).status).toBe(
      200,
    )

    expect((await get(`/publications/${publication}`, people.wei.token)).status).toBe(404)
    expect(await viewed(publication, people.wei.token)).toBeNull()

    const rest = await get(`/publications/${publication}`, people.lin.token)
    expect(rest.body['live']).toBe(false)
    expect(await viewed(publication, people.lin.token)).toEqual(content(rest.body))
  })

  it('carries no adopter and no state level', async () => {
    const { node, publication } = await linPublishes('The motion confuses cause and effect')
    const before = await viewed(publication, people.lin.token)
    for (const [adopter, level] of [
      [people.wei, 'disagree'],
      [people.qin, 'unsure'],
    ] as const) {
      const adopted = await post(`/publications/${publication}/adopt`, adopter.token, {
        node,
        dimensions: { stance: level },
      })
      expect(adopted.status).toBe(200)
    }

    for (const caller of [people.lin, people.wei, people.qin]) {
      const view = (await viewed(publication, caller.token)) as Record<string, unknown>
      // Nobody's adoption changes what the publication shows, whoever reads it.
      expect(view).toEqual(before)
      expect(Object.keys(view).sort()).toEqual([
        'edges',
        'live',
        'nodes',
        'publication',
        'threads',
        'versions',
      ])
      const text = JSON.stringify(view)
      for (const absent of [people.wei.id, people.qin.id, 'disagree', 'unsure', 'stance']) {
        expect(text).not.toContain(absent)
      }
    }
  })
})

describe('a profile that cannot be served', () => {
  it('is refused at start without keeping the graph', async () => {
    const graph = join(directory, 'clash.db')
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
