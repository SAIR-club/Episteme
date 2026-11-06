import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addPerson, addToken, startService, type EpistemeService } from '@episteme/service'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * ADR 0014's story, end to end, over HTTP, with two people on one shared service.
 *
 * 1. Lin publishes a claim with a conversation's summaries. 2. Wei browses and reads it as a structure, without
 * one raw word of the conversation. 3. Wei adopts it at his own level: one state event of his, no copy. 4. Lin
 * revises and publishes again. 5. Wei is told, and nothing of his changes until he decides.
 */

const RAW = '我总觉得位置编码可有可无，反正注意力会自己学到顺序吧？'

interface Person {
  readonly id: string
  readonly human: string
  readonly agent: string
}

let directory: string
let service: EpistemeService
let lin: Person
let wei: Person

async function call(path: string, token: string, body?: unknown) {
  const response = await fetch(`${service.apiUrl}${path}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  })
  const text = await response.text()
  return { status: response.status, text, body: JSON.parse(text) as unknown }
}

/** The value at `path` inside parsed JSON, typed by the caller who knows the route's contract. */
function at<T>(value: unknown, ...path: (string | number)[]): T {
  let current = value
  for (const key of path) current = (current as Record<string | number, unknown>)[key]
  return current as T
}

async function newNode(token: string, label: string): Promise<string> {
  return at<string>((await call('/nodes', token, { label })).body, 'node', 'nodeId')
}

async function publish(token: string, request: Record<string, unknown>): Promise<string> {
  return at<string>((await call('/publications', token, request)).body, 'publication', 'id')
}

async function nodesSeenBy(token: string): Promise<string[]> {
  return at<{ nodeId: string }[]>((await call('/state', token)).body, 'nodes').map(
    (node) => node.nodeId,
  )
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-story-'))
  const users = join(directory, 'users.json')
  const person = async (name: string): Promise<Person> => {
    const id = await addPerson(users, name)
    return {
      id,
      human: await addToken(users, id, 'human', 'workspace'),
      agent: await addToken(users, id, 'agent', 'claude-code'),
    }
  }
  lin = await person('Lin')
  wei = await person('Wei')
  service = await startService({
    port: 0,
    graph: join(directory, 'shared.db'),
    mode: 'shared',
    users,
    publicOrigin: 'https://episteme.example.edu',
    sharing: true,
  })
})

afterEach(async () => {
  await service.close()
  await rm(directory, { recursive: true, force: true })
})

/** Lin's claim, and a conversation with one summarized learner turn and one unsummarized agent turn. */
async function linsWork(): Promise<{ claim: string; thread: string }> {
  const claim = await newNode(lin.human, '自注意力本身不编码顺序')
  const thread = at<string>(
    (await call('/threads', lin.human, { title: '位置编码' })).body,
    'thread',
    'id',
  )
  const turns = `/threads/${thread}/turns`
  const asked = at<string>(
    (await call(turns, lin.human, { speaker: 'learner', text: RAW })).body,
    'turn',
    'id',
  )
  await call(turns, lin.human, { speaker: 'agent', text: '不会，注意力对顺序是置换不变的。' })
  await call(`${turns}/${asked}/summary`, lin.human, {
    text: '怀疑位置编码是否必要',
    quotes: ['位置编码可有可无'],
  })
  return { claim, thread }
}

describe('the sharing story', () => {
  it('runs from publishing to the update, over HTTP, for two people', async () => {
    const work = await linsWork()

    // 1. Lin previews and publishes. The preview says what becomes public and what stays private.
    const plan = await call('/publications/preview', lin.human, {
      root: work.claim,
      threads: [work.thread],
    })
    expect(plan.status).toBe(200)
    expect(
      at<{ nodeId: string }[]>(plan.body, 'public', 'nodes').map((node) => node.nodeId),
    ).toEqual([work.claim])
    expect(at<string[]>(plan.body, 'private', 'unsummarizedTurns')).toHaveLength(1)
    expect(plan.text.includes(RAW)).toBe(false)
    const first = await publish(lin.human, { root: work.claim, threads: [work.thread] })

    // 2. Wei browses and reads it as a structure; the conversation shows only as its summary.
    const browsed = await call('/publications', wei.human)
    expect(at<unknown[]>(browsed.body, 'publications')).toMatchObject([
      { id: first, author: lin.id, version: 1 },
    ])
    const read = await call(`/publications/${first}`, wei.human)
    expect(at<unknown[]>(read.body, 'nodes')).toMatchObject([
      { nodeId: work.claim, author: lin.id, confirmation: 'person' },
    ])
    expect(at<unknown[]>(read.body, 'threads', 0, 'turns')).toMatchObject([
      { speaker: 'learner', summary: '怀疑位置编码是否必要' },
    ])
    expect(read.text.includes(RAW)).toBe(false)

    // 3. Wei adopts it at his own level: one event of his, naming the publication, and no new node.
    const nodesBefore = (await nodesSeenBy(lin.human)).length
    const adopted = await call(`/publications/${first}/adopt`, wei.human, {
      node: work.claim,
      dimensions: { confidence: 'medium' },
    })
    expect(adopted.status).toBe(200)
    expect(at<unknown[]>(adopted.body, 'understanding')).toEqual([
      { id: 'confidence', level: 'medium' },
    ])
    const history = await call(`/nodes/${work.claim}/history`, wei.human)
    expect(at<unknown[]>(history.body, 'events')).toMatchObject([
      { source: `publication:${first}` },
    ])
    expect((await nodesSeenBy(lin.human)).length).toBe(nodesBefore)
    const ownAdoption = await call(`/publications/${first}/adopt`, lin.human, {
      node: work.claim,
      dimensions: { confidence: 'high' },
    })
    expect(ownAdoption.body).toMatchObject({ code: 'own_publication' })

    // 4. Lin revises and publishes again, superseding the first.
    const revised = await newNode(lin.human, '自注意力是置换不变的，所以需要位置信息')
    const second = await publish(lin.human, { root: revised, supersedes: first })
    const reread = await call(`/publications/${second}`, wei.human)
    expect(at<string[]>(reread.body, 'versions')).toEqual([first, second])

    // 5. Wei is told what changed; his own understanding is untouched until he decides.
    const updates = await call('/updates', wei.human)
    expect(at<unknown[]>(updates.body, 'updates')).toEqual([
      { adopted: first, newer: second, added: [revised], removed: [work.claim] },
    ])
    const weiState = await call('/state', wei.human)
    expect(at<unknown[]>(weiState.body, 'understanding', work.claim)).toEqual([
      { id: 'confidence', level: 'medium' },
    ])
  })

  it('keeps contributions to the person: an agent token can neither publish nor adopt', async () => {
    const work = await linsWork()
    expect((await call('/publications', lin.agent, { root: work.claim })).status).toBe(403)
    const first = await publish(lin.human, { root: work.claim })
    const adopting = await call(`/publications/${first}/adopt`, wei.agent, {
      node: work.claim,
      dimensions: { confidence: 'low' },
    })
    expect(adopting).toMatchObject({ status: 403, body: { code: 'human_required' } })
  })

  it('stops reading a withdrawn publication, and keeps what Wei adopted readable to him', async () => {
    const work = await linsWork()
    const first = await publish(lin.human, { root: work.claim })
    await call(`/publications/${first}/adopt`, wei.human, {
      node: work.claim,
      dimensions: { confidence: 'low' },
    })
    expect((await call(`/publications/${first}/withdraw`, lin.human, {})).status).toBe(200)

    expect((await call(`/publications/${first}`, wei.human)).status).toBe(404)
    expect(at<unknown[]>((await call('/publications', wei.human)).body, 'publications')).toEqual([])
    expect(await nodesSeenBy(wei.human)).toContain(work.claim)
    expect(at<boolean>((await call(`/publications/${first}`, lin.human)).body, 'live')).toBe(false)
  })

  it('refuses to publish a thread that is not the author’s', async () => {
    const work = await linsWork()
    const weiClaim = await newNode(wei.human, 'mine')
    const refused = await call('/publications', wei.human, {
      root: weiClaim,
      threads: [work.thread],
    })
    expect(refused).toMatchObject({ status: 422, body: { code: 'not_publishable' } })
  })
})
