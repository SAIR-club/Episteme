import type { Suggestion } from '@episteme/agent'
import type { Span, TimeRange } from './segment.js'

/**
 * The domain-neutral parts of understanding distillation looks for.
 *
 * The engine reasons in these; what each one is in a particular graph is the policy's to say.
 */
export type Role = 'concept' | 'question' | 'claim' | 'evidence' | 'thought'

/**
 * The domain-neutral relations between them. `about` points a question or claim at what it concerns; `revises`
 * points an earlier claim at the one that corrects it, without withdrawing the earlier one (ADR 0011).
 */
export type Relation = 'about' | 'answers' | 'supports' | 'contradicts' | 'revises'

export interface Refusal {
  readonly code: string
  readonly message: string
  /** For `already_known`: the node the learner already has, so the observation can be sent against it. */
  readonly existingNodeId?: string
}

/**
 * What a domain allows distillation to suggest, supplied by its Domain Pack (ADR 0009).
 *
 * Nothing in the engine names a node type, an edge type or a state dimension; it learns all of them here. A
 * role or relation the policy leaves out is never suggested, and a suggestion naming a type the policy does
 * not list is refused.
 */
export interface DistillationPolicy {
  readonly id: string
  /** The registered node type each extracted role becomes. */
  readonly nodeTypes: Partial<Readonly<Record<Role, string>>>
  /** The registered edge type each relation becomes. */
  readonly edgeTypes: Partial<Readonly<Record<Relation, string>>>
  /** The state changes that may be suggested: each dimension with the levels it may take. */
  readonly stateDimensions: Readonly<Record<string, readonly string[]>>
  readonly limits: {
    /** Candidates kept from one episode; the rest are refused as over the limit. */
    readonly perEpisode: number
    /** Candidates kept from one piece of material. */
    readonly perRun: number
  }
  /** Properties a node of this role must carry in this domain, such as the kind of a piece of evidence. */
  readonly propertiesFor?: (role: Role, label: string) => Readonly<Record<string, unknown>>
  /** The domain's own checks, after the engine's. A refusal keeps the candidate visible, refused. */
  readonly validate?: (candidate: Candidate) => Refusal | undefined
}

/** Where a candidate came from: enough to show the learner the words it rests on. */
export interface Origin {
  readonly sourceId: string
  readonly episodeId: string
  /** The words the candidate rests on, as character offsets in the source. */
  readonly span: Span
  /** Those words, verbatim, shortened if long. */
  readonly excerpt: string
  readonly time?: TimeRange
  /** Who said them, when they lie in one speaker's turn of a dialogue. */
  readonly speaker?: string
}

/**
 * One thing distillation found, and whether it may be suggested.
 *
 * Refused candidates are kept, with the reason, as `AgentSuggestion` intends: a learner, or a test, can see
 * what was found and why it was not offered, instead of it disappearing. A kept candidate always has the origin
 * it rests on. A refused one has it whenever its words could be located; a quote that could not be located
 * leaves no origin rather than an invented one (ADR 0011).
 */
export type Candidate =
  | {
      /** Unique within one distillation, such as `e2.q1`. Other candidates name it as `cand:e2.q1`. */
      readonly ref: string
      readonly suggestion: Suggestion
      readonly origin: Origin
      readonly status: 'suggested'
      readonly refusal?: undefined
    }
  | {
      readonly ref: string
      readonly suggestion: Suggestion
      readonly origin?: Origin
      readonly status: 'refused'
      readonly refusal: Refusal
    }
