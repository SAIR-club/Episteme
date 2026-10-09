import {
  EmbeddingRetriever,
  HybridRetriever,
  LexicalGraphRetriever,
  asId,
  createFixedClock,
  defineDomainPack,
  reject,
  retrieveRelevantContext,
  toAgentContext,
  type Actor,
  type ActorId,
  type BranchId,
  type CoreGraph,
  type DimensionId,
  type DomainPack,
  type EdgeTypeId,
  type EmbeddingAdapter,
  type EmbeddingCache,
  type EventLog,
  type GraphMutation,
  type GraphStorageAdapter,
  type GuardContext,
  type GuardVerdict,
  type HybridWeights,
  type NodeId,
  type NodeTypeId,
  type PersistentEventStore,
  type Registries,
  type StateValue,
  type Tag,
} from '@episteme/core'
import {
  compose,
  composeDeterministic,
  openEpisteme as openViaSdk,
  type Episteme,
} from '@episteme/sdk'
import type { LearnSession } from '@episteme/application'
import { MockCognitiveAgent, type AgentResponse } from '@episteme/agent'

/**
 * Universal test ontology definitions for Episteme core test suites.
 * Decoupled completely from any specific domain pack.
 */
export const NODE = {
  concept: asId<NodeTypeId>('concept'),
  claim: asId<NodeTypeId>('claim'),
  question: asId<NodeTypeId>('question'),
  evidence: asId<NodeTypeId>('evidence'),
  thought: asId<NodeTypeId>('thought'),
  artifact: asId<NodeTypeId>('artifact'),
  resource: asId<NodeTypeId>('resource'),
  synthesis: asId<NodeTypeId>('synthesis'),
} as const

export const EDGE = {
  refersTo: asId<EdgeTypeId>('refers_to'),
  answers: asId<EdgeTypeId>('answers'),
  supports: asId<EdgeTypeId>('supports'),
  contradicts: asId<EdgeTypeId>('contradicts'),
  prerequisite: asId<EdgeTypeId>('prerequisite'),
  contains: asId<EdgeTypeId>('contains'),
  derivedFrom: asId<EdgeTypeId>('derived_from'),
  organizedFrom: asId<EdgeTypeId>('organized_from'),
  synthesizes: asId<EdgeTypeId>('synthesizes'),
  authoredBy: asId<EdgeTypeId>('authored_by'),
  taggedWith: asId<EdgeTypeId>('tagged_with'),
  evolvesTo: asId<EdgeTypeId>('evolves_to'),
  forksFrom: asId<EdgeTypeId>('forks_from'),
  sameAs: asId<EdgeTypeId>('same_as'),
  exemplifies: asId<EdgeTypeId>('exemplifies'),
} as const

export const DIMENSION = {
  confidence: asId<DimensionId>('confidence'),
  exposure: asId<DimensionId>('exposure'),
  evidence: asId<DimensionId>('evidence'),
  articulation: asId<DimensionId>('articulation'),
  transfer: asId<DimensionId>('transfer'),
  conflict: asId<DimensionId>('conflict'),
  source: asId<DimensionId>('source'),
} as const

export function testTag(ns: string, val: string): Tag {
  return `${ns}:${val}`
}

export interface TestTagsFn {
  (topic: string): string[]
  topic(val: string): Tag
  scene(val: string): Tag
  state(val: string): Tag
}

const tagsFn = ((topic: string): string[] => [
  testTag('scene', 'test'),
  testTag('topic', topic),
  testTag('state', 'active'),
]) as TestTagsFn

tagsFn.topic = (val: string) => testTag('topic', val)
tagsFn.scene = (val: string) => testTag('scene', val)
tagsFn.state = (val: string) => testTag('state', val)

export const testTags: TestTagsFn = tagsFn
export const learnTags: TestTagsFn = tagsFn

const ANCHOR_PROPERTY = 'anchors'
const ANCHORED_TYPES: readonly string[] = [NODE.thought, NODE.synthesis]

export const thoughtRequiresSourceGuard = {
  name: 'learn/thought-requires-source',
  description:
    'A thought or synthesis must carry a source and at least one anchor node; a draft can never be promoted by accident.',
  appliesTo: ['node.add'] as const,
  check(mutation: GraphMutation, _context: GuardContext): GuardVerdict {
    if (mutation.kind !== 'node.add') return { ok: true }
    const { node } = mutation
    if (!ANCHORED_TYPES.includes(node.type)) return { ok: true }

    const anchors = node.properties[ANCHOR_PROPERTY]
    if (!Array.isArray(anchors) || anchors.length === 0) {
      return reject(
        `${node.type} must reference at least one anchor node; organize a source first`,
        {
          nodeType: node.type,
          nodeId: node.id,
          property: ANCHOR_PROPERTY,
        },
      )
    }
    if (node.source === undefined || node.source.trim() === '') {
      return reject(`${node.type} must carry a source so its origin stays traceable`, {
        nodeType: node.type,
        nodeId: node.id,
      })
    }
    return { ok: true }
  },
}

export const anchorMustExistGuard = {
  name: 'learn/anchors-must-exist',
  description: 'Every node listed in "anchors" must already exist in the graph.',
  appliesTo: ['node.add'] as const,
  check(mutation: GraphMutation, context: GuardContext): GuardVerdict {
    if (mutation.kind !== 'node.add') return { ok: true }
    const anchors = mutation.node.properties[ANCHOR_PROPERTY]
    if (!Array.isArray(anchors)) return { ok: true }

    const missing: string[] = []
    const resolving = new Set<string>()
    for (const anchor of anchors) {
      if (typeof anchor !== 'string') {
        return reject('every anchor must be a node id', { anchor: String(anchor) })
      }
      if (anchor === mutation.node.id) continue
      resolving.add(anchor)
    }

    for (const anchor of resolving) {
      if (context.graph.getNode(anchor) === undefined) missing.push(anchor)
    }
    if (missing.length > 0) {
      return reject(`anchor node(s) not found: ${missing.join(', ')}`, { missing })
    }
    return { ok: true }
  },
}

export const testPack: DomainPack = defineDomainPack('test-pack', {
  tagNamespaces: [
    { namespace: 'topic', label: 'Topic' },
    { namespace: 'scene', label: 'Scene' },
    { namespace: 'state', label: 'State' },
  ],
  nodeTypes: [
    { id: NODE.concept, label: 'Concept', requiredProperties: ['text'] },
    { id: NODE.claim, label: 'Claim', requiredProperties: ['text'] },
    { id: NODE.question, label: 'Question', requiredProperties: ['text'] },
    { id: NODE.evidence, label: 'Evidence', requiredProperties: ['kind', 'text'] },
    { id: NODE.thought, label: 'Thought', requiredProperties: ['text', 'anchors'] },
    { id: NODE.artifact, label: 'Artifact' },
    { id: NODE.resource, label: 'Resource' },
    { id: NODE.synthesis, label: 'Synthesis', requiredProperties: ['text', 'anchors'] },
  ],
  edgeTypes: [
    {
      id: EDGE.refersTo,
      label: 'refers to',
      category: 'epistemic',
      to: [NODE.concept, NODE.question],
    },
    {
      id: EDGE.answers,
      label: 'answers',
      category: 'epistemic',
      from: [NODE.claim, NODE.evidence, NODE.thought, NODE.synthesis],
      to: [NODE.question],
    },
    {
      id: EDGE.supports,
      label: 'supports',
      category: 'epistemic',
      from: [NODE.evidence, NODE.thought, NODE.synthesis, NODE.claim],
      to: [NODE.claim],
    },
    {
      id: EDGE.contradicts,
      label: 'contradicts',
      category: 'epistemic',
      from: [NODE.evidence, NODE.thought, NODE.synthesis, NODE.claim],
      to: [NODE.claim],
    },
    {
      id: EDGE.prerequisite,
      label: 'prerequisite',
      category: 'epistemic',
      from: [NODE.concept],
      to: [NODE.concept],
    },
    { id: EDGE.contains, label: 'contains', category: 'structural' },
    { id: EDGE.derivedFrom, label: 'derived from', category: 'provenance' },
    { id: EDGE.organizedFrom, label: 'organized from', category: 'provenance' },
    { id: EDGE.synthesizes, label: 'synthesizes', category: 'epistemic', from: [NODE.synthesis] },
    { id: EDGE.authoredBy, label: 'authored by', category: 'provenance' },
    { id: EDGE.taggedWith, label: 'tagged with', category: 'structural' },
    { id: EDGE.evolvesTo, label: 'evolves to', category: 'structural' },
    { id: EDGE.forksFrom, label: 'forks from', category: 'structural' },
    { id: EDGE.sameAs, label: 'same as', category: 'identity' },
    { id: EDGE.exemplifies, label: 'exemplifies', category: 'epistemic' },
  ],
  stateDimensions: [
    {
      id: DIMENSION.confidence,
      label: 'Confidence',
      kind: 'ordinal',
      levels: ['low', 'medium', 'high'],
      ordered: true,
    },
    {
      id: DIMENSION.exposure,
      label: 'Exposure',
      kind: 'ordinal',
      levels: ['none', 'seen', 'studied', 'worked', 'revisited'],
      ordered: true,
    },
    {
      id: DIMENSION.evidence,
      label: 'Evidence',
      kind: 'categorical',
      levels: ['none', 'anecdotal', 'reproduced', 'proven', 'weak', 'derived'],
    },
    {
      id: DIMENSION.articulation,
      label: 'Articulation',
      kind: 'ordinal',
      levels: ['low', 'medium', 'high'],
      ordered: true,
    },
    {
      id: DIMENSION.transfer,
      label: 'Transfer',
      kind: 'ordinal',
      levels: ['low', 'medium', 'high', 'none', 'near', 'far'],
      ordered: true,
    },
    {
      id: DIMENSION.conflict,
      label: 'Conflict',
      kind: 'categorical',
      levels: ['none', 'suspected', 'open', 'resolved'],
    },
    {
      id: DIMENSION.source,
      label: 'Source',
      kind: 'categorical',
      levels: ['self', 'peer', 'authority', 'synthetic', 'agent', 'paper', 'discussion', 'course'],
    },
  ],
  guards: [thoughtRequiresSourceGuard, anchorMustExistGuard],
})

export type EpistemeContext = Episteme & {
  readonly human: Actor
  readonly agent: Actor
  readonly humanId: ActorId
  readonly agentId: ActorId
}

export function createActors(now: () => number): {
  human: Actor
  agent: Actor
  humanId: ActorId
  agentId: ActorId
} {
  const humanId = asId<ActorId>('actor_human')
  const agentId = asId<ActorId>('actor_agent')
  return {
    humanId,
    agentId,
    human: {
      id: humanId,
      kind: 'human',
      displayName: 'Learner',
      shareByDefault: false,
      createdAt: now(),
    },
    agent: {
      id: agentId,
      kind: 'agent',
      displayName: 'Scaffold',
      shareByDefault: false,
      createdAt: now(),
    },
  }
}

export function createFixture(startedAt = 0): EpistemeContext {
  const { human, agent, humanId, agentId } = createActors(() => startedAt)
  const episteme = composeDeterministic(startedAt, {
    actors: [human, agent],
    actorId: humanId,
    packs: [testPack],
  })
  return {
    ...episteme,
    human,
    agent,
    humanId,
    agentId,
  }
}

export async function openFixture(
  store: PersistentEventStore & GraphStorageAdapter,
  options: {
    readonly startedAt?: number
    readonly packs?: readonly DomainPack[]
  } = {},
): Promise<EpistemeContext> {
  const startedAt = options.startedAt ?? 0
  const { human, agent, humanId, agentId } = createActors(() => startedAt)
  const episteme = await openViaSdk(store, {
    clock: createFixedClock(startedAt),
    actors: [human, agent],
    actorId: humanId,
    packs: options.packs ?? [testPack],
  })
  return {
    ...episteme,
    human,
    agent,
    humanId,
    agentId,
  }
}

export async function openEpisteme(
  store: PersistentEventStore & GraphStorageAdapter,
  startedAt = 0,
): Promise<EpistemeContext> {
  return openFixture(store, { startedAt })
}

export function dimensions(
  first: readonly [string, StateValue],
  ...rest: readonly (readonly [string, StateValue])[]
): ReadonlyMap<DimensionId, StateValue> {
  const map = new Map<DimensionId, StateValue>()
  for (const [key, value] of [first, ...rest]) {
    map.set(asId<DimensionId>(key), value)
  }
  return map
}

export function level(value: string): StateValue {
  return { level: value }
}

export function readLevel(
  context: EpistemeContext,
  target: string,
  dimension: string,
): string | undefined {
  const state = context.log.stateOf(asId<NodeId>(target), context.humanId)
  return state.get(asId<DimensionId>(dimension))?.level
}

export interface RetrievedTurn {
  readonly response: AgentResponse
  readonly summary: string
  readonly display: string
  readonly matchedNodeIds: readonly string[]
  readonly branchId: BranchId
}

export async function askIn(
  context: EpistemeContext,
  agent: MockCognitiveAgent,
  question: string,
  options: { readonly actorId?: ActorId; readonly depth?: number } = {},
): Promise<RetrievedTurn> {
  const actorId = options.actorId ?? context.humanId
  const retrieved = await retrieveRelevantContext(context.graph, context.log, question, {
    actorId,
    depth: options.depth ?? 1,
  })
  const response = await agent.respond({ text: question }, toAgentContext(retrieved))
  return {
    response,
    summary: retrieved.summary,
    display: retrieved.summary === '' ? 'nothing is recorded about this yet' : retrieved.summary,
    matchedNodeIds: retrieved.nodes.map((node) => node.id),
    branchId: context.log.currentBranch(actorId).id,
  }
}

export function embeddingRetriever(
  graph: CoreGraph,
  adapter: EmbeddingAdapter,
  cache: EmbeddingCache,
): EmbeddingRetriever {
  return new EmbeddingRetriever(graph, adapter, cache)
}

export function lexicalRetriever(graph: CoreGraph): LexicalGraphRetriever {
  return new LexicalGraphRetriever(graph)
}

export function hybridRetriever(
  graph: CoreGraph,
  log: EventLog,
  adapter: EmbeddingAdapter,
  cache: EmbeddingCache,
  weights?: HybridWeights,
): HybridRetriever {
  return new HybridRetriever(graph, log, adapter, cache, weights)
}

export function learnerResponder(
  input: { readonly text: string },
  context: {
    readonly summary?: string
    readonly detail?: Readonly<Record<string, unknown>>
  },
): { text: string; usedContext: boolean; contextSummary?: string } {
  const summary = context.summary?.trim() ?? ''
  const detail = context.detail

  if (summary === '') {
    return {
      text: `Let's build the foundation first. ${input.text} \u2014 to answer that we should start with what self-attention can and cannot represent, because the question only makes sense once that is clear.`,
      usedContext: false,
    }
  }

  const openConflicts = readStringArray(detail?.['openConflicts'])

  if (openConflicts.length > 0) {
    return {
      text: `You have recorded an unresolved conflict here (${openConflicts.join(', ')}), so I will not build on it as settled. ${input.text} \u2014 the useful next step is to state precisely which case your current position does not cover.`,
      usedContext: true,
      contextSummary: summary,
    }
  }

  const settledLabels = readStringArray(detail?.['settledLabels'])

  if (settledLabels.length === 0) {
    return {
      text: `We have a start on this (${summary}), but nothing you have marked as settled yet. ${input.text} \u2014 let us pin down which part you would defend before going further.`,
      usedContext: true,
      contextSummary: summary,
    }
  }

  return {
    text: `Since you already understand that ${settledLabels.join(' and ')}, let's go straight to ${input.text} without re-deriving the groundwork.`,
    usedContext: true,
    contextSummary: summary,
  }
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

export const testResponder = learnerResponder

export interface SeedTopic {
  readonly id: string
  readonly title: string
  readonly about: string
  readonly source: string
  readonly concepts: readonly { readonly id: string; readonly label: string }[]
  readonly questions: readonly { readonly id: string; readonly label: string }[]
  readonly claims: readonly { readonly id: string; readonly label: string }[]
  readonly edges: readonly { readonly from: string; readonly to: string; readonly type: string }[]
}

export const TRANSFORMERS: SeedTopic = {
  id: 'topic:transformer',
  title: 'Transformer 如何处理顺序',
  about:
    'Transformer 架构中与序列顺序有关的部分：为什么仅靠注意力无法表达顺序，以及为此加入了什么。',
  source: 'paper:arxiv:1706.03762',
  concepts: [
    { id: 'c_transformer', label: 'Transformer' },
    { id: 'c_self_attention', label: '自注意力（Self-Attention）' },
    { id: 'c_positional_encoding', label: '位置编码（Positional Encoding）' },
    { id: 'c_permutation_invariance', label: '置换不变性（Permutation Invariance）' },
    { id: 'c_rope', label: 'RoPE（旋转位置编码）' },
    { id: 'c_attention_head', label: '注意力头（Attention Head）' },
  ],
  questions: [
    { id: 'q_why_order', label: '为什么 Transformer 必须被告知序列顺序？' },
    { id: 'q_how_position', label: '位置信息是怎么给到模型的？' },
    { id: 'q_heads', label: '应该用多少个注意力头？' },
  ],
  claims: [],
  edges: [
    { from: 'q_why_order', to: 'c_permutation_invariance', type: EDGE.refersTo },
    { from: 'q_why_order', to: 'c_self_attention', type: EDGE.refersTo },
    { from: 'q_how_position', to: 'c_positional_encoding', type: EDGE.refersTo },
    { from: 'q_how_position', to: 'c_rope', type: EDGE.refersTo },
    { from: 'c_rope', to: 'c_positional_encoding', type: EDGE.refersTo },
    { from: 'c_positional_encoding', to: 'c_self_attention', type: EDGE.refersTo },
    { from: 'c_permutation_invariance', to: 'c_self_attention', type: EDGE.refersTo },
    { from: 'c_self_attention', to: 'c_transformer', type: EDGE.refersTo },
    { from: 'c_attention_head', to: 'c_self_attention', type: EDGE.refersTo },
    { from: 'q_heads', to: 'c_attention_head', type: EDGE.refersTo },
  ],
}

export const BLANK_TOPIC: SeedTopic = {
  id: 'topic:blank',
  title: '空白的图谱',
  about: '',
  source: 'session:blank',
  concepts: [],
  questions: [],
  claims: [],
  edges: [],
}

export async function seedTopic(
  session: LearnSession,
  topic: SeedTopic = TRANSFORMERS,
): Promise<{ readonly seeded: boolean; readonly nodeCount: number; readonly edgeCount: number }> {
  return session.batch((writer) => {
    const existing = new Set(session.listNodes().map((node) => node.nodeId))
    const alreadyThere = [...topic.concepts, ...topic.questions, ...topic.claims].some((node) =>
      existing.has(node.id),
    )
    if (alreadyThere) return { seeded: false, nodeCount: 0, edgeCount: 0 }

    let nodeCount = 0
    for (const concept of topic.concepts) {
      writer.addNode({
        id: concept.id,
        label: concept.label,
        type: NODE.concept,
        tier: 'reference',
        topic: topic.id,
        source: topic.source,
      })
      nodeCount += 1
    }
    for (const question of topic.questions) {
      writer.addNode({
        id: question.id,
        label: question.label,
        type: NODE.question,
        tier: 'reference',
        topic: topic.id,
        source: topic.source,
      })
      nodeCount += 1
    }
    for (const claim of topic.claims) {
      writer.addNode({
        id: claim.id,
        label: claim.label,
        type: NODE.claim,
        tier: 'reference',
        topic: topic.id,
        source: topic.source,
      })
      nodeCount += 1
    }

    let edgeCount = 0
    for (const edge of topic.edges) {
      writer.link(
        edge.from,
        edge.to,
        edge.type as Parameters<typeof writer.link>[2],
        `seed_${edge.from}_${edge.to}`,
      )
      edgeCount += 1
    }

    return { seeded: true, nodeCount, edgeCount }
  })
}

export { compose, MockCognitiveAgent }
export type { CoreGraph, EventLog, Registries }
