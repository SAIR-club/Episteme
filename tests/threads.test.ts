import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CognitiveSession, MAX_SCENE_RECORD_BYTES, isRefusal } from '@episteme/application'
import { addPerson, addToken, startService, type EpistemeService } from '@episteme/service'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mcpWire } from './mcp-wire.js'

/**
 * Conversation threads and scene records (ADR 0015).
 *
 * Turns are a raw archive only their owner reads; summaries are anchored to the learner's words; a fork reads its
 * parent up to the fork turn; distilling a thread names its turns; a scene's records are versioned, its own and
 * the caller's.
 */

let directory: string
let filePath: string
let session: CognitiveSession

async function refusalOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work
    return undefined
  } catch (error) {
    if (!isRefusal(error)) throw error
    return error.code
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-threads-'))
  filePath = join(directory, 'graph.jsonl')
  session = await CognitiveSession.open({ filePath })
})

afterEach(async () => {
  await session.close()
  await rm(directory, { recursive: true, force: true })
})

describe('a thread', () => {
  it('keeps turns in order, raw, and the current summary of each', async () => {
    const thread = await session.openThread({ title: 'Positions', scope: 'ml-2026' })
    const asked = await session.appendTurn(thread.id, {
      speaker: 'learner',
      text: '为什么 Transformer 需要位置编码？我觉得注意力已经够了。',
    })
    const answered = await session.appendTurn(thread.id, {
      speaker: 'agent',
      text: '因为自注意力本身不区分词的顺序。',
    })
    expect([asked.seq, answered.seq]).toEqual([1, 2])

    await session.summarizeTurn(thread.id, asked.id, {
      text: '问为什么需要位置编码',
      quotes: ['为什么 Transformer 需要位置编码'],
    })
    await session.summarizeTurn(thread.id, answered.id, { text: '注意力不区分顺序' })
    await session.summarizeTurn(thread.id, asked.id, {
      text: '怀疑位置编码是否必要',
      quotes: ['我觉得注意力已经够了'],
    })

    const view = session.threadView(thread.id)
    expect(view?.turns.map((turn) => [turn.text, turn.summary?.text])).toEqual([
      ['为什么 Transformer 需要位置编码？我觉得注意力已经够了。', '怀疑位置编码是否必要'],
      ['因为自注意力本身不区分词的顺序。', '注意力不区分顺序'],
    ])
    expect(session.threads('ml-2026').map((candidate) => candidate.id)).toEqual([thread.id])
    expect(session.threads('another')).toEqual([])
  })

  it('anchors a learner turn’s summary in their own words, and refuses one that is not', async () => {
    const thread = await session.openThread({ title: 't' })
    const turn = await session.appendTurn(thread.id, {
      speaker: 'learner',
      text: '位置编码可以省略吗？',
    })
    expect(await refusalOf(session.summarizeTurn(thread.id, turn.id, { text: 's' }))).toBe(
      'missing_quote',
    )
    expect(
      await refusalOf(
        session.summarizeTurn(thread.id, turn.id, { text: 's', quotes: ['可以删掉吗'] }),
      ),
    ).toBe('quote_not_found')
    expect(
      await refusalOf(session.summarizeTurn(thread.id, turn.id, { text: 's', quotes: ['？'] })),
    ).toBe('quote_too_short')
    expect(session.threadView(thread.id)?.turns[0]?.summary).toBeUndefined()
  })

  it('forks into a new line that reads its parent up to the fork turn, and nothing after', async () => {
    const thread = await session.openThread({ title: 'main' })
    const first = await session.appendTurn(thread.id, {
      speaker: 'learner',
      text: 'first question',
    })
    await session.appendTurn(thread.id, { speaker: 'agent', text: 'later on the main line' })
    const fork = await session.forkThread(thread.id, first.id, 'side question')
    const own = await session.appendTurn(fork.id, { speaker: 'learner', text: 'on the side line' })

    expect(fork.parent).toEqual({ thread: thread.id, turn: first.id })
    expect(session.threadView(fork.id)?.turns.map((turn) => turn.text)).toEqual([
      'first question',
      'on the side line',
    ])
    expect(own.seq).toBe(1)
    expect(session.threadView(thread.id)?.turns).toHaveLength(2)
    expect(await refusalOf(session.forkThread(thread.id, 'turn_absent'))).toBe('unknown_turn')
  })

  it('survives a restart', async () => {
    const thread = await session.openThread({ title: 'kept' })
    const turn = await session.appendTurn(thread.id, {
      speaker: 'learner',
      text: 'keep these words',
    })
    await session.summarizeTurn(thread.id, turn.id, { text: 'kept', quotes: ['these words'] })
    await session.putSceneRecord('mindlink', 'project/p1', { goal: 'speedrun' })
    await session.close()

    session = await CognitiveSession.open({ filePath })
    expect(session.threadView(thread.id)?.turns[0]).toMatchObject({
      text: 'keep these words',
      summary: { text: 'kept' },
    })
    expect(session.sceneRecord('mindlink', 'project/p1')?.value).toEqual({ goal: 'speedrun' })
  })

  it('distils into suggestions whose origins name their turns, and leaves the graph unchanged', async () => {
    const thread = await session.openThread({ title: 'positions' })
    const asked = await session.appendTurn(thread.id, {
      speaker: 'learner',
      text: '为什么 Transformer 需要位置编码？',
    })
    const answered = await session.appendTurn(thread.id, {
      speaker: 'agent',
      text: '因为自注意力本身不区分词的顺序。',
    })
    const before = session.eventCount
    const outcome = await session.distillThread(thread.id)
    if (!outcome.ok) throw new Error(outcome.refusal.message)
    expect(outcome.suggestions.length).toBeGreaterThan(0)
    const turns = new Set(outcome.suggestions.map((suggestion) => suggestion.origin?.turn))
    expect([...turns].every((turn) => turn === asked.id || turn === answered.id)).toBe(true)
    expect(session.sources().at(-1)?.thread).toEqual({
      id: thread.id,
      turns: [asked.id, answered.id],
    })
    expect(session.eventCount).toBe(before)
    expect(session.listNodes().some((node) => node.label.includes('位置编码'))).toBe(false)
  })
})

describe('scope', () => {
  it('tags a node with the project it belongs to', async () => {
    const node = await session.addNode({ label: 'mine', kind: 'claim', scope: 'ml-2026' })
    expect(session.graph.getNode(node.nodeId)?.tags).toContain('scope:ml-2026')
  })
})

describe('scene records', () => {
  it('append versions, are scoped to a namespace and a person, and are removed by null', async () => {
    const first = await session.putSceneRecord('mindlink', 'project/p1', { goal: 'speedrun' })
    const second = await session.putSceneRecord('mindlink', 'project/p1', { goal: 'deep' })
    expect([first.version, second.version]).toEqual([1, 2])
    expect(session.sceneRecord('mindlink', 'project/p1')?.value).toEqual({ goal: 'deep' })
    expect(session.sceneRecord('discussion', 'project/p1')).toBeUndefined()

    const other = session.forActor('actor_human_other', 'Other')
    expect(other.sceneRecord('mindlink', 'project/p1')).toBeUndefined()

    await session.putSceneRecord('mindlink', 'project/p2', { goal: 'apply' })
    expect(
      session
        .sceneRecords('mindlink', 'project/')
        .map((record) => record.key)
        .sort(),
    ).toEqual(['project/p1', 'project/p2'])
    await session.putSceneRecord('mindlink', 'project/p1', null)
    expect(session.sceneRecord('mindlink', 'project/p1')).toBeUndefined()
    expect(
      await refusalOf(
        session.putSceneRecord('mindlink', 'big', 'x'.repeat(MAX_SCENE_RECORD_BYTES + 1)),
      ),
    ).toBe('value_too_large')
  })
})

describe('threads in a shared service', () => {
  let service: EpistemeService
  let lin: { human: string; agent: string }
  let wei: { human: string }

  async function call(path: string, token: string, body?: unknown, method = 'POST') {
    const response = await fetch(`${service.apiUrl}${path}`, {
      ...(body === undefined ? {} : { method, body: JSON.stringify(body) }),
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }

  beforeEach(async () => {
    const users = join(directory, 'users.json')
    const linId = await addPerson(users, 'Lin')
    const weiId = await addPerson(users, 'Wei')
    lin = {
      human: await addToken(users, linId, 'human', 'workspace'),
      agent: await addToken(users, linId, 'agent', 'claude-code'),
    }
    wei = { human: await addToken(users, weiId, 'human', 'workspace') }
    service = await startService({
      port: 0,
      graph: join(directory, 'shared.jsonl'),
      mode: 'shared',
      users,
      publicOrigin: 'https://episteme.example.edu',
    })
  })

  afterEach(async () => {
    await service.close()
  })

  it('lets an agent keep the person’s conversation over MCP, and shows it to nobody else', async () => {
    const host = mcpWire(() => service.mcpUrl, { name: 'Claude Code', version: '1' })
    const as = { headers: { authorization: `Bearer ${lin.agent}` } }
    const opened = await host.call('thread_open', { title: 'Positions' }, {}, as)
    const threadId = (opened.structuredContent?.['thread'] as { id: string }).id
    const appended = await host.call(
      'thread_append',
      { thread: threadId, speaker: 'learner', text: '位置编码可以省略吗？' },
      {},
      as,
    )
    const turn = appended.structuredContent?.['turn'] as { id: string; by: string }
    expect(turn.by).toBe('actor_agent_claude-code')
    const summarized = await host.call(
      'thread_summarize',
      { thread: threadId, turn: turn.id, text: '问能否省略', quotes: ['可以省略吗'] },
      {},
      as,
    )
    expect(summarized.isError).toBeUndefined()

    const linView = await call(`/threads/${threadId}`, lin.human)
    expect(linView.status).toBe(200)
    expect(JSON.stringify(linView.body)).toContain('位置编码可以省略吗')

    expect((await call('/threads', wei.human)).body['threads']).toEqual([])
    expect((await call(`/threads/${threadId}`, wei.human)).status).toBe(404)
    const intruding = await call(`/threads/${threadId}/turns`, wei.human, {
      speaker: 'learner',
      text: 'not mine',
    })
    expect(intruding).toMatchObject({ status: 422, body: { code: 'unknown_thread' } })
  })

  it('serves scene records over REST, the caller’s own', async () => {
    const put = await call(
      '/scene-records/mindlink/project%2Fp1',
      lin.human,
      { value: { goal: 'speedrun' } },
      'PUT',
    )
    expect(put).toMatchObject({ status: 200, body: { record: { version: 1 } } })
    expect(
      (await call('/scene-records/mindlink/project%2Fp1', lin.human)).body['record'],
    ).toMatchObject({
      value: { goal: 'speedrun' },
    })
    expect((await call('/scene-records/mindlink/project%2Fp1', wei.human)).status).toBe(404)
    expect(
      (await call('/scene-records/mindlink?prefix=project', lin.agent)).body['records'],
    ).toHaveLength(1)
  })
})
