/**
 * Refusals of an `.epi` file are values with codes, like every refusal in Episteme: a reader can show
 * one, log one or dismiss one without exception-driven control flow.
 */

export type EpiFileProblem =
  | 'not_an_epi'
  | 'unsupported_version'
  | 'invalid_profiles'
  | 'missing_section'
  | 'damaged'
  | 'projection_mismatch'

/** Reading an `.epi` file refused, with nothing read. */
export class EpiFileError extends Error {
  readonly code: EpiFileProblem

  constructor(code: EpiFileProblem, message: string) {
    super(message)
    this.name = 'EpiFileError'
    this.code = code
  }
}
