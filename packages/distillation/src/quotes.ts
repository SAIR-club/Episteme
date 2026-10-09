/**
 * The text a source is stored as, and how a quote is found in it (ADR 0011).
 *
 * Everything that points into material (episodes, spans, excerpts, a review's highlight) is computed on the
 * canonical text, so a span is correct by construction and never needs mapping back. Offsets are UTF-16 code
 * units, the unit `String.prototype.slice` uses.
 */

/** A quote must contain at least this many letters or digits. Counted so, Chinese and English weigh alike. */
export const MIN_QUOTE_SIGNS = 2
/** A quote longer than this is a passage, not the words something rests on. */
export const MAX_QUOTE_LENGTH = 1000

/**
 * Material, or a quote from it, in the one form it is stored and matched in: line breaks as `\n`, then Unicode
 * NFC. The two differ from what was sent only by canonical equivalence and line endings.
 */
export function canonicalText(text: string): string {
  return text.replace(/\r\n?/gu, '\n').normalize('NFC')
}

/** How many letters and digits the words hold. Punctuation, spaces and symbols do not count. */
export function quoteSigns(quote: string): number {
  return quote.match(/[\p{L}\p{N}]/gu)?.length ?? 0
}

/** Where `quote` starts in `text`, every time, overlapping occurrences included. */
export function occurrencesOf(text: string, quote: string): readonly number[] {
  const found: number[] = []
  if (quote === '') return found
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) found.push(at)
  return found
}

/** Which occurrence of `quote` in `text`, 1-based, starts at `offset`; `undefined` when none starts there. */
export function occurrenceAt(text: string, quote: string, offset: number): number | undefined {
  const index = occurrencesOf(text, quote).indexOf(offset)
  return index < 0 ? undefined : index + 1
}
