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
