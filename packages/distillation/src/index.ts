/**
 * Distillation: learning material in, candidate understanding out, as suggestions only (ADR 0009).
 *
 * Domain-agnostic. What a candidate becomes in a given graph is decided by a `DistillationPolicy` that a
 * Domain Pack supplies; nothing here names a node type of its own.
 */
export {
  segment,
  type Episode,
  type Material,
  type Span,
  type TimeRange,
  type Turn,
} from './segment.js'
export type { Candidate, DistillationPolicy, Origin, Refusal, Relation, Role } from './policy.js'
export { distill, type DistillInput, type DistillationResult } from './engine.js'
export { RuleBasedDistiller, type RuleBasedOptions } from './rule-based.js'
export {
  MAX_QUOTE_LENGTH,
  MIN_QUOTE_SIGNS,
  canonicalText,
  occurrenceAt,
  occurrencesOf,
  quoteSigns,
} from './quotes.js'
