import { segment, type Episode } from '@episteme/distillation'
import { describe, expect, it } from 'vitest'

/**
 * Segmentation into learning episodes (ADR 0009).
 *
 * The property everything later depends on: an episode's text is exactly the source between its offsets, so a
 * suggestion made from it can point back at the words it came from.
 */

function exact(material: string, episodes: readonly Episode[]): void {
  for (const episode of episodes) {
    expect(material.slice(episode.span.start, episode.span.end)).toBe(episode.text)
    for (const turn of episode.turns) {
      expect(turn.span.start).toBeGreaterThanOrEqual(episode.span.start)
      expect(turn.span.end).toBeLessThanOrEqual(episode.span.end)
    }
  }
}

describe('a dialogue', () => {
  const DIALOGUE = [
    '学生：为什么 Transformer 需要位置编码？',
    '老师：因为自注意力本身不区分顺序。',
    '学生：我明白了。',
    '学生：那 RoPE 是怎么做的？',
    '老师：它把位置编码成旋转。',
  ].join('\n')

  it('opens an episode at each question, holding what answers it', () => {
    const episodes = segment({ sourceId: 'src_1', text: DIALOGUE })
    expect(episodes.map((episode) => episode.turns.length)).toEqual([3, 2])
    expect(episodes.map((episode) => episode.kind)).toEqual(['dialogue', 'dialogue'])
    expect(episodes[0]?.turns.map((turn) => turn.speaker)).toEqual(['学生', '老师', '学生'])
    expect(episodes[0]?.turns[1]?.text).toBe('因为自注意力本身不区分顺序。')
    expect(episodes.map((episode) => episode.id)).toEqual(['src_1#e1', 'src_1#e2'])
    exact(DIALOGUE, episodes)
  })

  it('keeps consecutive questions in one episode', () => {
    const text =
      'Learner: Why order?\nLearner: And why sinusoids?\nTutor: Because attention ignores order.'
    const episodes = segment({ sourceId: 's', text })
    expect(episodes).toHaveLength(1)
    expect(episodes[0]?.turns).toHaveLength(3)
  })

  it('puts what comes before the first question in an episode of its own', () => {
    const text =
      'Tutor: Today we look at attention.\nLearner: Why does it ignore order?\nTutor: It sums.'
    const episodes = segment({ sourceId: 's', text })
    expect(episodes.map((episode) => episode.turns.length)).toEqual([1, 2])
  })

  it('reads timestamps into a time range that runs to the next episode', () => {
    const text = [
      '[00:05] 学生：为什么需要位置编码？',
      '[00:12] 老师：因为注意力不看顺序。',
      '[01:30] 学生：RoPE 呢？',
      '[01:41] 老师：旋转。',
    ].join('\n')
    const episodes = segment({ sourceId: 's', text })
    expect(episodes.map((episode) => episode.time)).toEqual([
      { from: 5, to: 90 },
      { from: 90, to: 101 },
    ])
    expect(episodes[0]?.turns[0]?.at).toBe(5)
    exact(text, episodes)
  })

  it('joins a line without a speaker to the turn before it', () => {
    const text = 'Learner: Why?\nTutor: Because attention\nhas no order of its own.'
    const [episode] = segment({ sourceId: 's', text })
    expect(episode?.turns[1]?.text).toBe('Because attention\nhas no order of its own.')
    exact(text, segment({ sourceId: 's', text }))
  })

  it('keeps offsets exact across Windows line endings', () => {
    const text = '学生：为什么？\r\n老师：因为。\r\n学生：那呢？\r\n老师：这样。'
    const episodes = segment({ sourceId: 's', text })
    expect(episodes).toHaveLength(2)
    exact(text, episodes)
    expect(episodes[0]?.text.endsWith('\r')).toBe(false)
  })
})

describe('prose', () => {
  it('is split into paragraphs', () => {
    const text =
      'Self-attention has no notion of order.\nIt treats the input as a set.\n\n\nPositional encodings add order back.'
    const episodes = segment({ sourceId: 's', text })
    expect(episodes.map((episode) => episode.kind)).toEqual(['prose', 'prose'])
    expect(episodes[0]?.text).toBe(
      'Self-attention has no notion of order.\nIt treats the input as a set.',
    )
    expect(episodes[0]?.time).toBeUndefined()
    exact(text, episodes)
  })

  it('is not mistaken for a dialogue because of one colon', () => {
    const text = 'Note: this is prose.\nIt has one colon and then ordinary sentences.\nAnd another.'
    expect(segment({ sourceId: 's', text }).map((episode) => episode.kind)).toEqual(['prose'])
  })
})

describe('nothing', () => {
  it('yields no episodes from empty or blank material', () => {
    expect(segment({ sourceId: 's', text: '' })).toEqual([])
    expect(segment({ sourceId: 's', text: '\n  \n' })).toEqual([])
  })
})
