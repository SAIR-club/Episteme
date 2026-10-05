import { asId } from './ids.js'
import type { NodeTypeId, EdgeTypeId, DimensionId } from './ids.js'
import type { DomainPack } from '../graph/registries.js'
import { defineDomainPack } from '../graph/registries.js'

/**
 * Standard Epistemic Ontology Pack.
 *
 * Grounded in formal epistemology and argumentation theory (Toulmin 1958, Dung 1995, Jøsang 2016).
 * This pack provides a clean, orthogonal set of node types, edge relations, and cognitive state dimensions.
 *
 * It is completely OPTIONAL. Callers can omit it, replace it, or use their own declarative packs.
 */

// ── Standard Node Types ───────────────────────────────────────────────────────
export const STANDARD_NODE_TYPES = {
  concept: asId<NodeTypeId>('concept'),
  claim: asId<NodeTypeId>('claim'),
  question: asId<NodeTypeId>('question'),
  evidence: asId<NodeTypeId>('evidence'),
  artifact: asId<NodeTypeId>('artifact'),
  thought: asId<NodeTypeId>('thought'),
} as const

// ── 4 Orthogonal Categories of Edges (8 Essential Relations) ────────────────
export const STANDARD_EDGE_TYPES = {
  // 1. Epistemic / Argumentative (truth & justification)
  supports: asId<EdgeTypeId>('supports'),
  contradicts: asId<EdgeTypeId>('contradicts'),

  // 2. Ontological / Structural (concepts & hierarchy)
  dependsOn: asId<EdgeTypeId>('depends_on'),
  contains: asId<EdgeTypeId>('contains'),

  // 3. Dialogic / Inquiry (exploration flow)
  answers: asId<EdgeTypeId>('answers'),
  derivesFrom: asId<EdgeTypeId>('derives_from'),

  // 4. Identity / Alignment (cross-perspective mapping)
  sameAs: asId<EdgeTypeId>('same_as'),
  exemplifies: asId<EdgeTypeId>('exemplifies'),
} as const

// ── 3-Axis Orthogonal Cognitive State Dimensions (Subjective Logic Triad) ────
export const STANDARD_STATE_DIMENSIONS = {
  // Subjective degree of belief / acceptance
  confidence: asId<DimensionId>('confidence'),
  // Objective depth of grounding
  evidence: asId<DimensionId>('evidence'),
  // Epistemic tension within the cognitive network
  conflict: asId<DimensionId>('conflict'),
} as const

export const standardEpistemicPack: DomainPack = defineDomainPack('standard-epistemic', {
  tagNamespaces: [
    { namespace: 'topic', label: 'Topic', description: 'Subject matter domain' },
    { namespace: 'scene', label: 'Scene', description: 'Application viewpoint' },
    { namespace: 'state', label: 'State', description: 'Lifecycle state' },
  ],
  nodeTypes: [
    {
      id: STANDARD_NODE_TYPES.concept,
      label: 'Concept',
      description: 'A domain concept or term',
      defaultTier: 'reference',
    },
    {
      id: STANDARD_NODE_TYPES.claim,
      label: 'Claim',
      description: 'A propositional claim capable of being true, false, or contested',
      defaultTier: 'thought',
    },
    {
      id: STANDARD_NODE_TYPES.question,
      label: 'Question',
      description: 'An inquiry driving exploration',
      defaultTier: 'thought',
    },
    {
      id: STANDARD_NODE_TYPES.evidence,
      label: 'Evidence',
      description: 'An empirical observation, citation, or data',
      defaultTier: 'reference',
    },
    {
      id: STANDARD_NODE_TYPES.artifact,
      label: 'Artifact',
      description: 'An external document, note, or code artifact',
      defaultTier: 'reference',
    },
    {
      id: STANDARD_NODE_TYPES.thought,
      label: 'Thought',
      description: 'An organized reflection or synthesis',
      defaultTier: 'thought',
    },
  ],
  edgeTypes: [
    {
      id: STANDARD_EDGE_TYPES.supports,
      label: 'supports',
      category: 'epistemic',
      description: 'Provides positive evidential or logical backing',
      from: [STANDARD_NODE_TYPES.evidence, STANDARD_NODE_TYPES.claim, STANDARD_NODE_TYPES.thought],
      to: [STANDARD_NODE_TYPES.claim, STANDARD_NODE_TYPES.thought],
    },
    {
      id: STANDARD_EDGE_TYPES.contradicts,
      label: 'contradicts',
      category: 'epistemic',
      description: 'Attacks or disputes a proposition with counter-evidence or conflict',
      from: [STANDARD_NODE_TYPES.evidence, STANDARD_NODE_TYPES.claim, STANDARD_NODE_TYPES.thought],
      to: [STANDARD_NODE_TYPES.claim, STANDARD_NODE_TYPES.thought],
    },
    {
      id: STANDARD_EDGE_TYPES.dependsOn,
      label: 'depends on',
      category: 'structural',
      description: 'Prerequisite relationship (understanding target requires understanding source)',
    },
    {
      id: STANDARD_EDGE_TYPES.contains,
      label: 'contains',
      category: 'structural',
      description: 'Mereological part-whole or aggregation relationship',
    },
    {
      id: STANDARD_EDGE_TYPES.answers,
      label: 'answers',
      category: 'provenance',
      description: 'Proposition responds to or addresses an inquiry question',
      to: [STANDARD_NODE_TYPES.question],
    },
    {
      id: STANDARD_EDGE_TYPES.derivesFrom,
      label: 'derives from',
      category: 'provenance',
      description: 'New conclusion or thought is derived from source material or reflection',
    },
    {
      id: STANDARD_EDGE_TYPES.sameAs,
      label: 'same as',
      category: 'identity',
      description:
        'Equivalence assertion aligning cross-viewpoint representations of the same entity',
    },
    {
      id: STANDARD_EDGE_TYPES.exemplifies,
      label: 'exemplifies',
      category: 'epistemic',
      description: 'Concrete instance or artifact illustrates a generalized concept or claim',
    },
  ],
  stateDimensions: [
    {
      id: STANDARD_STATE_DIMENSIONS.confidence,
      label: 'Confidence',
      kind: 'ordinal',
      levels: ['low', 'medium', 'high'],
      ordered: true,
    },
    {
      id: STANDARD_STATE_DIMENSIONS.evidence,
      label: 'Evidence Grounding',
      kind: 'categorical',
      levels: ['anecdotal', 'empirical', 'analytical'],
    },
    {
      id: STANDARD_STATE_DIMENSIONS.conflict,
      label: 'Conflict Status',
      kind: 'categorical',
      levels: ['coherent', 'contested'],
    },
  ],
})
