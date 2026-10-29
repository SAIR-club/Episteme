import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addPerson, addToken, startService, type EpistemeService } from '@episteme/service'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mcpWire } from './mcp-wire.js'

/**
 * A person's own tokens over REST (ADR 0012, decision 2): they list theirs, issue agent tokens and revoke them,
 * with their own credential only. Nothing here lets a person see a secret twice, mint a human token, or touch
 * another person's tokens.
 */

/** Any ISO time, typed so the matcher does not leak `any` into the objects it sits in. */
const A_TIME: unknown = expect.any(String)

let directory: string
let service: EpistemeService

async function call(
  path: string,
  options: { body?: unknown; token?: string; cookie?: string } = {},
): Promise<{ status: number; body: Record<string, unknown>; text: string; cookie?: string }> {
  const headers: Record<string, string> = {}
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`
  if (options.cookie !== undefined) headers['cookie'] = options.cookie
  const response = await fetch(`${service.url}${path}`, {
    ...(options.body === undefined ? {} : { method: 'POST', body: JSON.stringify(options.body) }),
    headers,
  })
  const text = await response.text()
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  return {
    status: response.status,
    body: (text.startsWith('{') ? JSON.parse(text) : {}) as Record<string, unknown>,
    text,
    ...(cookie === undefined ? {} : { cookie }),
  }
}

function idOf(token: string): string {
  return token.split('_')[1]!
}

/**
 * The secret part of `ep_<id>_<secret>`: everything after the id. The secret is base64url, which may itself
 * contain `_`, so splitting on `_` would cut it short, or leave it empty when it starts with one.
 */
function secretOf(token: string): string {
  return token.slice(`ep_${idOf(token)}_`.length)
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-agent-tokens-'))
})

afterEach(async () => {
  await service?.close()
  await rm(directory, { recursive: true, force: true })
})

describe('shared mode', () => {
  let users: string
  let lin: string
  let linHuman: string
  let linAgent: string
  let meiHuman: string
  let meiAgent: string

  beforeEach(async () => {
    users = join(directory, 'users.json')
    lin = await addPerson(users, 'Lin')
    linHuman = await addToken(users, lin, 'human', 'workspace')
    linAgent = await addToken(users, lin, 'agent', 'claude-code')
    const mei = await addPerson(users, 'Mei')
    meiHuman = await addToken(users, mei, 'human', 'workspace')
    meiAgent = await addToken(users, mei, 'agent', 'codex')
    service = await startService({
      port: 0,
      graph: join(directory, 'shared.db'),
      mode: 'shared',
      users,
      publicOrigin: 'https://episteme.example.edu',
    })
  })

  it('reads the secret part of a token even when it starts with or contains an underscore', () => {
    // base64url secrets may hold `_`; one that starts with it once made the check below compare against ''.
    expect(secretOf('ep_0123456789ab__starts-with_underscore')).toBe('_starts-with_underscore')
    expect(idOf('ep_0123456789ab__starts-with_underscore')).toBe('0123456789ab')
  })

  it('lists only the caller’s own tokens, and never a secret', async () => {
    const listed = await call('/api/v1/tokens', { token: linHuman })
    expect(listed.status).toBe(200)
    expect(listed.body['tokens']).toEqual([
      {
        id: idOf(linHuman),
        kind: 'human',
        label: 'workspace',
        createdAt: A_TIME,
        current: true,
      },
      {
        id: idOf(linAgent),
        kind: 'agent',
        label: 'claude-code',
        createdAt: A_TIME,
        current: false,
      },
    ])
    for (const secret of [linHuman, linAgent, meiHuman, meiAgent]) {
      expect(listed.text).not.toContain(secretOf(secret))
    }
    expect(listed.text).not.toContain(idOf(meiHuman))
    expect(listed.text).not.toContain(idOf(meiAgent))
    expect(listed.text).not.toMatch(/"(salt|hash|secret)"/)
  })

  it('issues an agent token whose secret is shown once; it reads, and is refused a decision', async () => {
    const issued = await call('/api/v1/tokens', { body: { label: 'codex' }, token: linHuman })
    expect(issued.status).toBe(200)
    const secret = issued.body['secret'] as string
    expect(secret).toMatch(/^ep_[0-9a-f]{12}_/)
    expect(issued.body['token']).toEqual({
      id: idOf(secret),
      kind: 'agent',
      label: 'codex',
      createdAt: A_TIME,
    })

    expect((await call('/api/v1/state', { token: secret })).status).toBe(200)
    const host = mcpWire(() => service.mcpUrl, { name: 'Codex', version: '1' })
    const tools = await host.rpc(
      'tools/list',
      {},
      { headers: { authorization: `Bearer ${secret}` } },
    )
    expect(tools.status).toBe(200)
    const refused = await call('/api/v1/record', {
      body: { target: 'c_self_attention', dimensions: { confidence: 'high' } },
      token: secret,
    })
    expect(refused).toMatchObject({ status: 403, body: { code: 'human_required' } })

    const listed = await call('/api/v1/tokens', { token: linHuman })
    expect(listed.text).not.toContain(secretOf(secret))
    expect((listed.body['tokens'] as { id: string }[]).map((token) => token.id)).toContain(
      idOf(secret),
    )

    // The file stays one the CLI reads and writes.
    const viaCli = await addToken(users, lin, 'agent', 'workbuddy')
    expect((await call('/api/v1/state', { token: viaCli })).status).toBe(200)
    expect((await call('/api/v1/state', { token: secret })).status).toBe(200)
  })

  it('never mints a human token, and wants a label', async () => {
    const human = await call('/api/v1/tokens', {
      body: { label: 'mine', kind: 'human' },
      token: linHuman,
    })
    expect(human).toMatchObject({ status: 422, body: { code: 'agent_tokens_only' } })
    for (const body of [{}, { label: '  ' }, { label: 'x'.repeat(65) }, { label: 'a\nb' }]) {
      expect((await call('/api/v1/tokens', { body, token: linHuman })).body['code']).toBe(
        'invalid_request',
      )
    }
    expect((await call('/api/v1/tokens', { token: linHuman })).body['tokens']).toHaveLength(2)
  })

  it('revokes a token so it is refused at the next request, over REST and MCP', async () => {
    const issued = await call('/api/v1/tokens', { body: { label: 'codex' }, token: linHuman })
    const secret = issued.body['secret'] as string
    const host = mcpWire(() => service.mcpUrl, { name: 'Codex', version: '1' })
    const asAgent = { headers: { authorization: `Bearer ${secret}` } }
    expect((await host.rpc('tools/list', {}, asAgent)).status).toBe(200)

    const revoked = await call(`/api/v1/tokens/${idOf(secret)}/revoke`, {
      body: {},
      token: linHuman,
    })
    expect(revoked.status).toBe(200)
    expect(revoked.body['token']).toMatchObject({
      id: idOf(secret),
      revokedAt: A_TIME,
    })

    expect((await call('/api/v1/state', { token: secret })).status).toBe(401)
    expect((await host.rpc('tools/list', {}, asAgent)).status).toBe(401)
    expect((await call('/api/v1/state', { token: linAgent })).status).toBe(200)
    const listed = (await call('/api/v1/tokens', { token: linHuman })).body['tokens'] as {
      id: string
      revokedAt?: string
    }[]
    expect(listed.find((token) => token.id === idOf(secret))?.revokedAt).toEqual(A_TIME)

    const persisted = JSON.parse(await readFile(users, 'utf8')) as { schemaVersion: number }
    expect(persisted.schemaVersion).toBe(1)
  })

  it('does not let another person revoke a token, nor say whether it exists', async () => {
    const theirs = await call(`/api/v1/tokens/${idOf(linAgent)}/revoke`, {
      body: {},
      token: meiHuman,
    })
    const nobodys = await call('/api/v1/tokens/000000000000/revoke', { body: {}, token: meiHuman })
    expect(theirs).toMatchObject({ status: 404, body: { code: 'unknown_token' } })
    expect(nobodys.status).toBe(404)
    expect(nobodys.body).toEqual(theirs.body)
    expect((await call('/api/v1/state', { token: linAgent })).status).toBe(200)
  })

  it('refuses to revoke the token the request is made with', async () => {
    const refused = await call(`/api/v1/tokens/${idOf(linHuman)}/revoke`, {
      body: {},
      token: linHuman,
    })
    expect(refused).toMatchObject({ status: 422, body: { code: 'current_credential' } })
    expect((await call('/api/v1/state', { token: linHuman })).status).toBe(200)
  })

  it('refuses every token route to an agent token', async () => {
    for (const [path, body] of [
      ['/api/v1/tokens', undefined],
      ['/api/v1/tokens', { label: 'more' }],
      [`/api/v1/tokens/${idOf(linAgent)}/revoke`, {}],
      [`/api/v1/tokens/${idOf(linHuman)}/revoke`, {}],
    ] as const) {
      const refused = await call(path, { ...(body === undefined ? {} : { body }), token: linAgent })
      expect({ path, status: refused.status, code: refused.body['code'] }).toEqual({
        path,
        status: 403,
        code: 'human_required',
      })
    }
    expect((await call('/api/v1/tokens', { token: linHuman })).body['tokens']).toHaveLength(2)
    expect((await call('/api/v1/tokens')).status).toBe(401)
  })

  it('ends a Workspace session once the token that opened it is revoked', async () => {
    const laptop = await addToken(users, lin, 'human', 'laptop')
    const session = await call('/api/v1/session', { body: { token: laptop } })
    expect((await call('/api/v1/state', { cookie: session.cookie! })).status).toBe(200)
    const revoked = await call(`/api/v1/tokens/${idOf(laptop)}/revoke`, {
      body: {},
      token: linHuman,
    })
    expect(revoked.status).toBe(200)
    expect((await call('/api/v1/state', { cookie: session.cookie! })).status).toBe(401)
  })

  it('keeps every token issued by concurrent requests', async () => {
    const labels = Array.from({ length: 8 }, (_, index) => `host-${index}`)
    const issued = await Promise.all(
      labels.map((label) => call('/api/v1/tokens', { body: { label }, token: linHuman })),
    )
    expect(issued.map((answer) => answer.status)).toEqual(labels.map(() => 200))
    const listed = (await call('/api/v1/tokens', { token: linHuman })).body['tokens'] as {
      label: string
    }[]
    expect(listed.map((token) => token.label).sort()).toEqual(
      ['claude-code', 'workspace', ...labels].sort(),
    )
    for (const answer of issued) {
      expect((await call('/api/v1/state', { token: answer.body['secret'] as string })).status).toBe(
        200,
      )
    }
  })
})

describe('local mode', () => {
  beforeEach(async () => {
    service = await startService({ port: 0, graph: join(directory, 'learn.db') })
  })

  it('needs the person’s token, and then refuses: there is no user file to manage', async () => {
    for (const [path, body] of [
      ['/api/v1/tokens', undefined],
      ['/api/v1/tokens', { label: 'codex' }],
      ['/api/v1/tokens/000000000000/revoke', {}],
    ] as const) {
      const options = body === undefined ? {} : { body }
      expect((await call(path, options)).status).toBe(401)
      const refused = await call(path, { ...options, token: service.humanToken! })
      expect({ path, status: refused.status, code: refused.body['code'] }).toEqual({
        path,
        status: 422,
        code: 'not_available_in_local_mode',
      })
    }
    expect((await call('/api/v1/state', { token: service.humanToken! })).status).toBe(200)
  })
})
