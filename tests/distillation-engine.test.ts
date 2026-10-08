import { MockCognitiveAgent, type Suggestion } from '@episteme/agent'
import {
  RuleBasedDistiller,
  distill,
  type Candidate,
  type DistillationPolicy,
} from '@episteme/distillation'
import { describe, expect, it } from 'vitest'

/**
 * The distillation engine and the rule-based distiller (ADR 0009).
 *
 * The engine writes nothing; what it returns is the whole of its effect. These tests hold it to: candidates
 * that point back at their exact words, relations between candidates of the same material, a policy that
 * decides what may be suggested, and refusals that stay visible instead of vanishing.
 */

/** A policy as a Domain Pack would give it, written out here so the engine is tested without one. */
const POLICY: DistillationPolicy = {
  id: 'test',
  nodeTypes: { concept: 'concept', question: 'question', claim: 'claim', evidence: 'evidence' },
  edgeTypes: {
    about: 'refers_to',
    answers: 'answers',
    supports: 'supports',
    contradicts: 'contradicts',
  },
  stateDimensions: {
    confidence: ['low', 'medium', 'high'],
    articulation: ['low', 'medium', 'high'],
  },
  limits: { perEpisode: 12, perRun: 60 },
  propertiesFor: (role) => (role === 'evidence' ? { kind: 'example' } : {}),
}

const KNOWN = [
  { id: 'c_self_attention', label: '自注意力（Self-Attention）', type: 'concept' },
  { id: 'c_positional_encoding', label: '位置编码（Positional Encoding）', type: 'concept' },
]

const DIALOGUE = [
  '[00:05] 学生：为什么 Transformer 需要位置编码？',
  '[00:12] 老师：因为自注意力本身不区分词的顺序。例如把句子里的词打乱，注意力的输出只是跟着重新排列。',
  '[00:40] 学生：我明白了。',
  '[01:02] 学生：那「旋转位置编码」是怎么做的？',
  '[01:15] 老师：它把位置编码成向量的旋转，所以两个词的相对位置会体现在点积里。',
  '[01:50] 学生：这部分我还不太懂。',
].join('\n')

async function distilDialogue() {
  return distill({
    material: { sourceId: 'src_1', text: DIALOGUE },
    agent: new RuleBasedDistiller({ policy: POLICY }),
    policy: POLICY,
    actorId: 'actor_human',
    known: KNOWN,
  })
}

const kept = (candidates: readonly Candidate[]) =>
  candidates.filter((candidate) => candidate.status === 'suggested')

function describeCandidate(candidate: Candidate): string {
  const suggestion = candidate.suggestion
  if (suggestion.kind === 'node')
    return `${candidate.ref} ${suggestion.nodeType}: ${suggestion.label}`
  if (suggestion.kind === 'edge') {
    return `${candidate.ref} ${suggestion.edgeType}: ${suggestion.from} -> ${suggestion.to}`
  }
  const [dimension, value] = Object.entries(suggestion.dimensions)[0] ?? []
  return `${candidate.ref} state ${suggestion.target}: ${dimension}=${value?.level}`
}

describe('a real learning dialogue', () => {
  it('yields its questions, claims, evidence and terms, how they relate, and what the learner said of themselves', async () => {
    const result = await distilDialogue()
    expect(result.episodes).toHaveLength(2)
    expect(kept(result.candidates).map(describeCandidate)).toEqual([
      'e1.q1 question: 为什么 Transformer 需要位置编码？',
      'e1.c1 claim: 因为自注意力本身不区分词的顺序。',
      'e1.x1 evidence: 例如把句子里的词打乱，注意力的输出只是跟着重新排列。',
      'e1.l1 answers: cand:e1.c1 -> cand:e1.q1',
      'e1.l2 supports: cand:e1.x1 -> cand:e1.c1',
      'e1.l3 refers_to: cand:e1.q1 -> c_positional_encoding',
      'e1.l4 refers_to: cand:e1.c1 -> c_self_attention',
      'e1.s5 state cand:e1.q1: confidence=medium',
      'e2.q1 question: 那「旋转位置编码」是怎么做的？',
      'e2.c1 claim: 它把位置编码成向量的旋转，所以两个词的相对位置会体现在点积里。',
      'e2.k1 concept: 旋转位置编码',
      'e2.l1 answers: cand:e2.c1 -> cand:e2.q1',
      'e2.l2 refers_to: cand:e2.q1 -> c_positional_encoding',
      'e2.l3 refers_to: cand:e2.q1 -> cand:e2.k1',
      'e2.l4 refers_to: cand:e2.c1 -> c_positional_encoding',
      'e2.s5 state cand:e2.q1: confidence=low',
    ])
    expect(result.candidates.every((candidate) => candidate.status === 'suggested')).toBe(true)
  })

  it('points every candidate at the exact words it rests on, and at when they were said', async () => {
    const result = await distilDialogue()
    for (const candidate of result.candidates) {
      const words = DIALOGUE.slice(candidate.origin.span.start, candidate.origin.span.end)
      expect(candidate.origin.excerpt).toBe(words)
      if (candidate.suggestion.quote !== undefined) expect(words).toBe(candidate.suggestion.quote)
      expect(candidate.origin.sourceId).toBe('src_1')
    }
    const learnerSaid = result.candidates.find((candidate) => candidate.ref === 'e1.s5')
    expect(learnerSaid?.origin.excerpt).toBe('我明白了。')
    expect(learnerSaid?.origin.time).toEqual({ from: 5, to: 62 })
  })

  it('gives a node the properties its domain requires, whoever suggested it', async () => {
    const result = await distilDialogue()
    const evidence = result.candidates.find((candidate) => candidate.ref === 'e1.x1')?.suggestion
    expect(evidence?.kind === 'node' && evidence.properties).toEqual({ kind: 'example' })
  })

  it('suggests a state change only for the learner, and only as a suggestion', async () => {
    const result = await distilDialogue()
    const states = result.candidates.flatMap((candidate) =>
      candidate.suggestion.kind === 'state' ? [candidate.suggestion] : [],
    )
    expect(states.every((state) => state.actorId === 'actor_human')).toBe(true)
    expect(
      states.every((state) =>
        Object.values(state.dimensions).every((value) => value.authority === 'suggested'),
      ),
    ).toBe(true)
  })

  it('is deterministic', async () => {
    const [one, two] = await Promise.all([distilDialogue(), distilDialogue()])
    expect(one).toEqual(two)
  })
})

describe('english prose', () => {
  it('reads notes as the learner’s own, and links to what they already have', async () => {
    const text =
      'Self-Attention cannot see word order because it sums over all positions.\n\nI see now. For example, shuffling the words only shuffles the outputs.'
    const result = await distill({
      material: { sourceId: 'notes', text },
      agent: new RuleBasedDistiller({ policy: POLICY }),
      policy: POLICY,
      actorId: 'actor_human',
      known: KNOWN,
    })
    const described = kept(result.candidates).map(describeCandidate)
    expect(described).toContain(
      'e1.c1 claim: Self-Attention cannot see word order because it sums over all positions.',
    )
    expect(described).toContain('e1.l1 refers_to: cand:e1.c1 -> c_self_attention')
    expect(described).toContain(
      'e2.x1 evidence: For example, shuffling the words only shuffles the outputs.',
    )
  })
})

/** An agent that answers each capability with fixed suggestions, to reach the engine's refusals. */
function scripted(
  structure: Suggestion[],
  connections: Suggestion[] = [],
  state: Suggestion[] = [],
) {
  return new MockCognitiveAgent({
    fallback: {
      suggestStructure: structure,
      suggestConnections: connections,
      suggestStateChange: state,
    },
  })
}

async function refusalsFor(
  agent: MockCognitiveAgent,
  policy: DistillationPolicy = POLICY,
): Promise<Record<string, string | undefined>> {
  const result = await distill({
    material: { sourceId: 's', text: 'One paragraph of material.' },
    agent,
    policy,
    actorId: 'actor_human',
    known: KNOWN,
  })
  return Object.fromEntries(
    result.candidates.map((candidate) => [candidate.ref, candidate.refusal?.code]),
  )
}

const node = (ref: string, nodeType = 'claim', label = `claim ${ref}`): Suggestion => ({
  kind: 'node',
  nodeType,
  label,
  ref,
  rationale: 'r',
})

describe('what the engine refuses, and keeps visible', () => {
  it('a type the domain does not distil', async () => {
    expect(await refusalsFor(scripted([node('a', 'lecture')]))).toEqual({ 'e1.a': 'not_allowed' })
  })

  it('a node the learner already has, and the same node twice', async () => {
    const refusals = await refusalsFor(
      scripted([
        node('a', 'concept', '自注意力（Self-Attention）'),
        node('b'),
        node('c', 'claim', 'claim b'),
      ]),
    )
    expect(refusals).toEqual({
      'e1.a': 'already_known',
      'e1.b': undefined,
      'e1.c': 'duplicate_candidate',
    })
  })

  it('a relation that depends on a refused candidate, or names nothing', async () => {
    const refusals = await refusalsFor(
      scripted(
        [node('bad', 'lecture'), node('good')],
        [
          {
            kind: 'edge',
            edgeType: 'refers_to',
            from: 'cand:good',
            to: 'cand:bad',
            rationale: 'r',
          },
          {
            kind: 'edge',
            edgeType: 'refers_to',
            from: 'cand:good',
            to: 'c_missing',
            rationale: 'r',
          },
          {
            kind: 'edge',
            edgeType: 'refers_to',
            from: 'cand:good',
            to: 'cand:nothing',
            rationale: 'r',
          },
          {
            kind: 'edge',
            edgeType: 'refers_to',
            from: 'cand:good',
            to: 'c_self_attention',
            rationale: 'r',
          },
        ],
      ),
    )
    expect(refusals).toMatchObject({
      'e1.l1': 'depends_on_refused',
      'e1.l2': 'unknown_endpoint',
      'e1.l3': 'unknown_endpoint',
      'e1.l4': undefined,
    })
  })

  it('a state change the domain does not allow', async () => {
    const refusals = await refusalsFor(
      scripted(
        [node('a')],
        [],
        [
          {
            kind: 'state',
            target: 'cand:a',
            actorId: 'someone_else',
            dimensions: { mastery: { level: 'high' } },
            evidence: [],
            rationale: 'r',
          },
          {
            kind: 'state',
            target: 'cand:a',
            actorId: 'someone_else',
            dimensions: { confidence: { level: 'total' } },
            evidence: [],
            rationale: 'r',
          },
        ],
      ),
    )
    expect(refusals).toMatchObject({ 'e1.s1': 'not_allowed', 'e1.s2': 'not_allowed' })
  })

  it('more than the domain keeps from one episode', async () => {
    const tight = { ...POLICY, limits: { perEpisode: 2, perRun: 60 } }
    const refusals = await refusalsFor(scripted([node('a'), node('b'), node('c')]), tight)
    expect(refusals).toEqual({ 'e1.a': undefined, 'e1.b': undefined, 'e1.c': 'over_limit' })
  })

  it('whatever the domain’s own check refuses', async () => {
    const strict: DistillationPolicy = {
      ...POLICY,
      validate: (candidate) =>
        candidate.suggestion.kind === 'node' && candidate.suggestion.label.includes('b')
          ? { code: 'domain_says_no', message: 'no' }
          : undefined,
    }
    expect(await refusalsFor(scripted([node('a'), node('b')]), strict)).toEqual({
      'e1.a': undefined,
      'e1.b': 'domain_says_no',
    })
  })
})
