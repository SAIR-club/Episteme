import {
  CANDIDATE_PREFIX,
  type AgentResponse,
  type AgentWorkspace,
  type CandidateNode,
  type CognitiveAgent,
  type KnownNode,
  type Suggestion,
} from '@episteme/agent'
import type { DistillationPolicy, Role } from './policy.js'

export interface RuleBasedOptions {
  readonly policy: DistillationPolicy
  /**
   * Speaker names that are the learner, compared without case. Only what the learner says about themselves can
   * suggest a change in their understanding. Prose has no speakers and is read as the learner's own notes.
   */
  readonly learnerSpeakers?: readonly string[]
}

const DEFAULT_LEARNERS = ['学生', '学习者', '学员', '我', 'learner', 'student', 'user', 'me', 'i']

/**
 * A distiller that reads with fixed rules and no model (ADR 0009).
 *
 * It finds what its patterns find, and nothing it finds is more than a suggestion. It understands no subject:
 * the rules are about the shape of language, in Chinese and English. A question is a question; a sentence
 * that gives a reason or a limit is a claim; a sentence that offers an example or an experiment is evidence;
 * a quoted term is a concept; a learner saying "I see" or "I'm lost" is a possible change in their
 * understanding. Being deterministic, the same material gives the same candidates, so the loop can be tested
 * end to end. A model-backed agent can replace it behind the same interface.
 */
export class RuleBasedDistiller implements CognitiveAgent {
  readonly id = 'rule-based-distiller'
  readonly description = 'Distils learning material with fixed language rules; suggests only.'

  readonly #policy: DistillationPolicy
  readonly #learners: ReadonlySet<string>

  constructor(options: RuleBasedOptions) {
    this.#policy = options.policy
    this.#learners = new Set(
      (options.learnerSpeakers ?? DEFAULT_LEARNERS).map((name) => name.toLowerCase()),
    )
  }

  respond(): Promise<AgentResponse> {
    return Promise.resolve({
      text: 'This agent distils material; it does not answer.',
      usedContext: false,
    })
  }

  suggestStructure(workspace: AgentWorkspace): Promise<readonly Suggestion[]> {
    const material = workspace.material
    if (material === undefined) return Promise.resolve([])
    const types = this.#policy.nodeTypes
    const known = workspace.known ?? []
    const found: Suggestion[] = []
    const counters: Partial<Record<Role, number>> = {}
    const add = (role: Role, label: string, quote: string, rationale: string): void => {
      const nodeType = types[role]
      if (nodeType === undefined) return
      counters[role] = (counters[role] ?? 0) + 1
      found.push({
        kind: 'node',
        nodeType,
        label,
        ref: `${REF_PREFIX[role]}${counters[role]}`,
        quote,
        rationale,
      })
    }

    for (const sentence of sentencesOf(material.text, this.#learners)) {
      if (sentence.byLearner && selfReport(sentence.text) !== undefined) continue
      if (QUESTION.test(sentence.text)) {
        add(
          'question',
          sentence.text,
          sentence.text,
          say(sentence.text, '学习中被提出的问题', 'A question raised while learning'),
        )
      } else if (EVIDENCE.test(sentence.text)) {
        add(
          'evidence',
          sentence.text,
          sentence.text,
          say(
            sentence.text,
            '用来支撑某个说法的例子或依据',
            'An example or ground offered for a statement',
          ),
        )
      } else if (CLAIM.test(sentence.text)) {
        add(
          'claim',
          sentence.text,
          sentence.text,
          say(
            sentence.text,
            '给出了理由或限制的陈述，可能是你持有的观点',
            'A statement giving a reason or a limit, which you may hold',
          ),
        )
      }
    }

    const terms = new Set<string>()
    for (const match of material.text.matchAll(QUOTED)) {
      const term = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').trim()
      if (term === '' || term.length > 40 || terms.has(term) || mentionsKnown(term, known)) continue
      terms.add(term)
      add(
        'concept',
        term,
        match[0],
        say(term, '材料中特别标出的术语', 'A term the material sets apart'),
      )
    }
    return Promise.resolve(found)
  }

  suggestConnections(workspace: AgentWorkspace): Promise<readonly Suggestion[]> {
    const material = workspace.material
    if (material === undefined) return Promise.resolve([])
    const { nodeTypes, edgeTypes } = this.#policy
    const mine = (workspace.candidates ?? []).filter(
      (candidate) => candidate.episodeId === material.episodeId,
    )
    const ofType = (role: Role): readonly CandidateNode[] =>
      mine.filter((candidate) => candidate.nodeType === nodeTypes[role])
    const [question] = ofType('question')
    const claims = ofType('claim')
    const concepts = ofType('concept')
    const edges: Suggestion[] = []
    const edge = (
      relation: 'about' | 'answers' | 'supports',
      from: string,
      to: string,
      why: string,
      quote?: string,
    ): void => {
      const edgeType = edgeTypes[relation]
      if (edgeType === undefined) return
      edges.push({
        kind: 'edge',
        edgeType,
        from,
        to,
        rationale: why,
        ...(quote === undefined ? {} : { quote }),
      })
    }

    if (question !== undefined) {
      for (const claim of claims) {
        edge(
          'answers',
          cand(claim),
          cand(question),
          say(claim.label, '它出现在对这个问题的回答里', 'It comes in answer to this question'),
          claim.label,
        )
      }
    }
    const [firstClaim] = claims
    if (firstClaim !== undefined) {
      for (const evidence of ofType('evidence')) {
        edge(
          'supports',
          cand(evidence),
          cand(firstClaim),
          say(
            evidence.label,
            '它是为这个说法举出的例子或依据',
            'It is offered as an example or ground for this statement',
          ),
          evidence.label,
        )
      }
    }
    for (const subject of [...(question === undefined ? [] : [question]), ...claims]) {
      for (const node of workspace.known ?? []) {
        if (mentions(subject.label, node)) {
          edge(
            'about',
            cand(subject),
            node.id,
            say(subject.label, `它提到了「${node.label}」`, `It mentions "${node.label}"`),
            subject.label,
          )
        }
      }
      for (const concept of concepts) {
        if (subject.label.includes(concept.label)) {
          edge(
            'about',
            cand(subject),
            cand(concept),
            say(subject.label, `它提到了「${concept.label}」`, `It mentions "${concept.label}"`),
            subject.label,
          )
        }
      }
    }
    return Promise.resolve(edges)
  }

  suggestStateChange(workspace: AgentWorkspace): Promise<readonly Suggestion[]> {
    const material = workspace.material
    if (material === undefined) return Promise.resolve([])
    const allowed = this.#policy.stateDimensions
    const mine = (workspace.candidates ?? []).filter(
      (candidate) => candidate.episodeId === material.episodeId,
    )
    const question = mine.find(
      (candidate) => candidate.nodeType === this.#policy.nodeTypes.question,
    )
    const mentioned = (workspace.known ?? []).find((node) => mentions(material.text, node))
    const target = question === undefined ? mentioned?.id : cand(question)
    if (target === undefined) return Promise.resolve([])

    const changes: Suggestion[] = []
    for (const sentence of sentencesOf(material.text, this.#learners)) {
      if (!sentence.byLearner) continue
      const report = selfReport(sentence.text)
      if (report === undefined) continue
      const levels = allowed[report.dimension]
      if (levels === undefined || !levels.includes(report.level)) continue
      changes.push({
        kind: 'state',
        target,
        actorId: workspace.actorId,
        dimensions: { [report.dimension]: { level: report.level, authority: 'suggested' } },
        evidence: [sentence.text],
        quote: sentence.text,
        rationale: say(
          sentence.text,
          `你在材料里说「${sentence.text}」`,
          `You said "${sentence.text}"`,
        ),
      })
    }
    return Promise.resolve(changes)
  }
}

const REF_PREFIX: Readonly<Record<Role, string>> = {
  question: 'q',
  claim: 'c',
  evidence: 'x',
  concept: 'k',
  thought: 't',
}

const QUESTION = /[?？]\s*$/u
const EVIDENCE =
  /(例如|比如|举个例子|举例|实验|证明|数据显示|观察到|for example|for instance|e\.g\.|an experiment|we observed|proof|as shown)/iu
const CLAIM =
  /(因为|所以|因此|意味着|导致|本身|无法|不能|不会|取决于|等价于|必须|才能|\bbecause\b|\btherefore\b|\bso that\b|which means|\bcannot\b|can't|does not|doesn't|depends on|\bmust\b|equivalent to|\bcauses\b)/iu
const QUOTED = /「([^」]+)」|『([^』]+)』|“([^”]+)”|《([^》]+)》/gu

interface Report {
  readonly dimension: string
  readonly level: string
}

/** What a learner says about their own understanding, read as a possible change in it. */
function selfReport(text: string): Report | undefined {
  if (/(我能讲给|我可以解释|能讲清楚|I can explain|I could explain)/iu.test(text)) {
    return { dimension: 'articulation', level: 'medium' }
  }
  if (
    /(还不太懂|不太明白|没懂|不明白|搞不清|困惑|I'm confused|I am confused|I don't understand|I'm lost|not sure)/iu.test(
      text,
    )
  ) {
    return { dimension: 'confidence', level: 'low' }
  }
  if (
    /(我明白了|我懂了|明白了|懂了|原来如此|原来是这样|I see\b|I get it|got it|makes sense|that makes sense)/iu.test(
      text,
    )
  ) {
    return { dimension: 'confidence', level: 'medium' }
  }
  return undefined
}

interface Sentence {
  readonly text: string
  readonly byLearner: boolean
}

/** Sentences of a passage, each knowing whether the learner said it. */
function sentencesOf(text: string, learners: ReadonlySet<string>): readonly Sentence[] {
  const sentences: Sentence[] = []
  let speaker: string | undefined
  for (const line of text.split(/\r?\n/u)) {
    const turn = /^\s*(?:\[[\d:]+\]\s*)?([^:：[\]]{1,24}?)\s*[:：]\s*(.*)$/u.exec(line)
    const said = turn === null ? line : (turn[2] ?? '')
    if (turn !== null) speaker = turn[1]?.trim()
    const byLearner = speaker === undefined || learners.has(speaker.toLowerCase())
    for (const piece of said.split(/(?<=[。！？!?；;])|(?<=\.)\s+/u)) {
      const sentence = piece.trim()
      if (sentence.length >= 2) sentences.push({ text: sentence, byLearner })
    }
  }
  return sentences
}

function cand(candidate: CandidateNode): string {
  return `${CANDIDATE_PREFIX}${candidate.ref}`
}

/** A label's names: `自注意力（Self-Attention）` is mentioned as either part. */
function namesOf(label: string): readonly string[] {
  return label
    .split(/[（）()]/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2)
}

function mentions(text: string, node: KnownNode): boolean {
  const lower = text.toLowerCase()
  return namesOf(node.label).some((name) => lower.includes(name.toLowerCase()))
}

function mentionsKnown(term: string, known: readonly KnownNode[]): boolean {
  const lower = term.toLowerCase()
  return known.some((node) => namesOf(node.label).some((name) => name.toLowerCase() === lower))
}

/** A rationale in the language of the words it is about. */
function say(about: string, zh: string, en: string): string {
  return /[一-鿿]/u.test(about) ? zh : en
}
