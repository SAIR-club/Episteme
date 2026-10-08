import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startService, workspaceFile, type EpistemeService } from '@episteme/service'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * The Episteme service (ADR 0010): one owner of a graph, a versioned REST API for human-facing clients, and a
 * Workspace it may serve but never needs. Tested over a real socket, because what this layer owns is the wire.
 */

interface Json {
  readonly [key: string]: unknown
}

let directory: string
let service: EpistemeService

async function get(path: string): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${service.url}${path}`)
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Json }
}

async function post(path: string, body: unknown): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${service.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Json }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-service-'))
})

afterEach(async () => {
  await service.close()
  await rm(directory, { recursive: true, force: true })
})

describe('without a Workspace', () => {
  beforeEach(async () => {
    service = await startService({ port: 0, graph: join(directory, 'learn.jsonl') })
  })

  it('starts, and says at / where to connect instead of serving a page', async () => {
    expect(service.workspaceUrl).toBeUndefined()
    const response = await fetch(`${service.url}/`)
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain(service.apiUrl)
    expect(text).toContain(service.mcpUrl)
  })

  it('serves the state at a revision, with the scene it was composed with', async () => {
    const { status, body } = await get('/api/v1/state')
    expect(status).toBe(200)
    expect(typeof body['revision']).toBe('number')
    expect(body['scene']).toBe('learn')
    expect((body['nodes'] as unknown[]).length).toBeGreaterThan(0)
  })

  it('has no route that answers a question: it recalls, and leaves answering to the agent', async () => {
    expect((await post('/api/v1/ask', { question: 'why positions' })).status).toBe(404)
    const recalled = await post('/api/v1/recall', { question: 'why does attention need positions' })
    expect(recalled.status).toBe(200)
    expect(recalled.body['answer']).toBeUndefined()
    expect(Array.isArray(recalled.body['ranked'])).toBe(true)
  })

  it('answers malformed input with 400 and a code, not with a failure of the service', async () => {
    const missing = await post('/api/v1/recall', {})
    expect(missing.status).toBe(400)
    expect(missing.body['code']).toBe('invalid_request')

    const broken = await post('/api/v1/recall', '{not json')
    expect(broken.status).toBe(400)

    const array = await post('/api/v1/recall', [1, 2, 3])
    expect(array.status).toBe(400)
  })

  it('answers a refused command with 422 and a code', async () => {
    const created = await post('/api/v1/nodes', { label: 'a claim of my own' })
    const node = created.body['node'] as { nodeId: string }
    const refused = await post('/api/v1/record', {
      target: node.nodeId,
      dimensions: { mastery: 'high' },
    })
    expect(refused.status).toBe(422)
    expect(typeof refused.body['code']).toBe('string')
    expect(refused.body['error']).toContain('not recordable')
  })

  it('answers a write that failed as a failure, not as a refusal', async () => {
    const fsPromises = createRequire(import.meta.url)('node:fs/promises') as {
      rename: (from: string, to: string) => Promise<void>
    }
    const realRename = fsPromises.rename
    fsPromises.rename = async (from: string, to: string) => {
      if (to.endsWith('learn.jsonl')) throw new Error('injected: no space left on device')
      return realRename(from, to)
    }
    syncBuiltinESMExports()
    try {
      const failed = await post('/api/v1/record', {
        target: 'q_why_order',
        dimensions: { confidence: 'low' },
      })
      // The change may already be in memory, so "refused" (422) would tell the client nothing happened.
      expect(failed.status).toBe(500)
      expect(failed.body['code']).toBe('internal')
    } finally {
      fsPromises.rename = realRename
      syncBuiltinESMExports()
    }
    // A refusal is still a refusal.
    const refused = await post('/api/v1/record', {
      target: 'q_why_order',
      dimensions: { mastery: 'high' },
    })
    expect(refused.status).toBe(422)
    expect(refused.body['code']).toBe('not_recordable')
  })

  it('serves a node’s recorded history, the data a timeline is drawn from', async () => {
    await post('/api/v1/record', { target: 'q_why_order', dimensions: { confidence: 'low' } })
    await post('/api/v1/record', { target: 'q_why_order', dimensions: { confidence: 'high' } })
    const { status, body } = await get('/api/v1/nodes/q_why_order/history')
    expect(status).toBe(200)
    // The persisted form: dimensions as [id, value] pairs.
    const events = body['events'] as { dimensions: [string, { level: string }][] }[]
    const confidence = events.map(
      (event) => event.dimensions.find(([id]) => id === 'confidence')?.[1].level,
    )
    expect(confidence).toEqual(['low', 'high'])

    const unknown = await get('/api/v1/nodes/no_such_node/history')
    expect(unknown.status).toBe(404)
    expect(unknown.body['code']).toBe('unknown_node')

    // A node id that is not valid percent-encoding is malformed input, not a failure of the service.
    const malformed = await get('/api/v1/nodes/%E0%A4%A/history')
    expect(malformed.status).toBe(400)
    expect(malformed.body['code']).toBe('invalid_request')
  })

  it('reports an unknown route under the API as 404 with a code', async () => {
    const { status, body } = await get('/api/v1/nonsense')
    expect(status).toBe(404)
    expect(body['code']).toBe('no_route')
  })

  it('keeps the boundary in front of the API', async () => {
    const response = await fetch(`${service.apiUrl}/nodes`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ label: 'from a form' }),
    })
    expect(response.status).toBe(415)

    const foreign = await fetch(`${service.apiUrl}/state`, {
      headers: { origin: 'https://example.com' },
    })
    expect(foreign.status).toBe(403)
  })
})

describe('with a Workspace', () => {
  let root: string

  beforeEach(async () => {
    root = join(directory, 'workspace')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'index.html'), '<!doctype html><title>Workspace</title>')
    await writeFile(join(directory, 'secret.txt'), 'outside the workspace')
    service = await startService({
      port: 0,
      graph: join(directory, 'learn.jsonl'),
      workspace: root,
    })
  })

  it('serves its files at /, same-origin with the API', async () => {
    expect(service.workspaceUrl).toBe(`${service.url}/`)
    const response = await fetch(`${service.url}/`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toContain('Workspace')
  })

  it('never serves anything outside its directory, however the path is written', async () => {
    for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt']) {
      const status = await new Promise<number>((resolve, reject) => {
        // A raw request, since fetch would normalise the dots away before they reached the service.
        const request = httpRequest(
          { host: '127.0.0.1', port: service.port, path, method: 'GET' },
          (response) => {
            response.resume()
            resolve(response.statusCode ?? 0)
          },
        )
        request.on('error', reject)
        request.end()
      })
      expect(status).toBe(404)
    }
    expect(workspaceFile(root, '/../secret.txt')).toBeUndefined()
    expect(workspaceFile(root, '/%2e%2e%2fsecret.txt')).toBeUndefined()
    expect(workspaceFile(root, '/index.html')).toBe(join(root, 'index.html'))
  })

  it('never follows a link inside its directory to a file outside it', async () => {
    const outside = join(directory, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'secret.json'), '{"secret":"outside the workspace"}')
    await writeFile(join(root, 'inside.json'), '{"inside":true}')
    // A junction on Windows, which needs no privilege; a directory symlink elsewhere.
    await symlink(outside, join(root, 'linked'), 'junction')

    const escaped = await fetch(`${service.url}/linked/secret.json`)
    expect(escaped.status).toBe(404)
    expect(await escaped.text()).not.toContain('secret')
    // A file that is inside once links are followed is still served.
    expect((await fetch(`${service.url}/inside.json`)).status).toBe(200)
  })

  it('still routes the API and MCP around it', async () => {
    expect((await get('/api/v1/suggestions')).status).toBe(200)
    expect((await post('/api/v1/nodes', { label: 'still mine' })).status).toBe(200)
  })
})
