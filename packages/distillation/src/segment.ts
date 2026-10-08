/**
 * Segmentation: learning material into learning episodes (ADR 0009).
 *
 * Deterministic and domain-agnostic. It knows what a dialogue turn and a paragraph look like, and nothing about
 * any subject. Every episode records where it sits in the source, as character offsets, so whatever is later
 * suggested from it can point back at the exact words.
 */

export interface Material {
  readonly sourceId: string
  readonly text: string
}

export interface Span {
  readonly start: number
  readonly end: number
}

/** A time range in seconds. */
export interface TimeRange {
  readonly from: number
  readonly to: number
}

/** One utterance in a dialogue, or a whole paragraph of prose. */
export interface Turn {
  /** Who spoke, as written in the material. Absent for prose. */
  readonly speaker?: string
  readonly text: string
  readonly span: Span
  /** When it was said, in seconds, if the material had a timestamp for it. */
  readonly at?: number
}

/**
 * A stretch of material that holds one step of learning.
 *
 * In a dialogue: a question and what follows it, up to the next question. In prose: a paragraph.
 */
export interface Episode {
  readonly id: string
  readonly index: number
  readonly sourceId: string
  readonly kind: 'dialogue' | 'prose'
  /** Exactly `material.text.slice(span.start, span.end)`. */
  readonly text: string
  readonly span: Span
  readonly time?: TimeRange
  readonly turns: readonly Turn[]
}

/** `[mm:ss]` or `[hh:mm:ss]`, then `speaker:` or `speaker：`, then the utterance. */
const TURN =
  /^(\s*)(?:\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s*)?([^:：\n[\]]{1,24}?)\s*[:：]\s*(\S.*)$/u

const QUESTION = /[?？]\s*$/u

/**
 * Splits material into episodes.
 *
 * Material is read as a dialogue when most of its non-empty lines are turns (`speaker: utterance`), and as
 * prose otherwise. Material with no text yields no episodes.
 */
export function segment(material: Material): readonly Episode[] {
  const lines = linesOf(material.text)
  const content = lines.filter((line) => line.text.trim() !== '')
  if (content.length === 0) return []

  const turnLines = content.filter((line) => TURN.test(line.text))
  const isDialogue = turnLines.length >= 2 && turnLines.length * 2 >= content.length
  return isDialogue ? dialogueEpisodes(material, lines) : proseEpisodes(material, lines)
}

interface Line {
  readonly text: string
  readonly start: number
}

function linesOf(text: string): readonly Line[] {
  const lines: Line[] = []
  let start = 0
  for (const raw of text.split('\n')) {
    // A carriage return belongs to the line break, not to the line's words.
    const lineText = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    lines.push({ text: lineText, start })
    start += raw.length + 1
  }
  return lines
}

function dialogueEpisodes(material: Material, lines: readonly Line[]): readonly Episode[] {
  const turns: Turn[] = []
  for (const line of lines) {
    const match = TURN.exec(line.text)
    if (match !== null) {
      const [, indent = '', hours, minutes, seconds, speaker = '', said = ''] = match
      const at =
        minutes === undefined
          ? undefined
          : seconds === undefined
            ? Number(hours) * 60 + Number(minutes)
            : Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)
      turns.push({
        speaker: speaker.trim(),
        text: said.trimEnd(),
        span: { start: line.start + indent.length, end: line.start + line.text.trimEnd().length },
        ...(at === undefined ? {} : { at }),
      })
      continue
    }
    // A line without a speaker continues the turn before it.
    const previous = turns.at(-1)
    if (previous !== undefined && line.text.trim() !== '') {
      turns[turns.length - 1] = {
        ...previous,
        text: `${previous.text}\n${line.text.trim()}`,
        span: { start: previous.span.start, end: line.start + line.text.trimEnd().length },
      }
    }
  }

  // A question opens an episode; what follows it belongs to it until the next question.
  const groups: Turn[][] = []
  for (const turn of turns) {
    const current = groups.at(-1)
    const opensEpisode =
      QUESTION.test(turn.text) && current !== undefined && !onlyQuestions(current)
    if (current === undefined || opensEpisode) groups.push([turn])
    else current.push(turn)
  }

  return groups.map((group, index) => {
    const first = group[0]!
    const last = group.at(-1)!
    const span = { start: first.span.start, end: last.span.end }
    const nextFirst = groups[index + 1]?.[0]
    const times = group.map((turn) => turn.at).filter((at): at is number => at !== undefined)
    const from = times[0]
    const to = nextFirst?.at ?? times.at(-1)
    return {
      id: `${material.sourceId}#e${index + 1}`,
      index,
      sourceId: material.sourceId,
      kind: 'dialogue' as const,
      text: material.text.slice(span.start, span.end),
      span,
      ...(from === undefined || to === undefined ? {} : { time: { from, to } }),
      turns: group,
    }
  })
}

/** Consecutive questions belong together: a follow-up question is part of the same step. */
function onlyQuestions(group: readonly Turn[]): boolean {
  return group.every((turn) => QUESTION.test(turn.text))
}

function proseEpisodes(material: Material, lines: readonly Line[]): readonly Episode[] {
  const paragraphs: { start: number; end: number }[] = []
  let open: { start: number; end: number } | undefined
  for (const line of lines) {
    if (line.text.trim() === '') {
      open = undefined
      continue
    }
    const indent = line.text.length - line.text.trimStart().length
    const end = line.start + line.text.trimEnd().length
    if (open === undefined) {
      open = { start: line.start + indent, end }
      paragraphs.push(open)
    } else {
      open.end = end
    }
  }

  return paragraphs.map((span, index) => {
    const text = material.text.slice(span.start, span.end)
    return {
      id: `${material.sourceId}#e${index + 1}`,
      index,
      sourceId: material.sourceId,
      kind: 'prose' as const,
      text,
      span,
      turns: [{ text, span }],
    }
  })
}
