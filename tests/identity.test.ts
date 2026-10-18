import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addPerson,
  addToken,
  revokeToken,
  startService,
  type EpistemeService,
} from '@episteme/service'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mcpWire } from './mcp-wire.js'

/**
 * Who is calling (ADR 0012): every request's actor and kind come from a credential, deciding needs the person's
 * own, and an agent's credential never stands in for it, in local and in shared mode.
 *
 * None of this shows that an agent running as the person, with a shell, is kept from deciding: it can read the
 * person's token. ADR 0012 states that limit; these tests hold the service to everything short of it.
 */

const STATE = { kind: 'state', target: 'q_why_order', dimension: 'confidence', level: 'high' }

let directory: string
let service: EpistemeService

interface Answer {
  readonly status: number
  readonly body: Record<string, unknown>
  readonly cookie: string | undefined
}

async function call(
  path: string,
  options: { body?: unknown; token?: string; cookie?: string } = {},
) {
  const headers: Record<string, string> = {}
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`
  if (options.cookie !== undefined) headers['cookie'] = options.cookie
  const response = await fetch(`${service.url}${path}`, {
    ...(options.body === undefined ? {} : { method: 'POST', body: JSON.stringify(options.body) }),
    headers,
  })
  const text = await response.text()
  return {
    status: response.status,
    body: (text.startsWith('{') ? JSON.parse(text) : {}) as Record<string, unknown>,
    cookie: response.headers.get('set-cookie')?.split(';')[0],
  } satisfies Answer
}

async function events(token?: string): Promise<number> {
  return (await call('/api/v1/state', token === undefined ? {} : { token })).body[
    'events'
  ] as number
}

async function pending(token?: string): Promise<readonly { id: string; proposedBy: string }[]> {
  const answer = await call('/api/v1/suggestions', token === undefined ? {} : { token })
  return answer.body['suggestions'] as { id: string; proposedBy: string }[]
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-identity-'))
})

afterEach(async () => {
  await service?.close()
  await rm(directory, { recursive: true, force: true })
})

describe('local mode', () => {
  beforeEach(async () => {
    const workspace = join(directory, 'workspace')
    await mkdir(workspace)
    await writeFile(join(workspace, 'index.html'), '<!doctype html><title>Workspace</title>')
    service = await startService({ port: 0, graph: join(directory, 'learn.jsonl'), workspace })
  })

  it('reads, proposes and distills without a token, as every host does today', async () => {
    expect(service.mode).toBe('local')
    expect((await call('/api/v1/state')).status).toBe(200)
    const agent = mcpWire(() => service.mcpUrl, { name: 'Plain Host', version: '1' })
    const proposed = await agent.call('propose', { ...STATE, rationale: 'r' })
    expect(proposed.isError).toBeUndefined()
    expect(await pending()).toHaveLength(1)
  })

  it('refuses to decide, record or add a node without the person’s token, and changes nothing', async () => {
    const agent = mcpWire(() => service.mcpUrl, { name: 'Plain Host', version: '1' })
    await agent.call('propose', { ...STATE, rationale: 'r' })
    const [draft] = await pending()
    const before = await events()

    for (const [path, body] of [
      ['/api/v1/suggestions/decide', { id: draft?.id, action: 'accept' }],
      ['/api/v1/record', { target: 'q_why_order', dimensions: { confidence: 'high' } }],
      ['/api/v1/nodes', { label: 'a claim of mine' }],
    ] as const) {
      const refused = await call(path, { body })
      expect({ path, status: refused.status, code: refused.body['code'] }).toEqual({
        path,
        status: 401,
        code: 'unauthenticated',
      })
    }
    expect(await events()).toBe(before)
    expect(await pending()).toHaveLength(1)
  })

  it('decides with the token minted for this run', async () => {
    expect(service.humanToken).toMatch(/^ep_/)
    const recorded = await call('/api/v1/record', {
      body: { target: 'q_why_order', dimensions: { confidence: 'high' } },
      token: service.humanToken!,
    })
    expect(recorded.status).toBe(200)
  })

  it('gives the served Workspace a session cookie, which then decides; a stale one counts as none', async () => {
    const page = await call('/')
    expect(page.status).toBe(200)
    const header = (await fetch(`${service.url}/`)).headers.get('set-cookie') ?? ''
    expect(header).toMatch(/HttpOnly/)
    expect(header).toMatch(/SameSite=Strict/)

    const recorded = await call('/api/v1/record', {
      body: { target: 'q_why_order', dimensions: { confidence: 'low' } },
      cookie: page.cookie!,
    })
    expect(recorded.status).toBe(200)

    const stale = 'episteme_session=from-a-previous-run'
    expect((await call('/api/v1/state', { cookie: stale })).status).toBe(200)
    const refused = await call('/api/v1/record', {
      body: { target: 'q_why_order', dimensions: { confidence: 'low' } },
      cookie: stale,
    })
    expect(refused.status).toBe(401)
  })

  it('refuses a Bearer token it did not issue, even to read', async () => {
    const refused = await call('/api/v1/state', { token: 'ep_000000000000_' + 'x'.repeat(43) })
    expect(refused.status).toBe(401)
  })

  it('takes who decided from the credential, never from the body', async () => {
    const agent = mcpWire(() => service.mcpUrl, { name: 'Plain Host', version: '1' })
    await agent.call('propose', { ...STATE, rationale: 'r' })
    const [draft] = await pending()
    const decided = await call('/api/v1/suggestions/decide', {
      body: { id: draft?.id, action: 'dismiss', actorId: 'actor_someone_else', confirmedBy: 'x' },
      token: service.humanToken!,
    })
    expect(decided.status).toBe(200)
    const reviews = (await call('/api/v1/reviews')).body['reviews'] as {
      reviewer: { actorId: string; label: string }
    }[]
    expect(reviews.map((review) => review.reviewer)).toEqual([
      expect.objectContaining({ actorId: 'actor_human', label: 'local' }),
    ])
  })
})

describe('shared mode', () => {
  let users: string
  let actorId: string
  let human: string
  let agent: string

  beforeEach(async () => {
    users = join(directory, 'users.json')
    actorId = await addPerson(users, 'Lin')
    human = await addToken(users, actorId, 'human', 'workspace')
    agent = await addToken(users, actorId, 'agent', 'claude-code')
    service = await startService({
      port: 0,
      graph: join(directory, 'shared.jsonl'),
      mode: 'shared',
      users,
      publicOrigin: 'https://episteme.example.edu',
    })
  })

  it('refuses to start without a user file or a public origin', async () => {
    const graph = join(directory, 'other.jsonl')
    await expect(
      startService({ port: 0, graph, mode: 'shared', publicOrigin: 'https://e.example' }),
    ).rejects.toThrow(/user file/)
    await expect(startService({ port: 0, graph, mode: 'shared', users })).rejects.toThrow(
      /public origin/,
    )
  })

  it('needs a token for everything, MCP included', async () => {
    expect(service.humanToken).toBeUndefined()
    const refused = await call('/api/v1/state')
    expect(refused).toMatchObject({ status: 401, body: { code: 'unauthenticated' } })
    const anonymous = mcpWire(() => service.mcpUrl, { name: 'Anyone', version: '1' })
    expect((await anonymous.rpc('tools/list')).status).toBe(401)
  })

  it('lets an agent token read and propose, under its label, and never decide', async () => {
    expect((await call('/api/v1/state', { token: agent })).status).toBe(200)
    const host = mcpWire(() => service.mcpUrl, { name: 'Claude Code', version: '1' })
    const proposed = await host.call(
      'propose',
      { ...STATE, rationale: 'r' },
      {},
      { headers: { authorization: `Bearer ${agent}` } },
    )
    expect(proposed.isError).toBeUndefined()
    const [draft] = await pending(agent)
    expect(draft?.proposedBy).toBe('actor_agent_claude-code')

    const before = await events(agent)
    const refused = await call('/api/v1/suggestions/decide', {
      body: { id: draft?.id, action: 'accept' },
      token: agent,
    })
    expect(refused).toMatchObject({ status: 403, body: { code: 'human_required' } })
    expect(await events(agent)).toBe(before)
    expect(await pending(agent)).toHaveLength(1)
  })

  it('lets the person decide, and keeps a review naming the channel and credential', async () => {
    const host = mcpWire(() => service.mcpUrl, { name: 'Claude Code', version: '1' })
    await host.call(
      'propose',
      { ...STATE, rationale: 'r' },
      {},
      { headers: { authorization: `Bearer ${agent}` } },
    )
    const [draft] = await pending(human)
    const dismissed = await call('/api/v1/suggestions/decide', {
      body: { id: draft?.id, action: 'dismiss' },
      token: human,
    })
    expect(dismissed.status).toBe(200)
    const reviews = (await call('/api/v1/reviews', { token: human })).body['reviews']
    expect(reviews).toMatchObject([
      {
        suggestionId: draft?.id,
        outcome: 'dismissed',
        channel: 'learn-review',
        reviewer: { actorId, label: 'workspace' },
      },
    ])
  })

  it('opens a Workspace session only for the person’s own token', async () => {
    expect((await call('/api/v1/session', { body: { token: agent } })).status).toBe(403)
    const signedIn = await call('/api/v1/session', { body: { token: human } })
    expect(signedIn.status).toBe(200)
    expect(signedIn.body).toMatchObject({ actorId, label: 'workspace' })
    expect((await call('/api/v1/state', { cookie: signedIn.cookie! })).status).toBe(200)
  })

  it('refuses a revoked token at the next request', async () => {
    expect((await call('/api/v1/state', { token: agent })).status).toBe(200)
    const tokenId = agent.split('_')[1]!
    await revokeToken(users, tokenId)
    expect((await call('/api/v1/state', { token: agent })).status).toBe(401)
    expect((await call('/api/v1/state', { token: human })).status).toBe(200)
  })

  it('does not take a form answer as the person’s decision unless told to trust the host', async () => {
    const asking = mcpWire(() => service.mcpUrl, {
      name: 'Form Host',
      version: '1',
      capabilities: { elicitation: { form: {} } },
    })
    const proposed = await asking.call(
      'propose',
      { ...STATE, rationale: 'r' },
      {},
      { headers: { authorization: `Bearer ${agent}` } },
    )
    expect(proposed.resultType).not.toBe('input_required')
    expect(await pending(agent)).toHaveLength(1)
  })
})
