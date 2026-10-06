import type { DistillationPolicy } from '@episteme/distillation'
import { DIMENSION, EDGE, NODE, learnStateDimensions } from './index.js'

/** The levels a dimension takes, read from its registered definition rather than repeated here. */
function levelsOf(dimension: string): readonly string[] {
  const definition = learnStateDimensions.find((candidate) => candidate.id === dimension)
  if (definition?.levels === undefined) {
    throw new Error(`Learn registers no levels for "${dimension}"`)
  }
  return definition.levels
}

/**
 * What distillation may suggest in the Learn scene (ADR 0009).
 *
 * - **Roles.** Concepts, questions, claims and evidence become Learn's own node types. A `thought` is never
 *   distilled: in this ontology a thought is understanding the learner organised deliberately, never a raw
 *   transcript, so what material yields stays a claim until the learner organises it.
 * - **Relations.** "About" is `refers_to`; answers, supports and contradicts are Learn's edges of those names.
 * - **State.** Only the dimensions a learner's own words can bear on: how sure they are (`confidence`) and
 *   whether they can say it (`articulation`), with the levels Learn registers for them.
 * - **Properties.** Every node carries its `text`, and evidence carries the `kind` Learn requires; material
 *   offered as an example is recorded as `example`.
 */
export const learnDistillationPolicy: DistillationPolicy = {
  id: 'learn',
  nodeTypes: {
    concept: NODE.concept,
    question: NODE.question,
    claim: NODE.claim,
    evidence: NODE.evidence,
  },
  edgeTypes: {
    about: EDGE.refersTo,
    answers: EDGE.answers,
    supports: EDGE.supports,
    contradicts: EDGE.contradicts,
  },
  stateDimensions: {
    [DIMENSION.confidence]: levelsOf(DIMENSION.confidence),
    [DIMENSION.articulation]: levelsOf(DIMENSION.articulation),
  },
  limits: { perEpisode: 12, perRun: 60 },
  propertiesFor: (role, label) =>
    role === 'evidence' ? { text: label, kind: 'example' } : { text: label },
}
