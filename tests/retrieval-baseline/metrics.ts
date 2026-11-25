export type Relevance = Readonly<Record<string, number>>

export interface JudgedRanking {
  readonly ranked: readonly string[]
  readonly relevance: Relevance
}

function grade(relevance: Relevance, id: string): number {
  return Object.hasOwn(relevance, id) ? (relevance[id] ?? 0) : 0
}

export function recallAtK({ ranked, relevance }: JudgedRanking, k: number): number {
  const relevant = Object.values(relevance).filter((value) => value > 0).length
  if (relevant === 0) return 0
  const retrieved = [...new Set(ranked.slice(0, k))]
  return retrieved.filter((id) => grade(relevance, id) > 0).length / relevant
}

export function reciprocalRank({ ranked, relevance }: JudgedRanking): number {
  const first = ranked.findIndex((id) => grade(relevance, id) > 0)
  return first === -1 ? 0 : 1 / (first + 1)
}

function discountedGain(grades: readonly number[]): number {
  return grades.reduce((sum, value, index) => sum + (2 ** value - 1) / Math.log2(index + 2), 0)
}

export function ndcgAtK({ ranked, relevance }: JudgedRanking, k: number): number {
  const ideal = discountedGain(
    Object.values(relevance)
      .sort((a, b) => b - a)
      .slice(0, k),
  )
  if (ideal === 0) return 0
  const seen = new Set<string>()
  const grades = ranked.slice(0, k).map((id) => {
    if (seen.has(id)) return 0
    seen.add(id)
    return grade(relevance, id)
  })
  return discountedGain(grades) / ideal
}

export function rankingMetrics(queries: readonly JudgedRanking[]) {
  if (queries.length === 0) throw new RangeError('At least one judged query is required')
  const mean = (metric: (query: JudgedRanking) => number): number =>
    queries.reduce((sum, query) => sum + metric(query), 0) / queries.length

  return {
    recallAt1: mean((query) => recallAtK(query, 1)),
    recallAt3: mean((query) => recallAtK(query, 3)),
    recallAt5: mean((query) => recallAtK(query, 5)),
    recallAt10: mean((query) => recallAtK(query, 10)),
    mrr: mean(reciprocalRank),
    ndcgAt10: mean((query) => ndcgAtK(query, 10)),
  }
}

export function latencyPercentiles(samplesMs: readonly number[]) {
  if (samplesMs.length === 0) throw new RangeError('At least one latency sample is required')
  const sorted = [...samplesMs].sort((a, b) => a - b)
  const at = (p: number): number => sorted[Math.ceil(p * sorted.length) - 1]!
  return { p50Ms: at(0.5), p95Ms: at(0.95) }
}
