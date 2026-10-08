import { request as httpRequest } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startLearnServer, type LearnServer } from '@episteme/app-learn/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mcpWire } from './mcp-wire.js'

/**
 * The boundary of the whole Learn surface: the page, its API and the MCP endpoint behind one check.
 *
 * The surface has no authentication, so these tests play the parts a hostile web page can play: a
 * cross-site form or text POST, a fetch with its own Origin, a read through a rebound host name, an image tag
 * pointed at the API. Each is refused, and nothing it aimed at changes. The page's own requests and a client
 * that is not a browser still get through.
 */

let directory: string
let server: LearnServer

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-boundary-'))
  server = await startLearnServer({ port: 0, filePath: join(directory, 'learn.jsonl') })
})

afterEach(async () => {
  await server.close()
  await rm(directory, { recursive: true, force: true })
})

/** A raw request, with every header under the test's control, including Host. */
function raw(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      // `setHost: false`, so a request without a Host header can be sent at all; Node otherwise adds one.
      { host: '127.0.0.1', port: server.port, method, path, headers, setHost: false },
      (incoming) => {
        let text = ''
        incoming.setEncoding('utf8')
        incoming.on('data', (chunk: string) => (text += chunk))
        incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, body: text }))
      },
    )
    outgoing.on('error', reject)
    if (body !== undefined) outgoing.write(body)
    outgoing.end()
  })
}

const own = () => `127.0.0.1:${server.port}`
const JSON_TYPE = { 'content-type': 'application/json' }

async function events(): Promise<number> {
  const state = await raw('GET', '/api/state', { host: own() })
  return (JSON.parse(state.body) as { events: number }).events
}

const RECORD = JSON.stringify({ target: 'q_why_order', dimensions: { confidence: 'high' } })

describe('the host name', () => {
  it('refuses a read through a host name rebound to this machine', async () => {
    for (const path of ['/api/state', '/api/suggestions', '/']) {
      const refused = await raw('GET', path, { host: `rebound.example:${server.port}` })
      expect(refused.status).toBe(403)
    }
  })

  it('refuses the MCP endpoint through a rebound host name too', async () => {
    const refused = await raw(
      'POST',
      '/mcp',
      { host: `rebound.example:${server.port}`, ...JSON_TYPE },
      '{}',
    )
    expect(refused.status).toBe(403)
  })

  it('refuses a local name on another port, and a missing host', async () => {
    expect((await raw('GET', '/api/state', { host: '127.0.0.1:1' })).status).toBe(403)
    // Node itself answers an HTTP/1.1 request without a Host header with 400 before the surface sees it;
    // the surface's own check is the second line. Either way it is refused.
    expect([400, 403]).toContain((await raw('GET', '/api/state', {})).status)
  })

  it('answers every local name for this port', async () => {
    for (const name of ['127.0.0.1', 'localhost', '[::1]']) {
      expect((await raw('GET', '/api/state', { host: `${name}:${server.port}` })).status).toBe(200)
    }
  })
})

describe('a cross-site write', () => {
  it('refuses a simple text POST, the one a page can send without asking', async () => {
    const before = await events()
    const refused = await raw(
      'POST',
      '/api/record',
      { host: own(), 'content-type': 'text/plain' },
      RECORD,
    )
    expect(refused.status).toBe(415)
    expect(await events()).toBe(before)
  })

  it('refuses a form POST', async () => {
    const before = await events()
    const refused = await raw(
      'POST',
      '/api/record',
      { host: own(), 'content-type': 'application/x-www-form-urlencoded' },
      'target=q_why_order',
    )
    expect(refused.status).toBe(415)
    expect(await events()).toBe(before)
  })

  it('refuses a JSON POST from another origin, to record or to decide', async () => {
    const before = await events()
    for (const [path, body] of [
      ['/api/record', RECORD],
      ['/api/suggestions/decide', JSON.stringify({ id: 'sug_x', action: 'accept' })],
      ['/api/claim', JSON.stringify({ label: 'planted' })],
    ] as const) {
      const refused = await raw(
        'POST',
        path,
        { host: own(), origin: 'https://evil.example', ...JSON_TYPE },
        body,
      )
      expect(refused.status).toBe(403)
    }
    expect(await events()).toBe(before)
  })

  it('refuses an opaque origin', async () => {
    const refused = await raw(
      'POST',
      '/api/record',
      { host: own(), origin: 'null', ...JSON_TYPE },
      RECORD,
    )
    expect(refused.status).toBe(403)
  })

  it('refuses a pending suggestion being accepted from another origin, and keeps it pending', async () => {
    const agent = mcpWire(() => server.mcpUrl, { name: 'Boundary Agent', version: '1' })
    await agent.call('propose', {
      kind: 'state',
      target: 'q_why_order',
      dimension: 'confidence',
      level: 'high',
      rationale: 'r',
    })
    const pending = JSON.parse((await raw('GET', '/api/suggestions', { host: own() })).body) as {
      suggestions: { id: string }[]
    }
    const id = pending.suggestions[0]?.id

    const refused = await raw(
      'POST',
      '/api/suggestions/decide',
      { host: own(), origin: 'http://evil.example', ...JSON_TYPE },
      JSON.stringify({ id, action: 'accept' }),
    )
    expect(refused.status).toBe(403)
    const after = JSON.parse((await raw('GET', '/api/suggestions', { host: own() })).body) as {
      suggestions: unknown[]
    }
    expect(after.suggestions).toHaveLength(1)
  })
})

describe('a cross-site read', () => {
  it('refuses what a browser marks as cross-site, with or without an Origin', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const refused = await raw('GET', '/api/state', { host: own(), 'sec-fetch-site': site })
      expect(refused.status).toBe(403)
    }
  })
})

describe('what still gets through', () => {
  it('the page’s own requests: same origin, same site, JSON', async () => {
    const page = await raw('GET', '/', {
      host: own(),
      'sec-fetch-site': 'none',
    })
    expect(page.status).toBe(200)

    const recorded = await raw(
      'POST',
      '/api/record',
      {
        host: own(),
        origin: `http://${own()}`,
        'sec-fetch-site': 'same-origin',
        ...JSON_TYPE,
      },
      RECORD,
    )
    expect(recorded.status).toBe(200)
  })

  it('the page opened as localhost', async () => {
    const recorded = await raw(
      'POST',
      '/api/record',
      { host: `localhost:${server.port}`, origin: `http://localhost:${server.port}`, ...JSON_TYPE },
      RECORD,
    )
    expect(recorded.status).toBe(200)
  })

  it('a client that is not a browser, such as an MCP host', async () => {
    const agent = mcpWire(() => server.mcpUrl, { name: 'Plain Host', version: '1' })
    const { status } = await agent.rpc('tools/list')
    expect(status).toBe(200)
  })
})
