import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addPerson,
  addToken,
  BLANK_TOPIC,
  startService,
  type EpistemeService,
  type SceneProfile,
  type SceneRoute,
} from '@episteme/service'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testScene } from './test-scene.js'

/**
 * Who may use a scene's routes when the scene says nothing about them (ADR 0020): its writes stay the person's, its
 * reads are open to anyone with a credential, and an agent reaches a write only when the scene names the route.
 */

interface Reply {
  readonly status: number
  readonly body: Record<string, unknown>
}

async function post(
  service: EpistemeService,
  path: string,
  body: unknown,
  token?: string,
): Promise<Reply> {
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

async function get(service: EpistemeService, path: string, token?: string): Promise<Reply> {
  const response = await fetch(`${service.apiUrl}${path}`, {
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

let directory: string
let service: EpistemeService | undefined

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-scene-routes-'))
})

afterEach(async () => {
  await service?.close()
  service = undefined
  await rm(directory, { recursive: true, force: true })
})

describe('a scene that says nothing about its routes', () => {
  const ECHO: SceneRoute = {
    method: 'POST',
    path: '/echo',
    handle: ({ body }) => ({ echoed: body }),
  }
  const profile = (overrides: Partial<SceneProfile> = {}): SceneProfile => ({
    name: 'plain',
    seed: BLANK_TOPIC,
    scene: testScene,
    routes: [ECHO, { method: 'GET', path: '/state', handle: () => ({ ok: true }) }],
    ...overrides,
  })

  async function start(
    overrides?: Partial<SceneProfile>,
  ): Promise<{ on: EpistemeService; agent: string; human: string }> {
    const users = join(directory, 'users.json')
    const actor = await addPerson(users, 'alice')
    const human = await addToken(users, actor, 'human', 'workspace')
    const agent = await addToken(users, actor, 'agent', 'host')
    service = await startService({
      graph: join(directory, 'plain.db'),
      port: 0,
      mode: 'shared',
      users,
      publicOrigin: 'http://127.0.0.1:1',
      profile: profile(overrides),
    })
    return { on: service, agent, human }
  }

  it('leaves its writes to the person and its reads to anyone with a credential', async () => {
    const { on, agent, human } = await start()
    expect((await post(on, '/scene/plain/echo', {}, agent)).status).toBe(403)
    expect((await post(on, '/scene/plain/echo', {}, human)).status).toBe(200)
    expect((await get(on, '/scene/plain/state', agent)).status).toBe(200)
  })

  it('opens a route to agents only by naming it', async () => {
    const { on, agent } = await start({ proposingRoutes: ['/echo'] })
    expect((await post(on, '/scene/plain/echo', { said: 1 }, agent)).status).toBe(200)
  })

  it('refuses a token nobody issued the same as none', async () => {
    const { on } = await start()
    expect((await post(on, '/scene/plain/echo', {}, 'not-a-token')).status).toBe(401)
    expect((await post(on, '/scene/plain/echo', {})).status).toBe(401)
  })
})
