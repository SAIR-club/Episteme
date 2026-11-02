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
  filePath = join(directory, 'graph.db')
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
    // The refusal names the parameter, or an agent can only guess where the quote goes.
    await expect(session.summarizeTurn(thread.id, turn.id, { text: 's' })).rejects.toThrow(
      /pass them in quotes/,
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

  it('forks a fork, and from a turn a branch only carries over, each line reading its own way back', async () => {
    const main = await session.openThread({ title: 'main' })
    const one = await session.appendTurn(main.id, { speaker: 'learner', text: 'one' })
    const two = await session.appendTurn(main.id, { speaker: 'agent', text: 'two' })
    await session.appendTurn(main.id, { speaker: 'learner', text: 'three on main' })

    const side = await session.forkThread(main.id, two.id, 'side')
    const sideOwn = await session.appendTurn(side.id, { speaker: 'learner', text: 'side own' })
    await session.appendTurn(side.id, { speaker: 'agent', text: 'side later' })

    // A branch of the branch, from a turn the branch said itself.
    const deep = await session.forkThread(side.id, sideOwn.id, 'deep')
    await session.appendTurn(deep.id, { speaker: 'learner', text: 'deep own' })
    // A branch of the branch, from a turn it only carries over from main.
    const early = await session.forkThread(side.id, one.id, 'early')
    await session.appendTurn(early.id, { speaker: 'learner', text: 'early own' })

    const texts = (id: string) => session.threadView(id)?.turns.map((turn) => turn.text)
    expect(texts(main.id)).toEqual(['one', 'two', 'three on main'])
    expect(texts(side.id)).toEqual(['one', 'two', 'side own', 'side later'])
    expect(texts(deep.id)).toEqual(['one', 'two', 'side own', 'deep own'])
    expect(texts(early.id)).toEqual(['one', 'early own'])
    expect(early.parent).toEqual({ thread: side.id, turn: one.id })

    // Every turn keeps the line it was said on, so a reader can tell carried-over from own.
    expect(session.threadView(deep.id)?.turns.map((turn) => turn.thread)).toEqual([
      main.id,
      main.id,
      side.id,
      deep.id,
    ])
    // A turn after the fork point on the parent is not on the branch, and cannot be forked from it.
    const later = session.threadView(side.id)?.turns.at(-1)
    expect(await refusalOf(session.forkThread(deep.id, later!.id))).toBe('unknown_turn')

    await session.close()
    session = await CognitiveSession.open({ filePath })
    expect(texts(deep.id)).toEqual(['one', 'two', 'side own', 'deep own'])
    expect(session.threads().find((thread) => thread.id === deep.id)?.parent).toEqual({
      thread: side.id,
      turn: sideOwn.id,
    })
  })

  it('forks only the person’s own thread', async () => {
    const thread = await session.openThread({ title: 'mine' })
    const turn = await session.appendTurn(thread.id, { speaker: 'learner', text: 'mine' })
    const other = session.forActor('actor_human_other', 'Other')
    expect(await refusalOf(other.forkThread(thread.id, turn.id))).toBe('unknown_thread')
    expect(other.threads()).toEqual([])
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
      graph: join(directory, 'shared.db'),
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

  it('forks over REST for the owner only', async () => {
    const opened = await call('/threads', lin.human, { title: '位置编码' })
    const thread = (opened.body['thread'] as { id: string }).id
    const said = await call(`/threads/${thread}/turns`, lin.human, {
      speaker: 'learner',
      text: '位置编码可以省略吗？',
    })
    const turn = (said.body['turn'] as { id: string }).id

    const forked = await call(`/threads/${thread}/fork`, lin.human, { turn, title: '另一种问法' })
    expect(forked).toMatchObject({
      status: 200,
      body: { thread: { title: '另一种问法', parent: { thread, turn } } },
    })
    const fork = (forked.body['thread'] as { id: string }).id
    const read = await call(`/threads/${fork}`, lin.human)
    expect(JSON.stringify(read.body)).toContain('位置编码可以省略吗')

    expect(await call(`/threads/${thread}/fork`, lin.human, { turn: 'turn_absent' })).toMatchObject(
      { status: 422, body: { code: 'unknown_turn' } },
    )
    expect(await call(`/threads/${thread}/fork`, wei.human, { turn })).toMatchObject({
      status: 422,
      body: { code: 'unknown_thread' },
    })
    expect((await call('/threads', wei.human)).body['threads']).toEqual([])
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
