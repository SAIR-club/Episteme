import { describe, expect, it } from 'vitest'
import {
  latencyPercentiles,
  ndcgAtK,
  rankingMetrics,
  recallAtK,
  reciprocalRank,
} from './metrics.js'

describe('retrieval baseline metrics', () => {
  const relevance = { exact: 2, related: 1 }
  const query = { ranked: ['wrong', 'related', 'exact'], relevance }

  it('counts each relevant node once and uses the complete judgment set as the denominator', () => {
    expect(recallAtK(query, 1)).toBe(0)
    expect(recallAtK(query, 2)).toBe(0.5)
    expect(recallAtK(query, 3)).toBe(1)
    expect(recallAtK({ ranked: ['related', 'related'], relevance }, 2)).toBe(0.5)
  })

  it('gives credit at the rank of the first relevant node', () => {
    expect(reciprocalRank(query)).toBe(0.5)
    expect(reciprocalRank({ ranked: ['wrong'], relevance })).toBe(0)
  })

  it('discounts graded gains at their ranks and normalizes by the ideal ranking', () => {
    expect(ndcgAtK(query, 10)).toBeCloseTo((1 / Math.log2(3) + 3 / 2) / (3 + 1 / Math.log2(3)))
    expect(ndcgAtK(query, 2)).toBeCloseTo(1 / Math.log2(3) / (3 + 1 / Math.log2(3)))
    expect(ndcgAtK({ ranked: ['exact', 'exact', 'related'], relevance }, 3)).toBeCloseTo(
      (3 + 1 / 2) / (3 + 1 / Math.log2(3)),
    )
    expect(ndcgAtK({ ranked: ['exact', 'related'], relevance }, 10)).toBe(1)
  })

  it('gives zero credit when relevance is empty or the ranking misses all relevant nodes', () => {
    for (const item of [
      { ranked: ['wrong'], relevance: {} },
      { ranked: ['wrong'], relevance },
      { ranked: [], relevance },
    ]) {
      expect(recallAtK(item, 10)).toBe(0)
      expect(reciprocalRank(item)).toBe(0)
      expect(ndcgAtK(item, 10)).toBe(0)
    }
  })

  it('macro-averages all ranking metrics over the supplied queries', () => {
    expect(rankingMetrics([query, { ranked: [], relevance }])).toEqual({
      recallAt1: 0,
      recallAt3: 0.5,
      recallAt5: 0.5,
      recallAt10: 0.5,
      mrr: 0.25,
      ndcgAt10: (1 / Math.log2(3) + 3 / 2) / (3 + 1 / Math.log2(3)) / 2,
    })
  })

  it('uses nearest-rank percentiles on unsorted samples', () => {
    const samples = Array.from({ length: 20 }, (_, i) => 20 - i)
    expect(latencyPercentiles(samples)).toEqual({ p50Ms: 10, p95Ms: 19 })
    expect(samples[0]).toBe(20)
    expect(latencyPercentiles([7])).toEqual({ p50Ms: 7, p95Ms: 7 })
    expect(() => latencyPercentiles([])).toThrow(RangeError)
  })
})
