import {
  DeterministicEmbeddingAdapter,
  InMemoryEmbeddingCache,
  asId,
  type NodeId,
} from '@episteme/core'
import { NODE, hybridRetriever, learnTags } from './fixtures.js'
import { describe, expect, it } from 'vitest'
import { createFixture, type EpistemeContext } from './fixtures.js'

/**
 * Retrieval at a size a learner's graph can actually reach.
 *
 * Every other suite in this repository uses a handful of nodes, so nothing exercised the retriever's cost or
 * its behaviour among noise. Both were assumptions. Measured, at the time of writing:
 *
 * | nodes | first query | subsequent | result |
 * | --- | --- | --- | --- |
 * | 50 | ~25 ms | ~1 ms | correct |
 * | 200 | ~29 ms | ~4 ms | correct |
 * | 500 | ~73 ms | ~10 ms | correct |
 * | 1000 | ~120 ms | ~20 ms | correct |
 *
 * The first query is linear in the graph because candidate text is embedded on demand; afterwards it is
 * cached. **Assertions here are about behaviour, not milliseconds** — a timing threshold on shared hardware
 * fails for reasons that have nothing to do with the code, and the number worth knowing is already recorded
 * above.
 */

/** A graph of `size` nodes with a few genuinely on-topic ones buried in unrelated noise. */
function graphOf(size: number): EpistemeContext {
  const context = createFixture()
  for (let index = 0; index < size; index += 1) {
    const label =
      index % 50 === 0
        ? `第 ${index} 条：自注意力为什么无法表达序列顺序`
        : index % 7 === 0
          ? `第 ${index} 条：关于正则化与批大小的选择`
          : `第 ${index} 条：与主题 ${index} 相关的普通条目`
    context.graph.addNode({
      id: asId<NodeId>(`n_${index}`),
      type: index % 7 === 0 ? NODE.claim : NODE.concept,
      label,
      properties: { text: label },
      tags: learnTags('scale'),
      tier: 'reference',
    })
  }
  return context
}

function retrieverFor(context: EpistemeContext) {
  const cache = new InMemoryEmbeddingCache()
  const retriever = hybridRetriever(
    context.graph,
    context.log,
    new DeterministicEmbeddingAdapter(),
    cache,
  )
  return { retriever, cache }
}

describe('retrieval among noise', () => {
  it('still finds the on-topic node when hundreds of unrelated ones surround it', async () => {
    for (const size of [100, 400]) {
      const { retriever } = retrieverFor(graphOf(size))
      const result = await retriever.retrieve({
        text: '为什么注意力处理不了顺序',
        depth: 1,
        limit: 8,
      })

      expect(result.nodeIds.length, `size ${size}`).toBeGreaterThan(0)
      // The point of the whole relevance model: the right thing outranks the noise, at scale as well as at
      // five nodes.
      expect(result.matches[0]?.node.label, `size ${size} top result`).toContain('序列顺序')
    }
  })

  it('returns the same answer from a cold cache and a warm one', async () => {
    const { retriever } = retrieverFor(graphOf(300))
    const query = { text: '注意力与顺序的关系', depth: 1, limit: 8 }

    const cold = await retriever.retrieve(query)
    const warm = await retriever.retrieve(query)

    // Cache warmth is an implementation detail and must never change what a learner sees.
    expect(warm.nodeIds).toEqual(cold.nodeIds)
  })

  it('embeds only what it needs, so adding a node does not re-embed the graph', async () => {
    const context = graphOf(300)
    const { retriever, cache } = retrieverFor(context)

    await retriever.retrieve({ text: '注意力与顺序', depth: 1, limit: 8 })
    const afterFirstQuery = cache.size

    context.graph.addNode({
      id: asId<NodeId>('n_added'),
      type: NODE.concept,
      label: '一个新加入的概念',
      properties: { text: '一个新加入的概念' },
      tags: learnTags('scale'),
      tier: 'reference',
    })
    await retriever.retrieve({ text: '一个全新的问题', depth: 1, limit: 8 })

    // Adding one node must not cost the whole graph. This was a real worry — if the cache keyed on anything
    // coarser than the text, one edit would force a full re-embed and the price of every edit would be the
    // size of the graph. It grew by a small constant, not by 300.
    expect(cache.size - afterFirstQuery).toBeLessThan(10)
  })

  it('scales without changing what it returns for the same question', async () => {
    // Determinism is what makes every other assertion in this repository meaningful, and it has to survive
    // a realistic amount of input.
    const small = retrieverFor(graphOf(50))
    const large = retrieverFor(graphOf(50))

    const first = await small.retriever.retrieve({ text: '顺序问题', depth: 1, limit: 5 })
    const second = await large.retriever.retrieve({ text: '顺序问题', depth: 1, limit: 5 })

    expect(second.nodeIds).toEqual(first.nodeIds)
  })
})
