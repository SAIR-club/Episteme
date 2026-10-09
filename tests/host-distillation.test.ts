import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LearnSession,
  SourceStore,
  SuggestionStore,
  payloadDigest,
  type DistillOutcome,
  type HostItem,
} from '@episteme/application'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Host-assisted distillation (ADR 0011, #21, PR-B): a host's model reads, Episteme verifies, the learner
 * decides.
 */

/**
 * Three episodes; each opens with the learner's question. "我还是不明白。" occurs once in the first and once in
 * the third, so it is unique in each episode and ambiguous in the whole source.
 */
const DIALOGUE = [
  '学生：为什么需要位置编码？',
  '老师：因为自注意力本身不区分词的顺序。',
  '学生：我原来以为自注意力能看出顺序。',
  '学生：我还是不明白。',
  '学生：位置编码加在哪里？',
  '老师：加在词向量上。',
  '学生：那它怎么表示顺序？',
  '老师：每个位置的向量都不同。',
  '学生：我之前想错了，自注意力本身看不出顺序。',
  '学生：我还是不明白。',
].join('\n')

const AGENT = 'actor_agent_agent-a'

const node = (
  ref: string,
  label: string,
  quote: string,
  extra: Partial<HostItem> = {},
): HostItem => ({
  kind: 'node',
  ref,
  role: 'claim',
  label,
  quote,
  basis: 'stated',
  rationale: 'the learner said it',
  ...extra,
})

const confused = (target: string, extra: Partial<HostItem> = {}): HostItem => ({
  kind: 'state',
  ref: `confused-${target}`,
  target,
  dimension: 'confidence',
  level: 'low',
  quote: '我还是不明白。',
  basis: 'stated',
  rationale: 'the learner said they still do not understand',
  ...extra,
})

/** The misconception, its correction, and the relation between them, across the first and third episodes. */
const CORRECTION: readonly HostItem[] = [
  node('old', '自注意力能看出顺序', '我原来以为自注意力能看出顺序'),
  node('new', '自注意力本身看不出顺序', '自注意力本身看不出顺序'),
  {
    kind: 'relation',
    ref: 'fix',
    from: 'cand:old',
    to: 'cand:new',
    relation: 'revises',
    quote: '我之前想错了',
    basis: 'stated',
    rationale: 'the learner corrected their earlier claim',
  },
]

let directory: string
let graph: string
let session: LearnSession

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-host-'))
  graph = join(directory, 'learn.jsonl')
  session = await LearnSession.open({ filePath: graph })
})

afterEach(async () => {
  await session.close()
  await rm(directory, { recursive: true, force: true })
})

async function submit(
  candidates: readonly HostItem[],
  options: {
    readonly hostSession?: string
    readonly submissionId?: string
    readonly by?: string
    readonly text?: string
  } = {},
): Promise<Extract<DistillOutcome, { ok: true }>> {
  const outcome = await session.distill(
    { text: options.text ?? DIALOGUE },
    {
      requestedBy: options.by ?? AGENT,
      learner: '学生',
      host: {
        candidates,
        ...(options.hostSession === undefined ? {} : { hostSession: options.hostSession }),
        ...(options.submissionId === undefined ? {} : { submissionId: options.submissionId }),
      },
    },
  )
  if (!outcome.ok) throw new Error(`${outcome.refusal.code}: ${outcome.refusal.message}`)
  return outcome
}

/** An item without one of its fields, as a host might send it. */
function without(item: HostItem, field: keyof HostItem): HostItem {
  const { [field]: _dropped, ...rest } = item
  return rest as HostItem
}

const codes = (outcome: { refused: readonly { ref: string; code: string }[] }) =>
  Object.fromEntries(outcome.refused.map(({ ref, code }) => [ref, code]))

/** The three files a decision or a distillation may write, read byte for byte. */
async function files(): Promise<readonly (Buffer | undefined)[]> {
  await session.flush()
  return Promise.all(
    [graph, `${graph}.sources.jsonl`, `${graph}.suggestions.jsonl`].map((path) =>
      readFile(path).catch(() => undefined),
    ),
  )
}

async function accept(id: string | undefined): Promise<string> {
  const decided = await session.decide(id ?? '', { action: 'accept' }, 'learn-review')
  if (!decided.ok) throw new Error(`${decided.refusal.code}: ${decided.refusal.message}`)
  if (!('committed' in decided)) throw new Error('nothing was committed')
  return decided.committed.id
}

describe('a host reading', () => {
  it('is proposed by the agent that sent it, read by the host, and recorded nowhere yet', async () => {
    const before = session.eventCount
    const outcome = await submit(CORRECTION)
    expect(outcome.reader).toBe('host')
    expect(outcome.suggestions).toHaveLength(3)
    for (const suggestion of outcome.suggestions) {
      expect(suggestion.proposedBy).toBe(AGENT)
      expect(suggestion.requestedBy).toBe(AGENT)
    }
    expect(session.sources()[0]?.reader).toBe('host')
    expect(session.listNodes()).toEqual([])
    expect(session.eventCount).toBe(before)
  })

  it('uses Episteme’s own reader when no candidates are sent', async () => {
    const outcome = await session.distill({ text: DIALOGUE }, { requestedBy: AGENT })
    if (!outcome.ok) throw new Error(outcome.refusal.message)
    expect(outcome.reader).toBe('episteme')
    expect(
      outcome.suggestions.every((s) => s.proposedBy === 'actor_agent_rule-based-distiller'),
    ).toBe(true)
  })

  it('requires every item to say its basis, and never makes an inference stated', async () => {
    const outcome = await submit([
      without(node('a', '自注意力能看出顺序', '我原来以为自注意力能看出顺序'), 'basis'),
      node('b', '学习者对顺序有误解', '我原来以为自注意力能看出顺序', { basis: 'inferred' }),
      without(node('c', 'missing quote', 'unused'), 'quote'),
    ])
    expect(codes(outcome)).toEqual({ a: 'missing_basis', c: 'missing_quote' })
    // Quoting the learner's own turn does not turn the host's reading into the learner's statement.
    expect(outcome.suggestions.map((suggestion) => suggestion.basis)).toEqual(['inferred'])
    expect(outcome.suggestions[0]?.origin?.speaker).toBe('学生')
  })

  it('carries at most 100 items, refused as a whole beyond that', async () => {
    const many = Array.from({ length: 101 }, (_, index) =>
      node(`n${index}`, `claim ${index}`, '我原来以为自注意力能看出顺序'),
    )
    const outcome = await session.distill(
      { text: DIALOGUE },
      { requestedBy: AGENT, host: { candidates: many } },
    )
    expect(outcome.ok ? undefined : outcome.refusal.code).toBe('too_many_candidates')
    expect(session.sources()).toEqual([])
  })

  it('refuses a stated item whose words are not the learner’s', async () => {
    const outcome = await submit([node('t', '位置向量各不相同', '每个位置的向量都不同')])
    expect(codes(outcome)).toEqual({ t: 'basis_mismatch' })
  })
})

describe('where a quote is, in the whole source', () => {
  it('needs the occurrence when the words occur twice in the source, even once per episode', async () => {
    const outcome = await submit([
      node('n', '自注意力能看出顺序', '我原来以为自注意力能看出顺序'),
      confused('cand:n'),
      confused('cand:n', { ref: 'second', occurrence: 2 }),
      confused('cand:n', { ref: 'third', occurrence: 3 }),
      node('once', '位置编码加在词向量上', '加在词向量上', { basis: 'inferred', occurrence: 2 }),
    ])
    expect(codes(outcome)).toEqual({
      'confused-cand:n': 'quote_ambiguous',
      third: 'quote_not_found',
      once: 'quote_not_found',
    })
    const second = outcome.suggestions.find((suggestion) => suggestion.proposal.kind === 'state')
    expect(second?.origin?.span.start).toBe(DIALOGUE.lastIndexOf('我还是不明白。'))
    expect(second?.origin?.episodeId.endsWith('#e3')).toBe(true)
    // An item refused for where its words are carries no origin.
    expect(outcome.refused.every((refusal) => refusal.origin === undefined)).toBe(true)
  })
})

describe('references across episodes', () => {
  it('relates a later correction to an earlier claim, decided in order', async () => {
    const outcome = await submit(CORRECTION)
    const [old, fresh, fix] = outcome.suggestions
    expect(old?.origin?.episodeId.endsWith('#e1')).toBe(true)
    expect(fresh?.origin?.episodeId.endsWith('#e3')).toBe(true)
    expect(fix?.proposal).toEqual({
      kind: 'link',
      from: `cand:${old?.id}`,
      to: `cand:${fresh?.id}`,
      relation: 'evolves_to',
    })

    const early = await session.decide(fix?.id ?? '', { action: 'accept' }, 'learn-review')
    expect(early.ok ? undefined : early.refusal.code).toBe('depends_on_pending')
    const oldNode = await accept(old?.id)
    const newNode = await accept(fresh?.id)
    const edge = await accept(fix?.id)
    expect(session.graph.getEdge(edge)).toMatchObject({
      type: 'evolves_to',
      from: oldNode,
      to: newNode,
    })
    expect(session.graph.getNode(oldNode)?.revoked).not.toBe(true)
  })

  it('refuses the correction once the earlier claim is dismissed', async () => {
    const [old, fresh, fix] = (await submit(CORRECTION)).suggestions
    await session.decide(old?.id ?? '', { action: 'dismiss' }, 'learn-review')
    await accept(fresh?.id)
    const decided = await session.decide(fix?.id ?? '', { action: 'accept' }, 'learn-review')
    expect(decided.ok ? undefined : decided.refusal.code).toBe('unresolved_candidate')
  })

  it('revises a claim the learner kept in an earlier session', async () => {
    const earlier = await session.addNode({ label: '自注意力能看出顺序', kind: 'claim' })
    const outcome = await submit([
      node('new', '自注意力本身看不出顺序', '自注意力本身看不出顺序'),
      {
        kind: 'relation',
        from: earlier.nodeId,
        to: 'cand:new',
        relation: 'revises',
        quote: '我之前想错了',
        basis: 'stated',
        rationale: 'corrects what they held before',
      },
    ])
    const [fresh, fix] = outcome.suggestions
    const newNode = await accept(fresh?.id)
    const edge = await accept(fix?.id)
    expect(session.graph.getEdge(edge)).toMatchObject({ from: earlier.nodeId, to: newNode })
    expect(session.graph.getNode(earlier.nodeId)?.revoked).not.toBe(true)
  })

  it('reports what depends on a node the engine refused, under the host’s refs', async () => {
    await session.addNode({ label: '自注意力能看出顺序', kind: 'claim' })
    const outcome = await submit(CORRECTION)
    expect(codes(outcome)).toEqual({ old: 'already_known', fix: 'depends_on_refused' })
  })
})

describe('retries, repetitions and evolution', () => {
  it('answers a retried submission from what it stored, and writes nothing', async () => {
    const first = await submit(CORRECTION, { submissionId: 'sub-1' })
    const before = await files()
    const again = await submit(CORRECTION, { submissionId: 'sub-1' })
    expect(again.status).toBe('duplicate_submission')
    expect(again.sourceId).toBe(first.sourceId)
    expect(await files()).toEqual(before)
  })

  it('refuses a different request under the same key, and writes nothing', async () => {
    await submit(CORRECTION, { submissionId: 'sub-1' })
    const before = await files()
    for (const changed of [
      [CORRECTION[0], CORRECTION[1], { ...CORRECTION[2], rationale: 'changed' }],
      [CORRECTION[1], CORRECTION[0], CORRECTION[2]],
    ] as HostItem[][]) {
      const outcome = await session.distill(
        { text: DIALOGUE },
        {
          requestedBy: AGENT,
          learner: '学生',
          host: { candidates: changed, submissionId: 'sub-1' },
        },
      )
      expect(outcome.ok ? undefined : outcome.refusal.code).toBe('submission_conflict')
    }
    expect(await files()).toEqual(before)
  })

  it('keeps another agent’s submission under the same key apart', async () => {
    await submit(CORRECTION, { submissionId: 'sub-1' })
    const other = await submit([confused('cand:x', { occurrence: 1 })], {
      submissionId: 'sub-1',
      by: 'actor_agent_agent-b',
      text: '学生：我还是不明白。',
    })
    expect(other.status).toBe('pending')
  })

  it('does not queue the same words twice, and refers to what already waits', async () => {
    const first = await submit(CORRECTION, { hostSession: 'chat-1' })
    const second = await submit(CORRECTION, { hostSession: 'chat-1' })
    expect(session.sources()).toHaveLength(1)
    expect(second.sourceId).toBe(first.sourceId)
    expect(codes(second)).toEqual({
      old: 'already_pending',
      new: 'already_pending',
      fix: 'already_pending',
    })
    expect(second.suggestions).toEqual([])
  })

  it('does not queue the same words twice for Episteme’s own reader either', async () => {
    const first = await session.distill({ text: DIALOGUE })
    const second = await session.distill({ text: DIALOGUE })
    if (!first.ok || !second.ok) throw new Error('distillation was refused')
    expect(first.suggestions.length).toBeGreaterThan(0)
    expect(second.sourceId).toBe(first.sourceId)
    expect(second.suggestions).toEqual([])
    expect(new Set(second.refused.map((refusal) => refusal.code))).toEqual(
      new Set(['already_pending']),
    )
    expect(session.pendingSuggestions()).toHaveLength(first.suggestions.length)
  })

  it('keeps the same proposal from other words, or from another conversation', async () => {
    await submit(
      [node('a', '学习者还没懂', '我还是不明白。', { basis: 'inferred', occurrence: 1 })],
      {
        hostSession: 'chat-1',
      },
    )
    const elsewhere = await submit(
      [node('a', '学习者还没懂', '我还是不明白。', { basis: 'inferred', occurrence: 2 })],
      { hostSession: 'chat-1' },
    )
    // The same proposal from other words is another observation, not a repetition: it is kept.
    expect(codes(elsewhere)).toEqual({})
    const otherChat = await submit(
      [node('a', '学习者还没懂', '我还是不明白。', { basis: 'inferred', occurrence: 1 })],
      { hostSession: 'chat-2' },
    )
    expect(codes(otherChat)).toEqual({})
    expect(session.sources()).toHaveLength(2)
  })

  it('refuses only a second node for an idea the learner has, and keeps a new observation of it', async () => {
    const kept = await session.addNode({ label: '自注意力能看出顺序', kind: 'claim' })
    const outcome = await submit([node('n', '自注意力能看出顺序', '我原来以为自注意力能看出顺序')])
    expect(outcome.suggestions).toEqual([])
    expect(outcome.refused).toEqual([
      expect.objectContaining({ ref: 'n', code: 'already_known', existingNodeId: kept.nodeId }),
    ])
    expect(outcome.refused[0]?.origin?.excerpt).toBe('我原来以为自注意力能看出顺序')

    // What the new words show is sent against the node the learner has, with its own quote.
    const observed = await submit([confused(kept.nodeId, { occurrence: 2 })])
    expect(observed.suggestions).toHaveLength(1)
    const before = session.historyOf(kept.nodeId)?.length ?? 0
    await accept(observed.suggestions[0]?.id)
    expect(session.historyOf(kept.nodeId)).toHaveLength(before + 1)
  })
})

describe('a host that lost the connection, a learner who decided some, and a retry', () => {
  it('writes nothing again and tells what became of each candidate', async () => {
    // The host submits and the connection drops before it reads the result.
    const items = [
      ...CORRECTION,
      confused('cand:old', { occurrence: 1 }),
      node('bad', 'paraphrase', '自注意力不懂顺序'),
    ]
    await submit(items, { submissionId: 'sub-7', hostSession: 'chat-7' })
    const queued = session.pendingSuggestions()
    const old = queued.find((suggestion) => suggestion.proposal.kind === 'node')
    const fresh = queued.filter((suggestion) => suggestion.proposal.kind === 'node')[1]
    // The learner accepts the earlier claim and dismisses the correction; the rest still wait.
    const committed = await accept(old?.id)
    await session.decide(fresh?.id ?? '', { action: 'dismiss' }, 'learn-review')
    const before = await files()

    const retried = await submit(items, { submissionId: 'sub-7', hostSession: 'chat-7' })
    expect(await files()).toEqual(before)
    expect(retried.status).toBe('duplicate_submission')
    const receipt = retried.receipt
    expect(receipt).toMatchObject({
      submissionId: 'sub-7',
      submittedBy: AGENT,
      reader: 'host',
      hostSession: 'chat-7',
      refused: [{ ref: 'bad', code: 'quote_not_found' }],
    })
    expect(typeof receipt?.storedAt).toBe('number')
    const status = Object.fromEntries((receipt?.kept ?? []).map((entry) => [entry.ref, entry]))
    expect(status['old']).toMatchObject({
      status: 'accepted',
      committed: { kind: 'node', id: committed },
    })
    expect(status['new']).toMatchObject({ status: 'not_pending' })
    expect(status['new']).not.toHaveProperty('committed')
    expect(status['fix']).toMatchObject({ status: 'pending' })
    expect(status['confused-cand:old']).toMatchObject({ status: 'pending' })
    // Only what still waits comes back as suggestions; nothing is queued again.
    expect(retried.suggestions.map((suggestion) => suggestion.id).sort()).toEqual(
      session
        .pendingSuggestions()
        .map((suggestion) => suggestion.id)
        .sort(),
    )
  })
})

describe('drafts that failed to land (fault injection)', () => {
  /**
   * The drafts file is written to `<file>.tmp` and renamed. A directory at that path makes exactly that write
   * fail, every time, while the sources file (its own `.tmp`) and the graph are written normally: the state a
   * crash between the two writes leaves behind.
   */
  const blocked = () => `${graph}.suggestions.jsonl.tmp`
  const block = () => mkdir(blocked())
  const unblock = () => rm(blocked(), { recursive: true, force: true })
  const restart = async () => {
    await session.close()
    session = await LearnSession.open({ filePath: graph })
  }
  const landingRecords = async () =>
    (await readFile(`${graph}.suggestions.jsonl`, 'utf8').catch(() => ''))
      .split('\n')
      .filter((line) => line.includes('"kind":"landing"'))

  it('queues the candidates once when the request is retried after a restart', async () => {
    await block()
    await expect(submit(CORRECTION, { submissionId: 'sub-f' })).rejects.toThrow()
    // The source and the attempt were recorded; no draft reached the queue.
    expect(session.sources()).toHaveLength(1)
    expect(session.sources()[0]?.submissions).toHaveLength(1)
    expect(session.pendingSuggestions()).toEqual([])
    expect(await landingRecords()).toEqual([])

    await unblock()
    await restart()
    const retried = await submit(CORRECTION, { submissionId: 'sub-f' })
    // Read again, not answered as made: nothing of it had reached the queue.
    expect(retried.status).toBe('pending')
    expect(retried.suggestions).toHaveLength(3)
    expect(session.pendingSuggestions()).toHaveLength(3)
    expect(session.sources()).toHaveLength(1)
    expect(session.sources()[0]?.submissions).toHaveLength(1)
    expect(await landingRecords()).toHaveLength(1)
    // Every draft points at the source it came from.
    const [source] = session.sources()
    for (const suggestion of session.pendingSuggestions()) {
      expect(suggestion.origin?.sourceId).toBe(source?.id)
      expect(source?.text.slice(suggestion.origin?.span.start, suggestion.origin?.span.end)).toBe(
        suggestion.origin?.excerpt,
      )
    }

    // From here the submission is made: the same request again changes nothing.
    const before = await files()
    const again = await submit(CORRECTION, { submissionId: 'sub-f' })
    expect(again.status).toBe('duplicate_submission')
    expect(again.receipt?.kept.map((entry) => entry.status)).toEqual([
      'pending',
      'pending',
      'pending',
    ])
    expect(await files()).toEqual(before)
  })

  it('recovers the same way without a restart', async () => {
    await block()
    await expect(submit(CORRECTION, { submissionId: 'sub-g' })).rejects.toThrow()
    await unblock()
    const retried = await submit(CORRECTION, { submissionId: 'sub-g' })
    expect(retried.status).toBe('pending')
    expect(session.pendingSuggestions()).toHaveLength(3)
    expect(session.sources()).toHaveLength(1)
  })

  it('never answers an attempt whose drafts did not land as a submission that was made', async () => {
    await block()
    await expect(submit(CORRECTION, { submissionId: 'sub-h' })).rejects.toThrow()
    await unblock()
    // A different request under the key of an attempt that queued nothing is read, not refused as a
    // conflict, and no suggestion of the first attempt is ever reported, as dismissed or otherwise.
    const other = await submit([CORRECTION[0] as HostItem], { submissionId: 'sub-h' })
    expect(other.status).toBe('pending')
    expect(other.receipt).toBeUndefined()
    const again = await submit([CORRECTION[0] as HostItem], { submissionId: 'sub-h' })
    expect(again.receipt?.kept).toEqual([
      expect.objectContaining({ ref: 'old', status: 'pending' }),
    ])
  })

  it('calls a suggestion not_pending only when its landing shows it was queued', async () => {
    const made = await submit(CORRECTION, { submissionId: 'sub-i' })
    for (const suggestion of made.suggestions) {
      await session.decide(suggestion.id, { action: 'dismiss' }, 'learn-review')
    }
    expect(await landingRecords()).toHaveLength(1)
    const again = await submit(CORRECTION, { submissionId: 'sub-i' })
    expect(again.status).toBe('duplicate_submission')
    expect(again.receipt?.kept.map((entry) => entry.status)).toEqual([
      'not_pending',
      'not_pending',
      'not_pending',
    ])
  })
})

describe('the payload digest', () => {
  const base = { text: 'a\nb', candidates: [{ kind: 'node', ref: 'x', label: 'é' }] }

  it('is the same for the same canonical payload, however it was written', () => {
    expect(
      payloadDigest({
        text: 'a\r\nb',
        candidates: [{ label: 'é', ref: 'x', kind: 'node' }],
      }),
    ).toBe(payloadDigest(base))
  })

  it('tells an absent field from an empty one, and minds the order of candidates', () => {
    expect(payloadDigest({ ...base, hostSession: '' })).not.toBe(payloadDigest(base))
    expect(
      payloadDigest({ ...base, candidates: [...base.candidates, { kind: 'node', ref: 'y' }] }),
    ).not.toBe(
      payloadDigest({ ...base, candidates: [{ kind: 'node', ref: 'y' }, ...base.candidates] }),
    )
  })
})

describe('the drafts file', () => {
  it('still reads a version 2 file, which has no landing records', async () => {
    const path = join(directory, 'old.suggestions.jsonl')
    const v2 = {
      schemaVersion: 2,
      kind: 'suggestion',
      suggestion: {
        id: 'sug_old',
        proposal: { kind: 'claim', label: 'x' },
        rationale: 'r',
        proposedBy: 'actor_agent_old',
        proposedAt: 1,
      },
    }
    await writeFile(
      path,
      `${JSON.stringify(v2)}
`,
      'utf8',
    )
    const store = await SuggestionStore.open(path)
    expect(store.get('sug_old')?.proposal).toEqual({ kind: 'claim', label: 'x' })
    expect(store.landing('actor_agent_old', 'anything')).toBeUndefined()
  })
})

describe('the sources file', () => {
  it('still reads a version 1 record, and writes version 2 alongside it', async () => {
    const path = join(directory, 'old.sources.jsonl')
    const v1 = {
      schemaVersion: 1,
      kind: 'source',
      source: {
        id: 'src_old',
        title: 't',
        text: '学生：为什么？',
        kind: 'dialogue',
        episodes: [],
        addedAt: 1,
      },
    }
    await writeFile(path, `${JSON.stringify(v1)}\n`, 'utf8')
    const store = await SourceStore.open(path)
    expect(store.get('src_old')).toMatchObject({ reader: 'episteme', text: '学生：为什么？' })
    expect(store.get('src_old')?.digest).toMatch(/^[0-9a-f]{64}$/u)
    expect(store.reusable('学生：为什么？', 'episteme', undefined)?.id).toBe('src_old')
  })
})
