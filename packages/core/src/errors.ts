/**
 * Core error taxonomy.
 *
 * Every rejection names a stable machine-readable `code`, because callers (guards,
 * UI confirmations, the future agent layer) need to branch on *why* a mutation was
 * refused rather than on message text.
 */

export type CoreErrorCode =
  | 'unregistered_node_type'
  | 'unregistered_edge_type'
  | 'unregistered_dimension'
  | 'unregistered_tag_namespace'
  | 'duplicate_registration'
  | 'missing_property'
  | 'invalid_dimension_value'
  | 'invalid_edge_endpoint'
  | 'unknown_node'
  | 'unknown_edge'
  | 'duplicate_id'
  | 'guard_rejected'

export class EpistemeError extends Error {
  readonly code: CoreErrorCode

  constructor(code: CoreErrorCode, message: string) {
    super(message)
    this.name = 'EpistemeError'
    this.code = code
  }
}

/**
 * A guard's refusal.
 *
 * Guards are domain rules, so a rejection has to carry enough detail for the caller
 * to explain it to a human — `guard` names the rule, `details` carries the facts the
 * rule used. This is what the "inspect and reject an inferred change" flow renders.
 */
export class GuardRejection extends EpistemeError {
  readonly guard: string
  readonly details: Readonly<Record<string, unknown>>

  constructor(guard: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super('guard_rejected', message)
    this.name = 'GuardRejection'
    this.guard = guard
    this.details = details
  }

  static is(error: unknown): error is GuardRejection {
    return error instanceof GuardRejection
  }
}

export function isEpistemeError(error: unknown): error is EpistemeError {
  return error instanceof EpistemeError
}
