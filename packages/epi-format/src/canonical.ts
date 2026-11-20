import { createHash } from 'node:crypto'

/**
 * Canonical JSON: the one serialization a checksum may be taken over.
 *
 * A pinned subset of RFC 8785 (JCS) covers everything an `.epi` file hashes, and the boundary is
 * deliberate (ADR 0023):
 *
 * - object keys are sorted by UTF-16 code units, recursively;
 * - array order is preserved, because positions carry meaning — record order is history order;
 * - numbers serialize the way ECMAScript writes them, which is what JCS specifies, so integers,
 *   epoch-millis times and finite doubles are all stable across readers;
 * - strings must be well-formed Unicode: a lone surrogate has no canonical form, so it is refused
 *   rather than written as an escape another reader would reproduce differently;
 * - no whitespace, UTF-8, no trailing newline.
 *
 * Full JCS adoption stays open in the v2 draft; nothing hashed today leaves this subset.
 */

/** A value that cannot be written canonically, so a checksum over it would lie. */
export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CanonicalJsonError'
  }
}

export function canonicalJson(value: unknown): string {
  return write(value)
}

function write(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      return numberToken(value)
    case 'string':
      return stringToken(value)
    case 'bigint':
      throw new CanonicalJsonError('a bigint has no canonical JSON form')
    case 'object': {
      if (Array.isArray(value)) {
        // JSON.stringify writes an array's `undefined` as `null`; an object's is dropped below.
        return `[${value.map((item) => (item === undefined ? 'null' : write(item))).join(',')}]`
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      return `{${entries.map(([key, item]) => `${stringToken(key)}:${write(item)}`).join(',')}}`
    }
    default:
      throw new CanonicalJsonError(`a value of type ${typeof value} has no canonical JSON form`)
  }
}

function numberToken(value: number): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalJsonError('NaN and Infinity have no canonical JSON form')
  }
  // `-0` would serialize as `-0` and read back unequal to `0`; JCS writes `0`.
  if (Object.is(value, -0)) return '0'
  // ECMAScript number-to-string is exactly JCS's number form.
  return String(value)
}

function stringToken(value: string): string {
  if (!isWellFormed(value)) {
    throw new CanonicalJsonError('a string with a lone surrogate has no canonical JSON form')
  }
  return JSON.stringify(value)
}

/** Well-formed Unicode: no unpaired surrogate, which JSON.stringify would escape non-canonically. */
function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xdc00 && unit <= 0xdfff) return false
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0
      if (next < 0xdc00 || next > 0xdfff) return false
      index += 1
    }
  }
  return true
}

/** The checksum every section of an `.epi` file carries: sha256 over its canonical JSON. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
