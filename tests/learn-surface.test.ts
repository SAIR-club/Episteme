import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearnCli, RESERVED_WORDS, optionValue } from '@episteme/app-learn'
import { LearnSession } from '@episteme/application'
import { seedTopic } from '@episteme/application/seed'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * The Learn interaction surface.
 *
 * Phases 0–2 proved the *machinery*: history is append-only, state survives a restart, a paraphrase reaches
 * stored cognition. None of that tested whether a person can actually use it. This file tests the surface
 * itself, and it asserts the three things that make it a surface rather than a wrapper:
 *
 * 1. a learner can ask in their own words and get the retrieval *reasons*, not just an answer;
 * 2. recording understanding changes the next answer, and the change is caused by the record;
 * 3. the whole loop survives closing and reopening the process.
 */

let directory: string
let filePath: string

/** Collects output instead of printing it, so a test can assert on what a learner would see. */
function collector(): { write(text: string): void; text(): string } {
  let buffer = ''
  return {
    write: (text: string) => {
      buffer += text
    },
    text: () => buffer,
  }
}

async function openCli(): Promise<{ cli: LearnCli; out: ReturnType<typeof collector> }> {
  const out = collector()
  const cli = await LearnCli.open(out, { filePath })
  return { cli, out }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-learn-'))
  filePath = join(directory, 'learn.jsonl')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('asking in the learner\u2019s own words', () => {
  it('answers a question that starts with "why"', async () => {
    const { cli, out } = await openCli()

    // This is the regression that matters most, and it was real: the evidence command was called `why`, so
    // `why is order hard for attention` was parsed as the command plus an argument and the question was
    // silently discarded. The most natural opening word for a question about causation must not be a
    // command.
    await cli.handle('why is order hard for attention')

    // The seeded node's label, which is Chinese with the English term in parentheses.
    expect(out.text()).toContain('为什么 Transformer 必须被告知序列顺序')
    expect(out.text()).not.toContain('还没有提过问题')
  })

  it('treats an unknown first word as a question, not as an error', async () => {
    const { cli, out } = await openCli()
    await cli.handle('does attention see the order of tokens')

    expect(out.text()).not.toContain('unknown command')
    expect(out.text()).toContain('检索到的内容，按相关度排序')
  })

  it('shows why each node was retrieved, in the learner\u2019s terms', async () => {
    const { cli, out } = await openCli()
    await cli.handle('why is order hard for attention')
    await cli.handle('explain')

    const text = out.text()
    // The explanation names the signal, the arithmetic and what it means. Signal names stay English because
    // they are identifiers; the reading of them is Chinese.
    expect(text).toContain('semantic')
    expect(text).toContain('graph')
    expect(text).toContain('和你的问题在含义上相近')
    // And it shows the weights, so the ranking is checkable rather than authoritative.
    expect(text).toContain('权重')
    expect(text).toContain('semantic=0.5')
  })

  it('never reserves a word a learner would open a question with', async () => {
    // A negative property, asserted because losing it was invisible: the command table grew a `why` entry
    // and every question beginning with that word stopped working, with no error to notice.
    const out = collector()
    const cli = await LearnCli.open(out, { filePath })
    for (const word of RESERVED_WORDS) {
      await cli.handle(`${word} something about attention`)
      expect(out.text(), `"${word}" must be treated as a question`).not.toContain('还没有提过问题')
    }
  })
})

describe('recording understanding changes the next answer', () => {
  it('moves the learner\u2019s own claim up and changes the answer', async () => {
    const first = await openCli()
    await first.cli.handle('claim self-attention cannot tell which word came first')
    const before = await first.cli.session.ask('why is order hard for attention')

    // Nothing recorded yet: the claim is retrieved on meaning alone, and the answer has to establish ground.
    expect(before.usedContext).toBe(false)
    const claimBefore = before.ranked.find((entry) => entry.nodeId === 'claim_1')
    expect(claimBefore).toBeDefined()

    await first.cli.handle('record claim_1 confidence low')
    await first.cli.handle('record claim_1 conflict open')

    const after = await first.cli.session.ask('why is order hard for attention')

    // The answer now builds on the record, and says so as data rather than prose.
    expect(after.usedContext).toBe(true)
    expect(after.summary).toContain('conflict=open')
    expect(after.answer).not.toBe(before.answer)

    // And the claim the learner recorded understanding about now ranks above where it was — the cognitive
    // signal is what moved it, which is the whole reason state participates in ranking.
    const claimAfter = after.ranked.find((entry) => entry.nodeId === 'claim_1')
    expect(claimAfter).toBeDefined()
    expect(claimAfter?.score ?? 0).toBeGreaterThan(claimBefore?.score ?? 0)

    const cognitive = claimAfter?.reasons.find((reason) => reason.signal === 'cognitive')
    expect(cognitive?.value ?? 0).toBeGreaterThan(0)
  })

  it('records the understanding as the human, never the agent', async () => {
    const { cli } = await openCli()
    await cli.handle('claim a claim of my own')
    const recorded = await cli.session.record('claim_1', { confidence: 'high' })

    const log = cli.session.log
    const event = log.getEvent(recorded.eventId)
    expect(event?.actorId).toBe(cli.session.actorId)
    // The command surface has no way to name another actor, which is the property being asserted: a caller
    // cannot accidentally author someone else's understanding through it.
    expect(event?.actorId).not.toBe('actor_scaffold')
  })

  it('refuses an ambiguous node reference instead of guessing', async () => {
    const { cli, out } = await openCli()
    await cli.handle('claim first claim')
    await cli.handle('claim second claim')
    out.write('') // reset nothing; just keep the collector honest
    const before = out.text().length

    // "claim" alone matches both claims. Recording understanding against the wrong node would be a
    // permanent, validated, wrong fact, so the surface must ask rather than pick.
    await cli.handle('record claim confidence low')

    const added = out.text().slice(before)
    expect(added).toContain('请说得更具体')
    expect(added).not.toContain('已记录')
  })

  it('refuses a level a dimension does not have', async () => {
    const { cli, out } = await openCli()
    await cli.handle('claim a claim')
    const before = out.text().length

    await cli.handle('record claim_1 confidence very-high')

    expect(out.text().slice(before)).toContain('不是 confidence 的合法取值')
  })
})

describe('the loop survives closing the surface', () => {
  it('reloads the learner\u2019s own nodes and their understanding', async () => {
    const first = await openCli()
    await first.cli.handle('claim order cannot be recovered from attention alone')
    await first.cli.handle('record claim_1 confidence medium')
    await first.cli.handle('record claim_1 articulation low')
    await first.cli.close()

    // A second surface over the same file, with nothing carried in memory.
    const second = await openCli()
    const nodes = second.cli.session.listNodes()
    expect(nodes.map((node) => node.nodeId)).toContain('claim_1')

    const understanding = second.cli.session.understandingOf('claim_1')
    expect(understanding).toEqual([
      { id: 'articulation', level: 'low' },
      { id: 'confidence', level: 'medium' },
    ])

    // The seeded topic was not seeded twice.
    const seededTwice = await seedTopic(second.cli.session)
    expect(seededTwice.seeded).toBe(false)

    const answer = await second.cli.session.ask('why is order hard for attention')
    expect(answer.usedContext).toBe(true)
    expect(answer.summary).toContain('articulation=low')
  })

  it('answers identically for the same question over the same history', async () => {
    // Determinism is what makes the surface testable at all, and it holds because the retrievers and the
    // responder are deterministic.
    const first = await openCli()
    await first.cli.handle('claim a deterministic claim')
    await first.cli.handle('record claim_1 confidence high')
    const a = await first.cli.session.ask('is order hard for attention')
    // One owner at a time: the second surface opens the history only after the first has let it go.
    await first.cli.close()

    const second = await openCli()
    const b = await second.cli.session.ask('is order hard for attention')

    expect(b.answer).toBe(a.answer)
    expect(b.ranked.map((entry) => entry.nodeId)).toEqual(a.ranked.map((entry) => entry.nodeId))
  })
})

describe('the answer is in the learner\u2019s language', () => {
  it('answers in Chinese, not English', async () => {
    const { cli } = await openCli()
    const cold = await cli.session.ask('为什么模型必须知道每个词的先后顺序')
    expect(cold.usedContext).toBe(false)
    expect(cold.answer).toContain('我们先打下地基')

    await cli.handle('claim 自注意力本身无法表达顺序')
    await cli.handle('record claim_1 confidence low')
    const warm = await cli.session.ask('为什么模型必须知道每个词的先后顺序')

    expect(warm.usedContext).toBe(true)
    // The three branches produce structurally different answers, not reworded ones.
    expect(warm.answer).toContain('还没有把任何一部分标记为确定')
    expect(warm.answer).not.toBe(cold.answer)

    await cli.handle('record claim_1 articulation high')
    const settled = await cli.session.ask('为什么模型必须知道每个词的先后顺序')
    expect(settled.answer).toContain('既然你已经理解了')
  })

  it('refuses to build on a position the learner marked as contested', async () => {
    const { cli } = await openCli()
    await cli.handle('claim 自注意力本身无法表达顺序')
    await cli.handle('record claim_1 confidence high')
    await cli.handle('record claim_1 conflict open')

    const answer = await cli.session.ask('为什么模型必须知道每个词的先后顺序')

    // This branch is the reason the cognitive signal exists: an unresolved conflict has to change what the
    // system is willing to do, not merely what it says.
    expect(answer.answer).toContain('还没解决的冲突')
    expect(answer.answer).toContain('不会把它当成已经确定的结论')
  })

  it('reports an empty understanding in Chinese, not the package\u2019s English sentence', async () => {
    const { cli } = await openCli()
    const result = await cli.session.ask('为什么这里会这样')

    // `contextSummary` in the domain package returns English prose ("nothing is recorded about this yet"),
    // which leaked into a Chinese interface. The Learn surface decides its own wording so every view reads
    // the same and no view invents a second phrasing.
    expect(result.summary).toBe('关于这个，你还没有记录过任何东西')
    expect(result.summary).not.toContain('nothing is recorded')
  })

  it('reports retrieval reasons in Chinese as well', async () => {
    const { cli } = await openCli()
    const result = await cli.session.ask('为什么模型必须知道每个词的先后顺序')

    const reason = result.ranked[0]?.reasons.find((entry) => entry.signal === 'semantic')
    expect(reason?.explanationZh).toContain('和你的问题在含义上相近')
    expect(reason?.labelZh).toBe('语义')
    // English stays available for the docs, tests and CLI output.
    expect(reason?.explanation).toContain('close in meaning')
  })
})

describe('command-line options', () => {
  it('accepts both the separated and the joined spelling of a flag', () => {
    // Both, because which one works is a coin flip in most tools, and a learner who guessed wrong would
    // silently get the default graph file — recording their understanding somewhere they did not intend.
    expect(optionValue(['--file', '/tmp/a.jsonl'], '--file', '-f')).toBe('/tmp/a.jsonl')
    expect(optionValue(['--file=/tmp/a.jsonl'], '--file', '-f')).toBe('/tmp/a.jsonl')
    expect(optionValue(['-f', '/tmp/a.jsonl'], '--file', '-f')).toBe('/tmp/a.jsonl')
    expect(optionValue(['-f=/tmp/a.jsonl'], '--file', '-f')).toBe('/tmp/a.jsonl')
  })

  it('returns nothing rather than a flag when the value is missing', () => {
    // `--file` followed by another flag is a mistake; treating the flag itself as a path would create a
    // file literally named `--port`.
    expect(optionValue(['--file', '--port'], '--file', '-f')).toBeUndefined()
    expect(optionValue(['--file='], '--file', '-f')).toBeUndefined()
    expect(optionValue([], '--file', '-f')).toBeUndefined()
    expect(optionValue(['--other', 'x'], '--file', '-f')).toBeUndefined()
  })

  it('takes the first occurrence when a flag is repeated', () => {
    expect(optionValue(['--file', 'a', '--file', 'b'], '--file')).toBe('a')
  })
})

describe('the surface reports its own relevance model', () => {
  it('exposes the weights it actually used', async () => {
    const { cli } = await openCli()
    const rules = cli.session.rules
    expect(rules.map((rule) => rule.signal).sort()).toEqual([
      'cognitive',
      'graph',
      'lexical',
      'recency',
      'semantic',
    ])
    // The invariant the weights encode: no signal may dominate.
    for (const rule of rules) {
      expect(rule.weight).toBeLessThanOrEqual(0.5)
      expect(rule.weight).toBeGreaterThan(0)
    }
  })

  it('says which retriever produced a result', async () => {
    const { cli } = await openCli()
    const result = await cli.session.ask('anything')
    expect(result.retriever).toBe('hybrid')
  })
})

describe('session isolation', () => {
  it('keeps one session\u2019s history out of another file', async () => {
    const other = join(directory, 'other.jsonl')
    const first = await openCli()
    await first.cli.handle('claim only in the first file')

    const out = collector()
    const second = await LearnCli.open(out, { filePath: other })
    expect(second.session.listNodes().map((node) => node.nodeId)).not.toContain('claim_1')
  })
})

describe('an in-memory session still works', () => {
  it('runs the loop without a file, for a test or a try-out', async () => {
    const session = await LearnSession.open({})
    await seedTopic(session)
    await session.addNode({ label: 'attention cannot tell which word came first', kind: 'claim' })

    // The question has to actually reach the claim, or the assertion below would be about nothing: a vague
    // question leaves the claim below the relevance floor and `usedContext` stays false for a reason that
    // has nothing to do with the file being absent.
    const question = 'can attention tell which word came first'
    const before = await session.ask(question)
    expect(before.ranked.map((entry) => entry.nodeId)).toContain('claim_1')
    expect(before.usedContext).toBe(false)

    await session.record('claim_1', { confidence: 'low' })
    const after = await session.ask(question)

    expect(after.usedContext).toBe(true)
    expect(after.known.map((entry) => entry.nodeId)).toContain('claim_1')
  })
})
