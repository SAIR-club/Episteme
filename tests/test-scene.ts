import {
  recordableDimensions,
  type DimensionPresentation,
  type EvaluationPolicy,
  type SessionScene,
} from '@episteme/application'
import type { DistillationPolicy } from '@episteme/distillation'
import { DIMENSION, TEST_STATE_DIMENSIONS, testPack } from './fixtures.js'

/**
 * The scene the Episteme tests and the development CLI compose with (ADR 0013, M6).
 *
 * It uses the universal test pack, so adding a second scene never requires a built-in Learn
 * vocabulary in the application.
 */

const POLICY: DistillationPolicy = {
  id: 'test',
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
  limits: { perEpisode: 12, perRun: 60 },
  propertiesFor: (role, label) =>
    role === 'evidence' ? { text: label, kind: 'example' } : { text: label },
}

const PRESENTATIONS: readonly DimensionPresentation[] = [
  {
    id: DIMENSION.confidence,
    labelZh: '确信程度',
    levelLabelsZh: { low: '低', medium: '中', high: '高' },
    description: 'How much you would rely on this.',
    descriptionZh: '你愿意多大程度上依赖它。',
  },
  {
    id: DIMENSION.articulation,
    labelZh: '表达程度',
    levelLabelsZh: { low: '低', medium: '中', high: '高' },
    description: 'How well you could explain it to someone else.',
    descriptionZh: '你能多好地把它讲给别人听。',
  },
  {
    id: DIMENSION.evidence,
    labelZh: '证据',
    levelLabelsZh: {
      none: '无',
      reproduced: '已复现',
      anecdotal: '零散的',
      proven: '已证明',
    },
    description: 'What backs it up.',
    descriptionZh: '它背后有什么支撑。',
  },
  {
    id: DIMENSION.conflict,
    labelZh: '冲突',
    levelLabelsZh: { none: '无', suspected: '疑似', open: '未解决', resolved: '已解决' },
    description: 'Whether you hold something that contradicts it.',
    descriptionZh: '你是否同时持有与它矛盾的东西。',
  },
]

const EVALUATION: EvaluationPolicy = {
  attentionLevels: ['conflict', 'shaky', 'unexplained', 'settled'],
  isSettled(dimensions) {
    const levelOf = (id: string): string | undefined =>
      dimensions.find((entry) => entry.id === id)?.level
    return (
      ['medium', 'high'].includes(levelOf(DIMENSION.confidence) ?? '') &&
      ['medium', 'high'].includes(levelOf(DIMENSION.articulation) ?? '')
    )
  },
  evaluateAttention(dimensions, openConflicts) {
    if (openConflicts.length > 0) return 'conflict'
    const levelOf = (id: string): string | undefined =>
      dimensions.find((entry) => entry.id === id)?.level
    const confidence = levelOf(DIMENSION.confidence)
    if (
      levelOf(DIMENSION.articulation) === 'low' &&
      confidence !== undefined &&
      confidence !== 'low'
    ) {
      return 'unexplained'
    }
    return EVALUATION.isSettled?.(dimensions) === true ? 'settled' : 'shaky'
  },
}

export const testScene: SessionScene = {
  name: 'test',
  packs: [testPack],
  distillationPolicy: POLICY,
  recordableDimensions: recordableDimensions(TEST_STATE_DIMENSIONS, PRESENTATIONS),
  evaluationPolicy: EVALUATION,
}
