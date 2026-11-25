import { readFile, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import {
  asId,
  DeterministicEmbeddingAdapter,
  HybridRetriever,
  InMemoryEmbeddingCache,
  retrieveWith,
  visibleTo,
  type EdgeId,
  type NodeId,
} from '@episteme/core'
import { compose } from '@episteme/sdk'
import { expect, it } from 'vitest'
import { createActors, EDGE, NODE, testPack } from './fixtures.js'
import { latencyPercentiles, rankingMetrics } from './retrieval-baseline/metrics.js'

interface QuerySet {
  readonly nodes: readonly {
    id: string
    kind: 'concept' | 'claim'
    label: string
    tags: readonly string[]
  }[]
  readonly edges: readonly { from: string; to: string }[]
  readonly queries: readonly {
    id: string
    category: string
    text: string
    relevance: Readonly<Record<string, 1 | 2>>
  }[]
}

const queryFile = new URL('./retrieval-baseline/queries.json', import.meta.url)
const baselineFile = new URL('./retrieval-baseline/baseline.json', import.meta.url)
const warmupPasses = 3
const measuredPasses = 15

function expectRankingAtLeast(
  scope: string,
  actual: ReturnType<typeof rankingMetrics>,
  baseline: Readonly<Record<string, number>>,
): void {
  for (const [metric, value] of Object.entries(actual)) {
    expect.soft(value, `${scope} ${metric}`).toBeGreaterThanOrEqual(baseline[metric]!)
  }
}

it('matches or exceeds the hybrid retrieval baseline', async () => {
  const { nodes, edges, queries } = JSON.parse(await readFile(queryFile, 'utf8')) as QuerySet
  const { human, humanId } = createActors(() => 0)
  let timestamp = 0
  const { graph, log } = compose({
    actors: [human],
    actorId: humanId,
    packs: [testPack],
    clock: { now: () => ++timestamp },
  })
  for (const { id, kind, label, tags } of nodes) {
    graph.addNode({
      id: asId<NodeId>(id),
      type: NODE[kind],
      label,
      tags,
      properties: { text: label },
      tier: kind === 'claim' ? 'thought' : 'reference',
      source: 'fixture:retrieval-baseline',
    })
  }
  for (const { from, to } of edges) {
    graph.addEdge({
      id: asId<EdgeId>(`edge-${from}-${to}`),
      type: EDGE.refersTo,
      from: asId<NodeId>(from),
      to: asId<NodeId>(to),
    })
  }

  const view = visibleTo(graph, humanId)
  const retriever = new HybridRetriever(
    view,
    log,
    new DeterministicEmbeddingAdapter(),
    new InMemoryEmbeddingCache(),
  )
  // Use recall's ranked context, with room to score the full top ten.
  const retrieve = (text: string) =>
    retrieveWith(retriever, view, log, text, { actorId: humanId, depth: 1, limit: 10 })

  const evaluated = []
  for (const query of queries) {
    for (const [id, grade] of Object.entries(query.relevance)) {
      expect(view.getNode(id), `${query.id} relevance judgment for ${id}`).toBeDefined()
      expect([1, 2], `${query.id} relevance grade for ${id}`).toContain(grade)
    }
    const context = await retrieve(query.text)
    expect(context.ranked, query.id).toBeDefined()
    evaluated.push({ ...query, ranked: context.ranked!.map((entry) => entry.nodeId) })
  }

  // The first pass records rankings. Repeat it untimed to warm the retrieval path.
  for (let run = 1; run < warmupPasses; run++) {
    for (const { text } of queries) await retrieve(text)
  }

  const samplesMs: number[] = []
  for (let run = 0; run < measuredPasses; run++) {
    for (const { text } of queries) {
      const start = performance.now()
      await retrieve(text)
      samplesMs.push(performance.now() - start)
    }
  }

  const answerable = evaluated.filter(({ relevance }) => Object.keys(relevance).length > 0)
  const noAnswer = evaluated.filter(({ relevance }) => Object.keys(relevance).length === 0)
  const categories = [...new Set(answerable.map(({ category }) => category))]
  const report = {
    queryCount: queries.length,
    answerableCount: answerable.length,
    ranking: rankingMetrics(answerable),
    byCategory: Object.fromEntries(
      categories.map((category) => {
        const cases = answerable.filter((query) => query.category === category)
        return [category, { queryCount: cases.length, ranking: rankingMetrics(cases) }]
      }),
    ),
    noAnswer: {
      queryCount: noAnswer.length,
      emptyCount: noAnswer.filter(({ ranked }) => ranked.length === 0).length,
      returnedCount: noAnswer.reduce((sum, { ranked }) => sum + ranked.length, 0),
    },
    latency: { sampleCount: samplesMs.length, ...latencyPercentiles(samplesMs) },
  }

  if (process.env['EPISTEME_WRITE_BASELINE'] === '1') {
    await writeFile(baselineFile, `${JSON.stringify(report, null, 2)}\n`)
    return
  }

  const baseline = JSON.parse(await readFile(baselineFile, 'utf8')) as typeof report
  expect(report.queryCount).toBe(baseline.queryCount)
  expect(report.noAnswer.queryCount).toBe(baseline.noAnswer.queryCount)
  expectRankingAtLeast('overall', report.ranking, baseline.ranking)
  for (const [category, { queryCount, ranking }] of Object.entries(baseline.byCategory)) {
    const current = report.byCategory[category]!
    expect(current.queryCount, category).toBe(queryCount)
    expectRankingAtLeast(category, current.ranking, ranking)
  }
  expect
    .soft(report.noAnswer.emptyCount, 'empty no-answer queries')
    .toBeGreaterThanOrEqual(baseline.noAnswer.emptyCount)
  expect
    .soft(report.noAnswer.returnedCount, 'results for no-answer queries')
    .toBeLessThanOrEqual(baseline.noAnswer.returnedCount)
  // Latency is recorded with the baseline but only compared on request: the baseline was measured on one machine,
  // and a slower CI runner would fail a millisecond budget without anything having changed.
  if (process.env['EPISTEME_CHECK_LATENCY'] === '1') {
    for (const percentile of ['p50Ms', 'p95Ms'] as const) {
      const previous = baseline.latency[percentile]
      const toleranceMs = Math.max(previous * 0.25, 0.5)
      expect
        .soft(report.latency[percentile], percentile)
        .toBeLessThanOrEqual(previous + toleranceMs)
    }
  }
})
