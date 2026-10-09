import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentResponse,
  AgentWorkspace,
  CandidateNode,
  CognitiveAgent,
  Suggestion,
} from '@episteme/agent'
import {
  LearnSession,
  defaultDistillationPolicy as learnDistillationPolicy,
} from '@episteme/application'
import { RuleBasedDistiller, distill, type Candidate } from '@episteme/distillation'
import { BLANK_TOPIC, learnProfile, startService } from '@episteme/service'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Strict quotes and the foundations host-assisted distillation stands on (ADR 0011, #21, PR-A).
 *
 * A quote is found exactly in the canonical text or refused, never widened; a quote said twice must say which
 * time; whether the learner said something is checked against who spoke; and nothing reaches the graph before
 * the learner decides.
 */

/** Two episodes: the second opens with the learner's question about 熵. "我还是不明白。" occurs twice in the first. */
const DIALOGUE = [
  '学生：为什么需要位置编码？',
  '老师：因为自注意力本身不区分词的顺序。',
  '学生：我还是不明白。',
  '老师：把词打乱，输出只是跟着重新排列。',
  '学生：我还是不明白。',
  '学生：那「熵」是什么？',
  '老师：熵衡量的是不确定性。',
].join('\n')

type Script = Partial<
  Record<'structure' | 'connections' | 'state', Readonly<Record<number, Suggestion[]>>>
>

/** A reader that says exactly what it is told, per episode (1-based), and remembers what it was shown. */
function reader(script: Script, seen: AgentWorkspace[] = []): CognitiveAgent {
  const episodeOf = (workspace: AgentWorkspace): number =>
    Number(workspace.material?.episodeId.split('#e')[1] ?? 0)
  const say =
    (part: keyof Script) =>
    (workspace: AgentWorkspace): Promise<readonly Suggestion[]> => {
      seen.push(workspace)
      return Promise.resolve(script[part]?.[episodeOf(workspace)] ?? [])
    }
  return {
    id: 'scripted-reader',
    description: 'says what the test tells it to',
    respond: (): Promise<AgentResponse> => Promise.resolve({ text: '', usedContext: false }),
    suggestStructure: say('structure'),
    suggestConnections: say('connections'),
    suggestStateChange: say('state'),
  }
}

const claim = (ref: string, label: string, quote?: string): Suggestion => ({
  kind: 'node',
  nodeType: 'claim',
  label,
  ref,
  rationale: 'r',
  ...(quote === undefined ? {} : { quote }),
})

const state = (
  target: string,
  dimension: string,
  level: string,
  quote: string,
  extra: Partial<Suggestion> = {},
): Suggestion =>
  ({
    kind: 'state',
    target,
    actorId: 'actor_human',
    dimensions: { [dimension]: { level, authority: 'suggested' } },
    evidence: [],
    rationale: 'r',
    quote,
    ...extra,
  }) as Suggestion

async function run(
  agent: CognitiveAgent,
  text = DIALOGUE,
  learner?: string,
): Promise<readonly Candidate[]> {
  const result = await distill({
    material: { sourceId: 'src', text },
    agent,
    policy: learnDistillationPolicy,
    actorId: 'actor_human',
    known: [],
    ...(learner === undefined ? {} : { learner }),
  })
  return result.candidates
}

function byRef(candidates: readonly Candidate[], ref: string): Candidate {
  const found = candidates.find((candidate) => candidate.ref === ref)
  if (found === undefined) throw new Error(`no candidate ${ref}`)
  return found
}

function wordsAt(text: string, candidate: Candidate): string | undefined {
  return candidate.origin === undefined
    ? undefined
    : text.slice(candidate.origin.span.start, candidate.origin.span.end)
}

describe('the canonical text, and spans that point into it', () => {
  let directory: string
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'episteme-strict-'))
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('stores canonical text and a span that slices to the quote, also after a restart', async () => {
    // CRLF line endings, a decomposed é (e + U+0301), and Chinese; the quote is in NFC, after the é.
    const sent = '学生：café 是什么意思？\r\n老师：Café 的 crème 来自法语。\r\n'.replace(/é/gu, 'é')
    const quote = 'crème 来自法语'
    const graph = join(directory, 'learn.jsonl')
    let session = await LearnSession.open({ filePath: graph })
    const outcome = await session.distill(
      { text: sent },
      { agent: reader({ structure: { 1: [claim('c1', 'Crème comes from French', quote)] } }) },
    )
    expect(outcome.ok).toBe(true)
    const check = (current: LearnSession): void => {
      const [source] = current.sources()
      const [pending] = current.pendingSuggestions()
      expect(source?.text).toBe(sent.replace(/\r\n/gu, '\n').normalize('NFC'))
      expect(source?.text).not.toContain('\r')
      const span = pending?.origin?.span
      expect(span).toBeDefined()
      expect(source?.text.slice(span?.start, span?.end)).toBe(quote)
      expect(pending?.origin?.excerpt).toBe(quote)
    }
    check(session)
    await session.close()
    session = await LearnSession.open({ filePath: graph })
    check(session)
    await session.close()
  })
})

describe('a quote is located or refused, never widened', () => {
  it('refuses words that are not in the material, and gives them no origin', async () => {
    const candidates = await run(
      reader({ structure: { 1: [claim('c1', 'a paraphrase', '自注意力看不出顺序')] } }),
    )
    const refused = byRef(candidates, 'e1.c1')
    expect(refused.refusal?.code).toBe('quote_not_found')
    expect(refused.origin).toBeUndefined()
  })

  it('keeps the whole episode only for a suggestion that gives no quote', async () => {
    const candidates = await run(reader({ structure: { 1: [claim('c1', 'no quote')] } }))
    const kept = byRef(candidates, 'e1.c1')
    expect(kept.status).toBe('suggested')
    expect(wordsAt(DIALOGUE, kept)).toBe(DIALOGUE.split('\n').slice(0, 5).join('\n'))
  })

  it('refuses words said twice unless the occurrence is named, and finds the one named', async () => {
    const candidates = await run(
      reader({
        structure: { 1: [claim('c1', '自注意力不区分顺序', '因为自注意力本身不区分词的顺序')] },
        state: {
          1: [
            state('cand:c1', 'confidence', 'low', '我还是不明白。'),
            state('cand:c1', 'confidence', 'low', '我还是不明白。', {
              quoteAt: { episodeId: 'src#e1', occurrence: 2 },
            }),
            state('cand:c1', 'confidence', 'low', '我还是不明白。', {
              quoteAt: { episodeId: 'src#e1', occurrence: 3 },
            }),
          ],
        },
      }),
    )
    expect(byRef(candidates, 'e1.s1').refusal?.code).toBe('quote_ambiguous')
    expect(byRef(candidates, 'e1.s1').origin).toBeUndefined()
    const second = byRef(candidates, 'e1.s2')
    expect(second.status).toBe('suggested')
    expect(second.origin?.span.start).toBe(DIALOGUE.lastIndexOf('我还是不明白。'))
    expect(byRef(candidates, 'e1.s3').refusal?.code).toBe('quote_not_found')
  })

  it('counts a quote’s length in letters and digits, not characters', async () => {
    const material = '学生：我懂了，OK。了？...'
    const candidates = await run(
      reader({
        structure: {
          1: [
            claim('a', 'a', '懂了'),
            claim('b', 'b', 'OK'),
            claim('c', 'c', '了'),
            claim('d', 'd', '？'),
            claim('e', 'e', '...'),
            claim('f', 'f', 'x'.repeat(1001)),
          ],
        },
      }),
      material,
    )
    const codes = Object.fromEntries(
      candidates.map((candidate) => [candidate.ref, candidate.refusal?.code]),
    )
    expect(codes).toEqual({
      'e1.a': undefined,
      'e1.b': undefined,
      'e1.c': 'quote_too_short',
      'e1.d': 'quote_too_short',
      'e1.e': 'quote_too_short',
      'e1.f': 'quote_too_long',
    })
  })

  it('refuses a quote that runs across two episodes', async () => {
    const candidates = await run(
      reader({ structure: { 1: [claim('c1', 'across', '我还是不明白。\n学生：那「熵」')] } }),
    )
    expect(byRef(candidates, 'e1.c1').refusal?.code).toBe('quote_spans_episodes')
    expect(byRef(candidates, 'e1.c1').origin).toBeUndefined()
  })

  it('gives every reader the name it gave its earlier nodes', async () => {
    const seen: AgentWorkspace[] = []
    await run(
      reader(
        { structure: { 1: [claim('mine', '自注意力不区分顺序', '本身不区分词的顺序')] } },
        seen,
      ),
    )
    const later = seen.at(-1)?.candidates ?? []
    expect(later).toEqual([
      expect.objectContaining<Partial<CandidateNode>>({ ref: 'e1.mine', localRef: 'mine' }),
    ])
  })
})

describe('the rule-based reader under strict quotes', () => {
  it('names which time the learner said the same words, and keeps both', async () => {
    const candidates = await run(new RuleBasedDistiller({ policy: learnDistillationPolicy }))
    const confused = candidates.filter(
      (candidate) =>
        candidate.suggestion.kind === 'state' && candidate.suggestion.quote === '我还是不明白。',
    )
    expect(confused.map((candidate) => candidate.status)).toEqual(['suggested', 'suggested'])
    expect(confused.map((candidate) => candidate.origin?.span.start)).toEqual([
      DIALOGUE.indexOf('我还是不明白。'),
      DIALOGUE.lastIndexOf('我还是不明白。'),
    ])
  })

  it('keeps a one-character term, resting it on the line it stands in', async () => {
    const candidates = await run(new RuleBasedDistiller({ policy: learnDistillationPolicy }))
    const term = candidates.find(
      (candidate) => candidate.suggestion.kind === 'node' && candidate.suggestion.label === '熵',
    )
    expect(term?.status).toBe('suggested')
    expect(term === undefined ? undefined : wordsAt(DIALOGUE, term)).toBe('学生：那「熵」是什么？')
  })

  it('leaves everything it reads inferred unless it is told who the learner is', async () => {
    const reading = new RuleBasedDistiller({ policy: learnDistillationPolicy })
    const untold = await run(reading)
    expect(new Set(untold.map((candidate) => candidate.suggestion.basis))).toEqual(
      new Set(['inferred']),
    )
    const told = await run(reading, DIALOGUE, '学生')
    const states = told.filter((candidate) => candidate.suggestion.kind === 'state')
    expect(states.length).toBeGreaterThan(0)
    for (const candidate of states) {
      expect(candidate.suggestion.basis).toBe('stated')
      expect(candidate.origin?.speaker).toBe('学生')
    }
  })
})

describe('stated and inferred', () => {
  const said = (extra: Partial<Suggestion>) =>
    reader({
      structure: { 1: [claim('c1', '自注意力不区分顺序', '本身不区分词的顺序')] },
      state: { 1: [state('cand:c1', 'confidence', 'low', '把词打乱', extra)] },
    })

  it('refuses a stated item whose words are not in the learner’s turn', async () => {
    const candidates = await run(said({ basis: 'stated' }), DIALOGUE, '学生')
    expect(byRef(candidates, 'e1.s1').refusal?.code).toBe('basis_mismatch')
    expect(byRef(candidates, 'e1.s1').origin?.speaker).toBe('老师')
  })

  it('refuses a stated item when nobody said who the learner is', async () => {
    const candidates = await run(
      reader({
        structure: { 1: [claim('c1', '自注意力不区分顺序', '本身不区分词的顺序')] },
        state: {
          1: [
            state('cand:c1', 'confidence', 'low', '我还是不明白。', {
              basis: 'stated',
              quoteAt: { episodeId: 'src#e1', occurrence: 1 },
            }),
          ],
        },
      }),
    )
    expect(byRef(candidates, 'e1.s1').refusal?.code).toBe('basis_mismatch')
  })

  it('matches the learner exactly after NFC and trimming, without folding case', async () => {
    const material = 'Café：I am lost here.\nTutor：Shuffling only reorders the outputs.'
    const lost = reader({
      structure: { 1: [claim('c1', 'order', 'only reorders the outputs')] },
      state: { 1: [state('cand:c1', 'confidence', 'low', 'I am lost here', { basis: 'stated' })] },
    })
    const decomposed = ' Café '
    expect(byRef(await run(lost, material, decomposed), 'e1.s1').status).toBe('suggested')
    expect(byRef(await run(lost, material, 'café'), 'e1.s1').refusal?.code).toBe('basis_mismatch')
  })
})

describe('conflict, as distillation may suggest it', () => {
  it('allows suspected and open, never resolved or none', async () => {
    const candidates = await run(
      reader({
        structure: { 1: [claim('c1', '自注意力不区分顺序', '本身不区分词的顺序')] },
        state: {
          1: ['suspected', 'open', 'resolved', 'none'].map((level) =>
            state('cand:c1', 'conflict', level, '本身不区分词的顺序'),
          ),
        },
      }),
    )
    expect(candidates.slice(1).map((candidate) => candidate.refusal?.code)).toEqual([
      undefined,
      undefined,
      'not_allowed',
      'not_allowed',
    ])
  })
})

describe('in the session', () => {
  let directory: string
  let graph: string
  let session: LearnSession
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'episteme-strict-session-'))
    graph = join(directory, 'learn.jsonl')
    session = await LearnSession.open({ filePath: graph })
    await session.addNode({ label: '自注意力不区分顺序', kind: 'claim' })
    await session.flush()
  })
  afterEach(async () => {
    await session.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('writes nothing to the graph before a decision, refusals included', async () => {
    const before = await readFile(graph)
    const events = session.eventCount
    const outcome = await session.distill(
      { text: DIALOGUE },
      {
        agent: reader({
          structure: {
            1: [
              claim('c1', '自注意力不区分顺序', '本身不区分词的顺序'),
              claim('c2', 'gone', '没有这句'),
            ],
          },
          state: { 1: [state('cand:c2', 'confidence', 'low', '我还是不明白。')] },
        }),
      },
    )
    expect(outcome.ok).toBe(true)
    expect(await readFile(graph)).toEqual(before)
    expect(session.eventCount).toBe(events)
  })

  it('refuses only a second node for an idea the learner has, saying which node and where', async () => {
    const [existing] = session.listNodes()
    const outcome = await session.distill(
      { text: DIALOGUE },
      {
        agent: reader({
          structure: { 1: [claim('c1', '自注意力不区分顺序', '本身不区分词的顺序')] },
        }),
      },
    )
    if (!outcome.ok) throw new Error(outcome.refusal.message)
    expect(outcome.suggestions).toEqual([])
    expect(outcome.refused).toHaveLength(1)
    const [refused] = outcome.refused
    expect(refused).toMatchObject({
      ref: 'e1.c1',
      code: 'already_known',
      existingNodeId: existing?.nodeId,
    })
    expect(refused?.origin).toMatchObject({ excerpt: '本身不区分词的顺序', speaker: '老师' })
  })

  it('keeps the basis through the decision, and an accepted state sets only its own dimension', async () => {
    const outcome = await session.distill(
      { text: DIALOGUE },
      {
        learner: '学生',
        agent: reader({
          structure: { 1: [claim('c1', '打乱只会重新排列输出', '输出只是跟着重新排列')] },
          state: {
            1: [
              state('cand:c1', 'articulation', 'medium', '输出只是跟着重新排列', {
                basis: 'inferred',
              }),
            ],
          },
        }),
      },
    )
    if (!outcome.ok) throw new Error(outcome.refusal.message)
    const [node, change] = outcome.suggestions
    expect(node?.basis).toBe('inferred')
    expect(change?.basis).toBe('inferred')
    const accepted = await session.decide(node?.id ?? '', { action: 'accept' }, 'learn-review')
    if (!accepted.ok || !('committed' in accepted)) throw new Error('the node was not accepted')
    const nodeId = accepted.committed.id
    expect(session.graph.getNode(nodeId)?.properties).toMatchObject({ basis: 'inferred' })
    const decided = await session.decide(change?.id ?? '', { action: 'accept' }, 'learn-review')
    expect(decided.ok).toBe(true)
    const [event] = session.historyOf(nodeId) ?? []
    expect(event?.source).toContain('basis inferred')
    expect(event?.dimensions.map(([dimension]) => dimension)).toEqual(['articulation'])
    expect(session.understandingOf(nodeId)).toEqual([{ id: 'articulation', level: 'medium' }])
  })

  it('lets the learner accept a suspected conflict, the one way any state is accepted', async () => {
    const outcome = await session.distill(
      { text: DIALOGUE },
      {
        agent: reader({
          structure: { 1: [claim('c1', '打乱只会重新排列输出', '输出只是跟着重新排列')] },
          state: { 1: [state('cand:c1', 'conflict', 'suspected', '输出只是跟着重新排列')] },
        }),
      },
    )
    if (!outcome.ok) throw new Error(outcome.refusal.message)
    const [node, conflict] = outcome.suggestions
    const accepted = await session.decide(node?.id ?? '', { action: 'accept' }, 'learn-review')
    if (!accepted.ok || !('committed' in accepted)) throw new Error('the node was not accepted')
    expect(
      (await session.decide(conflict?.id ?? '', { action: 'accept' }, 'learn-review')).ok,
    ).toBe(true)
    expect(session.understandingOf(accepted.committed.id)).toEqual([
      { id: 'conflict', level: 'suspected' },
    ])
  })
})

describe('what the review and query interfaces show', () => {
  it('carries basis and speaker in pending suggestions, and suspected among the levels', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'episteme-strict-api-'))
    const service = await startService({
      port: 0,
      graph: join(directory, 'learn.jsonl'),
      profile: learnProfile(BLANK_TOPIC),
    })
    try {
      const posted = await fetch(`${service.apiUrl}/distill`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: DIALOGUE }),
      })
      expect(posted.status).toBe(200)
      const { suggestions } = (await (await fetch(`${service.apiUrl}/suggestions`)).json()) as {
        suggestions: { basis?: string; origin?: { speaker?: string } }[]
      }
      expect(suggestions.length).toBeGreaterThan(0)
      for (const suggestion of suggestions) expect(suggestion.basis).toBe('inferred')
      expect(suggestions.some((suggestion) => suggestion.origin?.speaker === '学生')).toBe(true)
      const { dimensions } = (await (await fetch(`${service.apiUrl}/state`)).json()) as {
        dimensions: { id: string; levels: string[] }[]
      }
      expect(dimensions.find((dimension) => dimension.id === 'conflict')?.levels).toEqual([
        'none',
        'suspected',
        'open',
        'resolved',
      ])
    } finally {
      await service.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
