import {
  asId,
  defineDomainPack,
  type DimensionId,
  type DomainPack,
  type EdgeTypeId,
  type NodeTypeId,
  type StateDimensionDefinition,
} from '@episteme/core'
import type { DistillationPolicy } from '@episteme/distillation'
import {
  recordableDimensions,
  type DimensionPresentation,
  type RecordableDimension,
  type SessionScene,
} from './scene.js'

/**
 * The Learn scene as v0.1.0 shipped it inside the application.
 *
 * Kept for one release so callers that open a session without a scene keep working (ADR 0013, step M3). The Learn
 * vocabulary belongs to MindLink's `domain-learn`, which supplies its own scene; this copy is removed in step M6.
 */

const DIMENSION = {
  confidence: asId<DimensionId>('confidence'),
  articulation: asId<DimensionId>('articulation'),
  evidence: asId<DimensionId>('evidence'),
  conflict: asId<DimensionId>('conflict'),
} as const

/**
 * The axes of understanding this session's pack registers.
 *
 * `evidence` and `transfer` carry levels from two earlier vocabularies. Graphs written by v0.1.0 may hold
 * `weak`, `derived`, `none`, `near` and `far`, and history is append-only, so those stay registered and marked
 * legacy: old events stay valid, and no surface offers them for new input (ADR 0013).
 */
const DEFAULT_STATE_DIMENSIONS: readonly StateDimensionDefinition[] = [
  {
    id: asId<DimensionId>('confidence'),
    label: 'Confidence',
    kind: 'ordinal',
    ordered: true,
    levels: ['low', 'medium', 'high'],
  },
  {
    id: asId<DimensionId>('articulation'),
    label: 'Articulation',
    kind: 'ordinal',
    ordered: true,
    levels: ['low', 'medium', 'high'],
  },
  {
    id: asId<DimensionId>('evidence'),
    label: 'Evidence',
    kind: 'ordinal',
    ordered: true,
    levels: ['none', 'weak', 'reproduced', 'derived', 'anecdotal', 'proven'],
    legacyLevels: ['weak', 'derived'],
  },
  {
    id: asId<DimensionId>('conflict'),
    label: 'Conflict',
    kind: 'ordinal',
    ordered: false,
    levels: ['none', 'suspected', 'open', 'resolved'],
  },
  {
    id: asId<DimensionId>('exposure'),
    label: 'Exposure',
    kind: 'ordinal',
    ordered: true,
    levels: ['none', 'seen', 'studied', 'worked'],
  },
  {
    id: asId<DimensionId>('transfer'),
    label: 'Transfer',
    kind: 'ordinal',
    ordered: true,
    levels: ['low', 'medium', 'high', 'none', 'near', 'far'],
    legacyLevels: ['none', 'near', 'far'],
  },
  {
    id: asId<DimensionId>('source'),
    label: 'Source',
    kind: 'categorical',
    levels: ['self', 'agent', 'paper', 'discussion', 'course'],
  },
]

/** @deprecated The Learn pack moves to MindLink (ADR 0013); build a `SessionScene` instead. */
export const defaultSessionPack: DomainPack = defineDomainPack('default-session-pack', {
  tagNamespaces: [
    { namespace: 'scene', label: 'Scene' },
    { namespace: 'topic', label: 'Topic' },
    { namespace: 'state', label: 'State' },
    { namespace: 'actor', label: 'Actor' },
    { namespace: 'system', label: 'System' },
  ],
  nodeTypes: [
    { id: asId<NodeTypeId>('concept'), label: 'Concept' },
    { id: asId<NodeTypeId>('claim'), label: 'Claim' },
    { id: asId<NodeTypeId>('question'), label: 'Question' },
    { id: asId<NodeTypeId>('evidence'), label: 'Evidence' },
    { id: asId<NodeTypeId>('thought'), label: 'Thought' },
    { id: asId<NodeTypeId>('synthesis'), label: 'Synthesis' },
  ],
  edgeTypes: [
    {
      id: asId<EdgeTypeId>('refers_to'),
      label: 'refers to',
      category: 'epistemic',
      to: [asId<NodeTypeId>('concept'), asId<NodeTypeId>('question')],
    },
    {
      id: asId<EdgeTypeId>('answers'),
      label: 'answers',
      category: 'epistemic',
      from: [
        asId<NodeTypeId>('claim'),
        asId<NodeTypeId>('evidence'),
        asId<NodeTypeId>('thought'),
        asId<NodeTypeId>('synthesis'),
      ],
      to: [asId<NodeTypeId>('question')],
    },
    {
      id: asId<EdgeTypeId>('supports'),
      label: 'supports',
      category: 'epistemic',
      from: [
        asId<NodeTypeId>('evidence'),
        asId<NodeTypeId>('thought'),
        asId<NodeTypeId>('synthesis'),
        asId<NodeTypeId>('claim'),
      ],
      to: [asId<NodeTypeId>('claim')],
    },
    {
      id: asId<EdgeTypeId>('contradicts'),
      label: 'contradicts',
      category: 'epistemic',
      from: [
        asId<NodeTypeId>('evidence'),
        asId<NodeTypeId>('thought'),
        asId<NodeTypeId>('synthesis'),
        asId<NodeTypeId>('claim'),
      ],
      to: [asId<NodeTypeId>('claim')],
    },
    {
      id: asId<EdgeTypeId>('prerequisite'),
      label: 'prerequisite',
      category: 'epistemic',
      from: [asId<NodeTypeId>('concept')],
      to: [asId<NodeTypeId>('concept')],
    },
    { id: asId<EdgeTypeId>('contains'), label: 'contains', category: 'structural' },
    { id: asId<EdgeTypeId>('derived_from'), label: 'derived from', category: 'provenance' },
    { id: asId<EdgeTypeId>('organized_from'), label: 'organized from', category: 'provenance' },
    {
      id: asId<EdgeTypeId>('synthesizes'),
      label: 'synthesizes',
      category: 'epistemic',
      from: [asId<NodeTypeId>('synthesis')],
    },
    { id: asId<EdgeTypeId>('authored_by'), label: 'authored by', category: 'provenance' },
    { id: asId<EdgeTypeId>('tagged_with'), label: 'tagged with', category: 'structural' },
    { id: asId<EdgeTypeId>('evolves_to'), label: 'evolves to', category: 'structural' },
    { id: asId<EdgeTypeId>('forks_from'), label: 'forks from', category: 'structural' },
    { id: asId<EdgeTypeId>('same_as'), label: 'same as', category: 'identity' },
    { id: asId<EdgeTypeId>('exemplifies'), label: 'exemplifies', category: 'epistemic' },
  ],
  stateDimensions: DEFAULT_STATE_DIMENSIONS,
})

/** @deprecated The Learn policy moves to MindLink (ADR 0013); set `SessionScene.distillationPolicy` instead. */
export const defaultDistillationPolicy: DistillationPolicy = {
  id: 'default',
  nodeTypes: {
    concept: 'concept',
    claim: 'claim',
    question: 'question',
    evidence: 'evidence',
    thought: 'thought',
  },
  edgeTypes: {
    about: 'refers_to',
    answers: 'answers',
    supports: 'supports',
    contradicts: 'contradicts',
    revises: 'evolves_to',
  },
  stateDimensions: {
    confidence: ['low', 'medium', 'high'],
    articulation: ['low', 'medium', 'high'],
    conflict: ['suspected', 'open'],
  },
  limits: {
    perEpisode: 12,
    perRun: 60,
  },
  propertiesFor: (role, label) =>
    role === 'evidence' ? { text: label, kind: 'example' } : { text: label },
}

const LOW_MEDIUM_HIGH_ZH = { low: '低', medium: '中', high: '高' }

/**
 * The dimensions a learner may set from this surface, in the order they are offered.
 *
 * Deliberately a subset of the registered axes. The others are recorded by other means or are not yet
 * settable by hand, and offering a control for a dimension whose meaning is unclear would invite the
 * learner to record something they cannot interpret later.
 *
 * Chinese and English are both carried here rather than translated in a view, so the two cannot drift:
 * `AGENTS.md` requires Simplified Chinese for user-facing prose and English for code, and a dimension whose
 * Chinese name disagrees with its English one would be a correctness problem, not a cosmetic one.
 */
const LEARN_PRESENTATIONS: readonly DimensionPresentation[] = [
  {
    id: DIMENSION.confidence,
    labelZh: '确信程度',
    levelLabelsZh: LOW_MEDIUM_HIGH_ZH,
    description: 'How much you would rely on this.',
    descriptionZh: '你愿意多大程度上依赖它。',
  },
  {
    id: DIMENSION.articulation,
    labelZh: '表达程度',
    levelLabelsZh: LOW_MEDIUM_HIGH_ZH,
    description: 'How well you could explain it to someone else.',
    descriptionZh: '你能多好地把它讲给别人听。',
  },
  {
    id: DIMENSION.evidence,
    labelZh: '证据',
    levelLabelsZh: { none: '无', reproduced: '已复现', anecdotal: '零散的', proven: '已证明' },
    description: 'What backs it up.',
    descriptionZh: '它背后有什么支撑。',
  },
  {
    id: DIMENSION.conflict,
    labelZh: '冲突',
    // `suspected` is recordable so a distilled suggestion of it can be decided like any other (ADR 0011). Who
    // decides does not change: only the learner, through the one decision path.
    levelLabelsZh: { none: '无', suspected: '疑似', open: '未解决', resolved: '已解决' },
    description: 'Whether you hold something that contradicts it.',
    descriptionZh: '你是否同时持有与它矛盾的东西。',
  },
]

/**
 * The Learn scene a session uses when it is opened without one.
 *
 * @deprecated Supply a scene: MindLink's `domain-learn` exports the Learn scene (ADR 0013, step M6 removes this).
 */
export const learnScene: SessionScene = {
  name: 'learn',
  packs: [defaultSessionPack],
  distillationPolicy: defaultDistillationPolicy,
  recordableDimensions: recordableDimensions(DEFAULT_STATE_DIMENSIONS, LEARN_PRESENTATIONS),
}

/** @deprecated Read `session.recordableDimensions`, which follows the session's scene. */
export const RECORDABLE_DIMENSIONS: readonly RecordableDimension[] = learnScene.recordableDimensions
