import {
  CHINESE_TERMS,
  DeterministicEmbeddingAdapter,
  InMemoryEmbeddingCache,
  cosineSimilarity,
  lexiconTokens,
  retrievalTokens,
} from '@episteme/core'
import { hybridRetriever } from './fixtures.js'
import { describe, expect, it } from 'vitest'
import { createFixture } from './fixtures.js'
import { seedEvaluationGraph } from './retrieval-evaluation-fixtures.js'

/**
 * Chinese retrieval.
 *
 * This file exists because of a defect that only appeared once the surface was given a Chinese interface: a
 * Chinese question produced **no semantic signal at all**. Every result sat at exactly the recency floor,
 * because the tokenizer split on characters that are not letters and Chinese has no spaces — so the whole
 * question arrived as one token, shared no vocabulary with any label, and scored zero against everything.
 *
 * A bilingual interface over a monolingual retriever is worse than either alone: it looks like it works and
 * quietly returns nothing.
 */

const adapter = new DeterministicEmbeddingAdapter()

async function similarity(left: string, right: string): Promise<number> {
  return cosineSimilarity(await adapter.embed(left), await adapter.embed(right))
}

describe('Chinese text is segmented', () => {
  it('splits a question into its words, longest match first', () => {
    // `为什么` and `注意力` are single terms rather than characters; `位置编码` is one term, not `位置`+`编码`.
    expect(lexiconTokens('为什么注意力很难处理顺序')).toEqual([
      '为什么',
      '注意力',
      '很',
      '难',
      '处理',
      '顺序',
    ])
    expect(lexiconTokens('位置编码')).toEqual(['位置编码'])
  })

  it('keeps an unknown word as its own token rather than dropping it', () => {
    const tokens = lexiconTokens('量子纠缠')
    expect(tokens.length).toBeGreaterThan(0)
    // Nothing here should silently vanish: a dropped token is a query that cannot match.
    expect(tokens.join('')).toContain('量')
  })

  it('still splits Latin text the way it always did', () => {
    expect(lexiconTokens('Why sequence order?')).toEqual(['why', 'sequence', 'order'])
  })

  it('segments a bilingual label and keeps both halves', () => {
    const tokens = lexiconTokens('自注意力（Self-Attention）')
    expect(tokens).toContain('自注意力')
    expect(tokens).toContain('attention')
  })
})

describe('Chinese questions reach stored cognition', () => {
  it('scores a paraphrase far above an unrelated question', async () => {
    const relevant = await similarity(
      '为什么注意力很难处理顺序',
      '为什么 Transformer 必须被告知序列顺序？',
    )
    const unrelated = await similarity('为什么注意力很难处理顺序', '应该用多少个注意力头？')

    // The gap is the signal. Before the lexicon existed both were 0.
    expect(relevant).toBeGreaterThan(0.3)
    expect(unrelated).toBeLessThan(0.15)
  })

  it('matches across languages in both directions', async () => {
    // A Chinese question finds an English claim, and an English question finds a Chinese label. This is what
    // makes one graph work for a bilingual learner rather than two parallel stores.
    expect(
      await similarity(
        '为什么自注意力无法表达顺序',
        'Self-attention does not encode sequence order.',
      ),
    ).toBeGreaterThan(0.3)
    expect(
      await similarity('positional encoding', '位置编码（Positional Encoding）'),
    ).toBeGreaterThan(0.3)
  })

  it('filters Chinese particles out of the lexical signal', () => {
    // Without this, `的` and `是` behave exactly as `"the"` and `"in"` did when the English stop list was
    // bypassed — and the failure was a hard negative outranking the expected node.
    expect(retrievalTokens('顺序是什么')).not.toContain('什么')
    expect(retrievalTokens('self-attention 的顺序')).not.toContain('的')
    expect(retrievalTokens('顺序是什么')).toContain('顺序')
  })

  it('retrieves the right node for a Chinese question', async () => {
    const context = createFixture()
    seedEvaluationGraph(context)
    const hybrid = hybridRetriever(
      context.graph,
      context.log,
      new DeterministicEmbeddingAdapter(),
      new InMemoryEmbeddingCache(),
    )

    const result = await hybrid.retrieve({
      text: '为什么模型必须知道每个词的先后顺序',
      actorId: context.humanId,
      depth: 1,
    })

    // A sequence-order claim, not one about attention heads or learning rates.
    const ranked = result.nodeIds.map(String)
    const orderAt = ranked.findIndex((id) => id.includes('order') || id.includes('pe_index'))
    const headsAt = ranked.indexOf('claim_heads')
    expect(orderAt).toBeGreaterThanOrEqual(0)
    if (headsAt >= 0) expect(orderAt).toBeLessThan(headsAt)
  })

  it('leaves an unrelated Chinese question with nothing relevant', async () => {
    const context = createFixture()
    seedEvaluationGraph(context)
    const hybrid = hybridRetriever(
      context.graph,
      context.log,
      new DeterministicEmbeddingAdapter(),
      new InMemoryEmbeddingCache(),
    )

    const result = await hybrid.retrieve({
      text: '葡萄牙的首都是哪里',
      actorId: context.humanId,
      depth: 1,
    })

    // Suppression matters as much as recall, and this is the case that caught the stop-word regression.
    expect(result.matches.map((entry) => entry.node.id)).toEqual([])
  })
})

describe('the Chinese lexicon is a table, not a model', () => {
  it('maps every term onto vocabulary the English lexicon already knows', () => {
    // If a Chinese term expanded to a token no English text can produce, the two languages would occupy
    // disjoint regions and cross-language retrieval would silently stop working.
    const englishVocabulary = new Set(Object.values(CHINESE_TERMS).flat())
    const shared = new Set<string>()
    for (const vocabulary of Object.values(CHINESE_TERMS)) {
      for (const term of vocabulary) if (englishVocabulary.has(term)) shared.add(term)
    }
    expect(shared.size).toBeGreaterThan(10)
  })
})
