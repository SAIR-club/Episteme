import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearnSession, type Suggestion } from '@episteme/application'
import { seedTopic } from './fixtures.js'
import { asId, type DimensionId, type NodeId } from '@episteme/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * The distillation loop, end to end (ADR 0009): a real learning fragment in, distilled, reviewed, and only
 * what the learner decided in the graph and the history — still there after a restart, each part pointing
 * back at its words, and nothing they turned down or left undecided anywhere in it.
 */

const FRAGMENT = [
  '[00:05] 学生：为什么 Transformer 需要位置编码？',
  '[00:12] 老师：因为自注意力本身不区分词的顺序。例如把句子里的词打乱，注意力的输出只是跟着重新排列。',
  '[00:40] 学生：我明白了。',
  '[01:02] 学生：那「旋转位置编码」是怎么做的？',
  '[01:15] 老师：它把位置编码成向量的旋转，所以两个词的相对位置会体现在点积里。',
  '[01:50] 学生：这部分我还不太懂。',
].join('\n')

const QUESTION = '为什么 Transformer 需要位置编码？'
const CLAIM = '因为自注意力本身不区分词的顺序。'
const EVIDENCE = '例如把句子里的词打乱，注意力的输出只是跟着重新排列。'

let directory: string
let filePath: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-distil-loop-'))
  filePath = join(directory, 'learn.jsonl')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('the distillation loop', () => {
  it('takes a real fragment through distillation and review into the graph, and keeps only what was decided', async () => {
    let session = await LearnSession.open({ filePath })
    await seedTopic(session)
    const nodesBefore = session.listNodes().length

    // ── Input → distillation ──
    const outcome = await session.distill({ title: '位置编码', text: FRAGMENT })
    if (!outcome.ok) throw new Error(outcome.refusal.message)
    expect(outcome.episodes).toBe(2)

    const kinds = outcome.suggestions.map((suggestion) =>
      suggestion.proposal.kind === 'node' ? suggestion.proposal.nodeType : suggestion.proposal.kind,
    )
    expect(kinds.filter((kind) => kind === 'question')).toHaveLength(2)
    expect(kinds.filter((kind) => kind === 'claim')).toHaveLength(2)
    expect(kinds.filter((kind) => kind === 'evidence')).toHaveLength(1)
    // 「旋转位置编码」 is not a new concept here: the seeded graph already has it, as RoPE, so the distiller
    // links to that node instead of suggesting the term again.
    expect(kinds.filter((kind) => kind === 'concept')).toHaveLength(0)
    expect(
      outcome.suggestions.some(
        (suggestion) => suggestion.proposal.kind === 'link' && suggestion.proposal.to === 'c_rope',
      ),
    ).toBe(true)
    expect(kinds.filter((kind) => kind === 'state')).toHaveLength(2)
    expect(kinds.filter((kind) => kind === 'link').length).toBeGreaterThanOrEqual(4)

    // ── Nothing recorded by distilling ──
    expect(session.eventCount).toBe(0)
    expect(session.listNodes()).toHaveLength(nodesBefore)

    // ── Review ──
    const label = (text: string) =>
      outcome.suggestions.find(
        (suggestion) => 'label' in suggestion.proposal && suggestion.proposal.label === text,
      ) as Suggestion
    const said = (excerpt: string) =>
      outcome.suggestions.find(
        (suggestion) =>
          suggestion.proposal.kind === 'state' && suggestion.origin?.excerpt === excerpt,
      ) as Suggestion
    const answers = outcome.suggestions.find(
      (suggestion) =>
        suggestion.proposal.kind === 'link' &&
        suggestion.proposal.relation === 'answers' &&
        suggestion.proposal.to === `cand:${label(QUESTION).id}`,
    ) as Suggestion

    const question = await session.decide(label(QUESTION).id, { action: 'accept' }, 'learn-review')
    const claim = await session.decide(label(CLAIM).id, { action: 'accept' }, 'learn-review')
    const link = await session.decide(answers.id, { action: 'accept' }, 'learn-review')
    // The learner says they are less sure than "我明白了" suggested: their own value, not the agent's.
    const state = await session.decide(
      said('我明白了。').id,
      {
        action: 'modify',
        proposal: {
          kind: 'state',
          target: `cand:${label(QUESTION).id}`,
          dimension: 'confidence',
          level: 'low',
        },
      },
      'learn-review',
    )
    const dismissed = await session.decide(
      label(EVIDENCE).id,
      { action: 'dismiss' },
      'learn-review',
    )

    for (const result of [question, claim, link, state, dismissed]) expect(result.ok).toBe(true)
    if (
      !question.ok ||
      question.outcome === 'dismissed' ||
      !claim.ok ||
      claim.outcome === 'dismissed'
    ) {
      throw new Error('expected nodes')
    }
    const questionId = question.committed.id
    const claimId = claim.committed.id
    await session.close()

    // ── After a restart ──
    session = await LearnSession.open({ filePath })

    // The nodes: what was accepted, with which suggestion and which words it came from.
    for (const [id, suggestion, text] of [
      [questionId, label(QUESTION), QUESTION],
      [claimId, label(CLAIM), CLAIM],
    ] as const) {
      const node = session.graph.getNode(asId<NodeId>(id))
      expect(node?.label).toBe(text)
      expect(node?.properties['suggestion']).toBe(suggestion.id)
      const origin = node?.properties['origin'] as {
        sourceId: string
        span: { start: number; end: number }
      }
      expect(FRAGMENT.slice(origin.span.start, origin.span.end)).toBe(text)
      expect(origin.sourceId).toBe(outcome.sourceId)
    }

    // The edge: the claim answers the question.
    expect(
      session.graph
        .listEdges()
        .some((edge) => edge.type === 'answers' && edge.from === claimId && edge.to === questionId),
    ).toBe(true)

    // The history: one event, the learner's own value, traced to the suggestion it modified.
    const history = session.log.history({
      target: asId<NodeId>(questionId),
      actorId: session.actorId,
    })
    expect(history).toHaveLength(1)
    const value = history[0]?.dimensions.get(asId<DimensionId>('confidence'))
    expect(value).toEqual({ level: 'low', sourceOf: said('我明白了。').id })
    expect(history[0]?.actorId).toBe(session.actorId)
    expect(session.eventCount).toBe(1)

    // Nothing turned down or left undecided is in the graph.
    const labels = session.listNodes().map((node) => node.label)
    expect(labels).not.toContain(EVIDENCE)
    expect(labels).not.toContain('旋转位置编码')
    expect(labels).not.toContain('那「旋转位置编码」是怎么做的？')
    expect(session.listNodes()).toHaveLength(nodesBefore + 2)

    // The undecided still wait, and the material is still beside the graph, never in it.
    expect(session.pendingSuggestions().length).toBe(outcome.suggestions.length - 5)
    expect(session.sources().map((source) => source.id)).toEqual([outcome.sourceId])
    expect(await readFile(filePath, 'utf8')).not.toContain('老师：')
    await session.close()
  })

  it('records an accepted change of understanding as the learner’s, confirmed by them', async () => {
    const session = await LearnSession.open({ filePath })
    await seedTopic(session)
    const outcome = await session.distill({ text: FRAGMENT })
    if (!outcome.ok) throw new Error(outcome.refusal.message)
    const question = outcome.suggestions.find(
      (suggestion) => suggestion.proposal.kind === 'node' && suggestion.proposal.label === QUESTION,
    ) as Suggestion
    const understood = outcome.suggestions.find(
      (suggestion) =>
        suggestion.proposal.kind === 'state' && suggestion.origin?.excerpt === '我明白了。',
    ) as Suggestion

    const node = await session.decide(question.id, { action: 'accept' }, 'learn-review')
    await session.decide(understood.id, { action: 'accept' }, 'learn-review')
    if (!node.ok || node.outcome === 'dismissed') throw new Error('expected a node')

    const [event] = session.log.history({
      target: asId<NodeId>(node.committed.id),
      actorId: session.actorId,
    })
    expect(event?.dimensions.get(asId<DimensionId>('confidence'))).toEqual({
      level: 'medium',
      authority: 'confirmed',
      confirmedBy: session.actorId,
      sourceOf: understood.id,
    })
    await session.close()
  })
})
