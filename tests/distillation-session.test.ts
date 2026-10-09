import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LearnSession,
  MAX_MATERIAL,
  type DistillOutcome,
  type Suggestion,
} from '@episteme/application'
import { seedTopic } from './fixtures.js'
import { asId, type NodeId } from '@episteme/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Distillation inside a learner's session (ADR 0009): material in, pending suggestions out, nothing recorded
 * until the learner decides, and what they keep carries the words it came from.
 */

const DIALOGUE = [
  '[00:05] 学生：为什么 Transformer 需要位置编码？',
  '[00:12] 老师：因为自注意力本身不区分词的顺序。例如把句子里的词打乱，注意力的输出只是跟着重新排列。',
  '[00:40] 学生：我明白了。',
].join('\n')

let directory: string
let filePath: string
let session: LearnSession

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-distil-'))
  filePath = join(directory, 'learn.jsonl')
  session = await LearnSession.open({ filePath })
  await seedTopic(session)
})

afterEach(async () => {
  await session.close()
  await rm(directory, { recursive: true, force: true })
})

async function distilled(): Promise<Extract<DistillOutcome, { ok: true }>> {
  const outcome = await session.distill(
    { title: '位置编码', text: DIALOGUE },
    { requestedBy: 'actor_agent_test-host' },
  )
  if (!outcome.ok) throw new Error(outcome.refusal.message)
  return outcome
}

/** The suggestion that proposes a node with this label, or a link or state change matching `where`. */
function find(
  outcome: { suggestions: readonly Suggestion[] },
  where: (suggestion: Suggestion) => boolean,
) {
  const found = outcome.suggestions.find(where)
  if (found === undefined) throw new Error('no such suggestion')
  return found
}
const nodeNamed = (label: string) => (suggestion: Suggestion) =>
  suggestion.proposal.kind === 'node' && suggestion.proposal.label === label
const linkOf = (relation: string) => (suggestion: Suggestion) =>
  suggestion.proposal.kind === 'link' && suggestion.proposal.relation === relation
const stateChange = (suggestion: Suggestion) => suggestion.proposal.kind === 'state'

const QUESTION = '为什么 Transformer 需要位置编码？'
const CLAIM = '因为自注意力本身不区分词的顺序。'
const EVIDENCE = '例如把句子里的词打乱，注意力的输出只是跟着重新排列。'

describe('distilling material', () => {
  it('keeps the material beside the graph and records nothing in it', async () => {
    const graphBefore = await readFile(filePath, 'utf8')
    const outcome = await distilled()

    expect(outcome.episodes).toBe(1)
    expect(outcome.suggestions).toHaveLength(9)
    expect(outcome.refused).toEqual([])
    expect(session.eventCount).toBe(0)
    expect(await readFile(filePath, 'utf8')).toBe(graphBefore)

    const [source] = session.sources()
    expect(source).toMatchObject({
      id: outcome.sourceId,
      title: '位置编码',
      text: DIALOGUE,
      kind: 'dialogue',
    })
    expect(source?.requestedBy).toBe('actor_agent_test-host')
    expect(await readFile(`${filePath}.sources.jsonl`, 'utf8')).toContain(outcome.sourceId)
  })

  it('gives every suggestion the words it came from, and says who proposed it and who asked', async () => {
    const outcome = await distilled()
    for (const suggestion of outcome.suggestions) {
      const origin = suggestion.origin
      expect(origin?.sourceId).toBe(outcome.sourceId)
      expect(DIALOGUE.slice(origin?.span.start, origin?.span.end)).toBe(origin?.excerpt)
      expect(suggestion.proposedBy).toBe('actor_agent_rule-based-distiller')
      expect(suggestion.requestedBy).toBe('actor_agent_test-host')
    }
    expect(find(outcome, stateChange).origin?.excerpt).toBe('我明白了。')
  })

  it('refers between suggestions of the same material by their ids', async () => {
    const outcome = await distilled()
    const question = find(outcome, nodeNamed(QUESTION))
    const claim = find(outcome, nodeNamed(CLAIM))
    expect(find(outcome, linkOf('answers')).proposal).toEqual({
      kind: 'link',
      from: `cand:${claim.id}`,
      to: `cand:${question.id}`,
      relation: 'answers',
    })
    expect(find(outcome, stateChange).proposal).toEqual({
      kind: 'state',
      target: `cand:${question.id}`,
      dimension: 'confidence',
      level: 'medium',
    })
  })

  it('refuses material that is empty or too long, keeping nothing', async () => {
    expect(await session.distill({ text: '   ' })).toMatchObject({
      ok: false,
      refusal: { code: 'empty_material' },
    })
    expect(await session.distill({ text: 'x'.repeat(MAX_MATERIAL + 1) })).toMatchObject({
      ok: false,
      refusal: { code: 'material_too_long' },
    })
    expect(session.sources()).toEqual([])
    expect(session.pendingSuggestions()).toEqual([])
  })
})

describe('deciding what was distilled', () => {
  it('accepts a dependent suggestion only after what it depends on', async () => {
    const outcome = await distilled()
    const answers = find(outcome, linkOf('answers'))
    const state = find(outcome, stateChange)

    expect(await session.decide(answers.id, { action: 'accept' }, 'learn-review')).toMatchObject({
      ok: false,
      refusal: { code: 'depends_on_pending' },
    })
    expect(await session.decide(state.id, { action: 'accept' }, 'learn-review')).toMatchObject({
      ok: false,
      refusal: { code: 'depends_on_pending' },
    })

    const question = await session.decide(
      find(outcome, nodeNamed(QUESTION)).id,
      { action: 'accept' },
      'learn-review',
    )
    const claim = await session.decide(
      find(outcome, nodeNamed(CLAIM)).id,
      { action: 'accept' },
      'learn-review',
    )
    if (
      !question.ok ||
      question.outcome === 'dismissed' ||
      !claim.ok ||
      claim.outcome === 'dismissed'
    ) {
      throw new Error('expected the question and the claim to be accepted')
    }

    const link = await session.decide(answers.id, { action: 'accept' }, 'learn-review')
    expect(link.ok).toBe(true)
    const edge = session.graph
      .listEdges()
      .find((candidate) => candidate.type === 'answers' && candidate.from === claim.committed.id)
    expect(edge?.to).toBe(question.committed.id)

    const confirmed = await session.decide(state.id, { action: 'accept' }, 'learn-review')
    expect(confirmed.ok).toBe(true)
    const [event] = session.log.history({
      target: asId<NodeId>(question.committed.id),
      actorId: session.actorId,
    })
    expect(event?.dimensions.get(asId('confidence'))).toMatchObject({
      level: 'medium',
      authority: 'confirmed',
      confirmedBy: session.actorId,
      sourceOf: state.id,
    })
  })

  it('records on an accepted node which suggestion and which words it came from', async () => {
    const outcome = await distilled()
    const evidence = find(outcome, nodeNamed(EVIDENCE))
    const result = await session.decide(evidence.id, { action: 'accept' }, 'learn-review')
    if (!result.ok || result.outcome === 'dismissed') throw new Error('expected a node')

    const node = session.graph.getNode(asId<NodeId>(result.committed.id))
    expect(node?.type).toBe('evidence')
    expect(node?.properties).toMatchObject({
      text: EVIDENCE,
      kind: 'example',
      suggestion: evidence.id,
      origin: evidence.origin,
    })
  })

  it('records the learner’s own wording when they modify a distilled node', async () => {
    const outcome = await distilled()
    const claim = find(outcome, nodeNamed(CLAIM))
    const result = await session.decide(
      claim.id,
      {
        action: 'modify',
        proposal: { kind: 'node', nodeType: 'claim', label: '注意力对顺序不敏感' },
      },
      'learn-review',
    )
    if (!result.ok || result.outcome === 'dismissed') throw new Error('expected a node')
    expect(session.graph.getNode(asId<NodeId>(result.committed.id))?.label).toBe(
      '注意力对顺序不敏感',
    )
  })

  it('leaves what depended on a dismissed suggestion with nothing to attach to', async () => {
    const outcome = await distilled()
    await session.decide(
      find(outcome, nodeNamed(QUESTION)).id,
      { action: 'dismiss' },
      'learn-review',
    )
    await session.decide(find(outcome, nodeNamed(CLAIM)).id, { action: 'accept' }, 'learn-review')

    expect(
      await session.decide(
        find(outcome, linkOf('answers')).id,
        { action: 'accept' },
        'learn-review',
      ),
    ).toMatchObject({ ok: false, refusal: { code: 'unresolved_candidate' } })
    expect(
      await session.decide(find(outcome, stateChange).id, { action: 'accept' }, 'learn-review'),
    ).toMatchObject({ ok: false, refusal: { code: 'unresolved_candidate' } })
    expect(session.eventCount).toBe(0)
  })

  it('links an accepted claim to what the learner already had', async () => {
    const outcome = await distilled()
    const claim = await session.decide(
      find(outcome, nodeNamed(CLAIM)).id,
      { action: 'accept' },
      'learn-review',
    )
    if (!claim.ok || claim.outcome === 'dismissed') throw new Error('expected a claim')
    const about = find(
      outcome,
      (suggestion) =>
        suggestion.proposal.kind === 'link' && suggestion.proposal.to === 'c_self_attention',
    )
    expect((await session.decide(about.id, { action: 'accept' }, 'learn-review')).ok).toBe(true)
    expect(
      session.graph
        .listEdges()
        .some((edge) => edge.from === claim.committed.id && edge.to === 'c_self_attention'),
    ).toBe(true)
  })

  it('survives a restart: sources, pending suggestions and their references', async () => {
    const outcome = await distilled()
    await session.decide(
      find(outcome, nodeNamed(QUESTION)).id,
      { action: 'accept' },
      'learn-review',
    )
    await session.close()

    session = await LearnSession.open({ filePath })
    expect(session.sources().map((source) => source.id)).toEqual([outcome.sourceId])
    expect(session.pendingSuggestions()).toHaveLength(8)
    const state = find({ suggestions: session.pendingSuggestions() }, stateChange)
    expect((await session.decide(state.id, { action: 'accept' }, 'learn-review')).ok).toBe(true)
  })

  it('settles a node decision whose graph write failed, without adding the node twice', async () => {
    const outcome = await distilled()
    const question = find(outcome, nodeNamed(QUESTION))

    await rm(filePath)
    await mkdir(filePath)
    await writeFile(join(filePath, 'blocker'), '', 'utf8')
    await expect(
      session.decide(question.id, { action: 'accept' }, 'learn-review'),
    ).rejects.toThrow()
    await rm(filePath, { recursive: true })

    expect(await session.decide(question.id, { action: 'accept' }, 'learn-review')).toMatchObject({
      ok: false,
      refusal: { code: 'unknown_suggestion' },
    })
    expect(session.listNodes().filter((node) => node.label === QUESTION)).toHaveLength(1)
  })
})
