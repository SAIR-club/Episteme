import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startService, type EpistemeService } from '@episteme/service'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let directory: string
let filePath: string
let server: EpistemeService

interface Json {
  readonly [key: string]: unknown
}

async function get(path: string): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${server.url}${path}`)
  const body = (await response.json().catch(() => ({}))) as Json
  return { status: response.status, body }
}

async function post(path: string, body: unknown): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = (await response.json().catch(() => ({}))) as Json
  return { status: response.status, body: payload }
}

/**
 * Reads a field the test has asserted is present.
 *
 * Throws when the value is `undefined` rather than returning it. Returning `undefined` makes a missing
 * field surface later as `Cannot read properties of undefined`, which points at the assertion instead of at
 * the missing key — the failure message stops being about the wire shape the test exists to check.
 */
function field<T>(body: Json, key: string): T {
  const value = body[key]
  if (value === undefined) throw new Error(`response had no "${key}"`)
  return value as T
}

function list<T>(body: Json, key: string): readonly T[] {
  const value = field<unknown>(body, key)
  if (!Array.isArray(value)) throw new Error(`"${key}" was not an array`)
  return value as readonly T[]
}

/** The node id from a `/api/v1/nodes` response. */
function claimId(body: Json): string {
  const node = body['node']
  // The body is included in the failure, because "no nodeId" on its own says nothing about whether the
  // route was missing, the payload was wrong, or the request never reached the handler.
  if (typeof node !== 'object' || node === null) {
    throw new Error(`response had no node object: ${JSON.stringify(body)}`)
  }
  const id = (node as { nodeId?: unknown }).nodeId
  if (typeof id !== 'string') throw new Error(`node had no nodeId: ${JSON.stringify(node)}`)
  return id
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-http-'))
  filePath = join(directory, 'learn.jsonl')
  server = await startService({ port: 0, graph: filePath })
})

afterEach(async () => {
  await server.close()
  await rm(directory, { recursive: true, force: true })
})

describe('serving the interface', () => {
  it('serves the Learn page at the root when it is the Workspace', async () => {
    const workspaceDir = join(directory, 'workspace')
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(
      join(workspaceDir, 'index.html'),
      '<!doctype html><title>Episteme</title><script>fetch("/api/v1/state")</script>',
    )
    const served = await startService({
      port: 0,
      graph: join(directory, 'served.jsonl'),
      workspace: workspaceDir,
    })
    try {
      const response = await fetch(`${served.url}/`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/html')

      const html = await response.text()
      expect(html).toContain('Episteme')
      // The page is a client of the versioned API, and of nothing else.
      expect(html).toContain('/api/v1/state')
      expect(html).not.toMatch(/'\/api\/(?!v1\/)/)
      // The page must not be cached: a reload after recording has to show the new state.
      expect(response.headers.get('cache-control')).toBe('no-store')
    } finally {
      await served.close()
    }
  })

  it('binds to a loopback address only', () => {
    // There is no authentication on this surface by design, so exposing it on a network interface would be
    // a security decision nobody has made. The default host is asserted rather than assumed.
    expect(server.url).toContain('127.0.0.1')
  })
})

describe('the state endpoint', () => {
  it('returns the seeded topic, the recordable dimensions and the graph', async () => {
    const { status, body } = await get('/api/v1/state')
    expect(status).toBe(200)

    expect(field<{ title: string }>(body, 'topic').title).toBe('Transformer 如何处理顺序')
    expect(list(body, 'nodes').length).toBeGreaterThan(0)
    expect(list<{ id: string }>(body, 'dimensions').map((dimension) => dimension.id)).toContain(
      'confidence',
    )
    // The learner-facing labels travel with the payload, so a view never has to invent a translation.
    expect(
      list<{ labelZh: string }>(body, 'dimensions').map((dimension) => dimension.labelZh),
    ).toContain('确信程度')
    expect(list<{ signal: string }>(body, 'rules').map((rule) => rule.signal)).toContain('semantic')
    expect(field<string>(body, 'retriever')).toBe('hybrid')
  })

  it('attaches each node\u2019s recorded understanding, so the page needs one request', async () => {
    const first = await get('/api/v1/state')
    const aNode = list<{ nodeId: string }>(first.body, 'nodes')[0]?.nodeId
    expect(aNode).toBeDefined()
    if (aNode === undefined) return

    await post('/api/v1/record', { target: aNode, dimensions: { confidence: 'high' } })

    const second = await get('/api/v1/state')
    // Keyed by node, which is what stops the record panel rendering a node as blank when it is not.
    const understanding = field<Record<string, unknown>>(second.body, 'understanding')
    expect(understanding[aNode]).toEqual([{ id: 'confidence', level: 'high' }])
  })
})

describe('the recall endpoint', () => {
  it('recalls with the ranking and the reasons behind it, and writes no answer', async () => {
    const { status, body } = await post('/api/v1/recall', {
      question: 'why is order hard for attention',
    })
    expect(status).toBe(200)

    // The service recalls; answering is the agent's (ADR 0010).
    expect(body['answer']).toBeUndefined()
    expect(list(body, 'known')).toEqual([])

    // Every reason carries the arithmetic, so the page can show why a node sits where it does rather than
    // asking the learner to trust a number. Both languages travel together: a page that had to translate
    // could drift from the scoring it is explaining.
    const ranked = list<{
      reasons: readonly {
        contribution: number
        weight: number
        explanation: string
        explanationZh: string
        labelZh: string
      }[]
    }>(body, 'ranked')
    expect(ranked.length).toBeGreaterThan(0)
    for (const entry of ranked) {
      for (const reason of entry.reasons) {
        expect(typeof reason.contribution).toBe('number')
        expect(typeof reason.weight).toBe('number')
        expect(reason.explanation.length).toBeGreaterThan(0)
        expect(reason.explanationZh.length).toBeGreaterThan(0)
        expect(reason.labelZh.length).toBeGreaterThan(0)
      }
    }
  })

  it('rejects a request with no question as malformed, rather than recalling nothing', async () => {
    const { status, body } = await post('/api/v1/recall', {})
    expect(status).toBe(400)
    expect(field<string>(body, 'code')).toBe('invalid_request')
    expect(field<string>(body, 'error')).toContain('question')
  })

  it('rejects a non-object body', async () => {
    const response = await fetch(`${server.url}/api/v1/recall`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([1, 2, 3]),
    })
    expect(response.status).toBe(400)
  })
})

describe('adding the learner\u2019s own nodes', () => {
  it('adds a claim of the learner\u2019s own and it becomes retrievable', async () => {
    const created = await post('/api/v1/nodes', {
      label: '顺序信息在自注意力里完全丢失了',
      kind: 'claim',
    })
    expect(created.status).toBe(200)
    // `field` reads the top-level key, so this is the node itself — not `body.node.node`.
    const node = field<{ nodeId: string; type: string; tier: string }>(created.body, 'node')

    // A claim the learner writes is their own thinking, so it is `thought` tier — not `reference`, and not
    // `draft`. The distinction decides whether it counts as understanding at all.
    expect(node.type).toBe('claim')
    expect(node.tier).toBe('thought')
    expect(node.nodeId).toBe('claim_1')

    const { body } = await post('/api/v1/recall', { question: '顺序信息在自注意力里会丢失吗' })
    expect(list<{ nodeId: string }>(body, 'ranked').map((entry) => entry.nodeId)).toContain(
      node.nodeId,
    )
  })

  it('treats a concept as shared reference material rather than the learner\u2019s claim', async () => {
    const created = await post('/api/v1/nodes', { label: '相对位置编码', kind: 'concept' })
    const node = field<{ type: string; tier: string }>(created.body, 'node')

    expect(node.type).toBe('concept')
    expect(node.tier).toBe('reference')
  })

  it('refuses an empty label', async () => {
    const { status } = await post('/api/v1/nodes', { label: '   ' })
    expect(status).toBe(400)
  })
})

describe('recording through the surface', () => {
  it('records understanding, then the next recall carries it', async () => {
    const created = await post('/api/v1/nodes', {
      label: 'attention cannot tell which word came first',
    })
    expect(created.status).toBe(200)
    const target = claimId(created.body)
    const question = 'can attention tell which word came first'

    const before = await post('/api/v1/recall', { question })
    expect(list(before.body, 'known')).toEqual([])

    const recorded = await post('/api/v1/record', {
      target,
      dimensions: { confidence: 'low', conflict: 'open' },
    })
    expect(recorded.status).toBe(200)
    expect(list(recorded.body, 'understanding').length).toBe(2)

    const after = await post('/api/v1/recall', { question })
    expect(list(after.body, 'known').length).toBeGreaterThan(0)
    expect(field<string>(after.body, 'summary')).toContain('conflict=open')
    expect(field<string>(after.body, 'summary')).not.toBe(field<string>(before.body, 'summary'))
  })

  it('refuses a dimension the surface does not expose', async () => {
    const created = await post('/api/v1/nodes', { label: 'a claim' })
    const target = claimId(created.body)

    const { status, body } = await post('/api/v1/record', {
      target,
      dimensions: { mastery: 'high' },
    })
    expect(status).toBe(422)
    expect(field<string>(body, 'error')).toContain('not recordable')
  })

  it('refuses state for a node that does not exist', async () => {
    const { status } = await post('/api/v1/record', {
      target: 'no_such_node',
      dimensions: { confidence: 'high' },
    })
    expect(status).toBe(422)
  })
})

describe('routing', () => {
  it('reports an unknown route instead of pretending', async () => {
    const { status, body } = await get('/api/v1/nonsense')
    expect(status).toBe(404)
    expect(field<string>(body, 'error')).toContain('no route')
  })

  it('serves one shared session across requests', async () => {
    const created = await post('/api/v1/nodes', { label: 'a shared claim' })
    const target = claimId(created.body)

    // A second request sees the first one's write, which is what makes the page work without reloading.
    const { body } = await get('/api/v1/state')
    expect(list<{ nodeId: string }>(body, 'nodes').map((node) => node.nodeId)).toContain(target)
  })
})

describe('the review queue', () => {
  /** An agent's proposal, sent the way an MCP host sends it. */
  async function proposeOverMcp(args: Record<string, unknown>): Promise<void> {
    const response = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'propose',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'propose',
          arguments: args,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'queue-test', version: '1' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    })
    expect(response.status).toBe(200)
  }

  it('is empty until an agent proposes something', async () => {
    const { body } = await get('/api/v1/state')
    expect(list(body, 'suggestions')).toEqual([])
  })

  it('shows an agent’s proposal, who made it and why, without changing the learner’s state', async () => {
    const before = field<number>((await get('/api/v1/state')).body, 'events')
    await proposeOverMcp({
      kind: 'state',
      target: 'q_why_order',
      dimension: 'confidence',
      level: 'medium',
      rationale: 'they answered it but hedged',
    })

    const { body } = await get('/api/v1/suggestions')
    const [suggestion] = list<{
      proposedBy: string
      rationale: string
      proposal: { kind: string }
    }>(body, 'suggestions')
    expect(suggestion).toMatchObject({
      proposedBy: 'actor_agent_queue-test',
      rationale: 'they answered it but hedged',
      proposal: { kind: 'state' },
    })

    const state = (await get('/api/v1/state')).body
    expect(list(state, 'suggestions')).toHaveLength(1)
    expect(field<number>(state, 'events')).toBe(before)
  })

  async function pendingId(): Promise<string> {
    await proposeOverMcp({
      kind: 'state',
      target: 'q_why_order',
      dimension: 'confidence',
      level: 'medium',
      rationale: 'r',
    })
    const [suggestion] = list<{ id: string }>(
      (await get('/api/v1/suggestions')).body,
      'suggestions',
    )
    if (suggestion === undefined) throw new Error('no suggestion was kept')
    return suggestion.id
  }

  it('accepts a suggestion into the learner’s state through the shared decision path', async () => {
    const id = await pendingId()
    const before = field<number>((await get('/api/v1/state')).body, 'events')

    const { status, body } = await post('/api/v1/suggestions/decide', { id, action: 'accept' })
    expect(status).toBe(200)
    expect(field<{ outcome: string }>(body, 'result').outcome).toBe('accepted')
    expect(list(body, 'suggestions')).toEqual([])
    expect(field<number>(body, 'events')).toBe(before + 1)

    const state = (await get('/api/v1/state')).body
    const understanding = field<Record<string, unknown>>(state, 'understanding')
    expect(understanding['q_why_order']).toEqual([{ id: 'confidence', level: 'medium' }])
  })

  it('records the learner’s own value when they modify it', async () => {
    const id = await pendingId()
    await post('/api/v1/suggestions/decide', {
      id,
      action: 'modify',
      proposal: { kind: 'state', target: 'q_why_order', dimension: 'confidence', level: 'high' },
    })
    const understanding = field<Record<string, unknown>>(
      (await get('/api/v1/state')).body,
      'understanding',
    )
    expect(understanding['q_why_order']).toEqual([{ id: 'confidence', level: 'high' }])
  })

  it('dismisses without recording anything', async () => {
    const id = await pendingId()
    const before = field<number>((await get('/api/v1/state')).body, 'events')
    const { status } = await post('/api/v1/suggestions/decide', { id, action: 'dismiss' })
    expect(status).toBe(200)
    expect(field<number>((await get('/api/v1/state')).body, 'events')).toBe(before)
  })

  it('reports a refused decision as a refusal, with its code, and keeps the draft', async () => {
    const id = await pendingId()
    const { status, body } = await post('/api/v1/suggestions/decide', {
      id,
      action: 'modify',
      proposal: { kind: 'state', target: 'q_why_order', dimension: 'confidence', level: 'total' },
    })
    expect(status).toBe(422)
    expect(field<string>(body, 'code')).toBe('invalid_dimension_value')
    expect(list((await get('/api/v1/suggestions')).body, 'suggestions')).toHaveLength(1)
  })

  it('rejects a malformed decision before it reaches the application', async () => {
    const id = await pendingId()
    const { status } = await post('/api/v1/suggestions/decide', { id, action: 'approve' })
    expect(status).toBe(400)
    expect(list((await get('/api/v1/suggestions')).body, 'suggestions')).toHaveLength(1)
  })
})

describe('distilling material', () => {
  const MATERIAL =
    '学生：为什么 Transformer 需要位置编码？\n老师：因为自注意力本身不区分词的顺序。\n学生：我明白了。'

  it('turns material into pending suggestions, with their words, and records nothing', async () => {
    const before = field<number>((await get('/api/v1/state')).body, 'events')
    const { status, body } = await post('/api/v1/distill', { title: '位置编码', text: MATERIAL })
    expect(status).toBe(200)
    expect(field<number>(body, 'episodes')).toBe(1)
    const distilled = list(body, 'suggestions')
    expect(distilled.length).toBeGreaterThan(0)

    const suggestions = list<{ origin?: { excerpt: string } }>(
      (await get('/api/v1/suggestions')).body,
      'suggestions',
    )
    expect(suggestions).toHaveLength(distilled.length)
    expect(suggestions.every((suggestion) => suggestion.origin !== undefined)).toBe(true)
    expect(field<number>((await get('/api/v1/state')).body, 'events')).toBe(before)
  })

  it('reports material it will not read as a refusal', async () => {
    const { status, body } = await post('/api/v1/distill', { text: 'x'.repeat(20_001) })
    expect(status).toBe(422)
    expect(field<string>(body, 'code')).toBe('material_too_long')
  })

  it('lets the learner modify a distilled node into their own words', async () => {
    await post('/api/v1/distill', { text: MATERIAL })
    const suggestions = list<{ id: string; proposal: { kind: string; nodeType?: string } }>(
      (await get('/api/v1/suggestions')).body,
      'suggestions',
    )
    const claim = suggestions.find(
      (suggestion) =>
        suggestion.proposal.kind === 'node' && suggestion.proposal.nodeType === 'claim',
    )
    const { status } = await post('/api/v1/suggestions/decide', {
      id: claim?.id,
      action: 'modify',
      proposal: { kind: 'node', nodeType: 'claim', label: '注意力本身没有顺序' },
    })
    expect(status).toBe(200)
    const nodes = list<{ label: string }>((await get('/api/v1/state')).body, 'nodes')
    expect(nodes.map((node) => node.label)).toContain('注意力本身没有顺序')
  })
})
