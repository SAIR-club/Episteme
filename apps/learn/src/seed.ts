import { EDGE, NODE } from '@episteme/domain-learn'
import type { LearnSession } from '@episteme/application'

/**
 * A starting topic, so a learner is not staring at an empty graph.
 *
 * A cognition system that begins empty cannot demonstrate its own point: retrieval has nothing to retrieve,
 * and the learner's first question produces the same blank answer a stateless chatbot would give. Seeding
 * gives the first question something to find.
 *
 * ## What is seeded, and what is deliberately not
 *
 * Every node here is **reference material about the transformer architecture** — public, sourced, and
 * carrying no cognitive state. The learner's own claims and their understanding of anything are *not*
 * seeded, because those are the things this system exists to record rather than to assume. A seeded
 * `StateEvent` would be the system telling someone what they understand.
 *
 * The set is small on purpose. It is enough to make retrieval meaningful — a paraphrase, a hard negative,
 * and a graph worth walking — without pretending to be a curriculum.
 */
export interface SeedTopic {
  readonly id: string
  readonly title: string
  readonly about: string
  readonly source: string
  readonly concepts: readonly { readonly id: string; readonly label: string }[]
  readonly questions: readonly { readonly id: string; readonly label: string }[]
  /**
   * Claims the learner was *given* rather than wrote. Seeded at `reference` tier, because the tier decides
   * whether a node counts as the learner's own understanding.
   */
  readonly claims: readonly { readonly id: string; readonly label: string }[]
  readonly edges: readonly { readonly from: string; readonly to: string; readonly type: string }[]
}

/**
 * Labels are Simplified Chinese with the English term in parentheses.
 *
 * The learner reads Chinese; the project's readers and the literature use the English terms. Carrying both
 * in one label serves both without a translation layer, and it keeps the *node* a single shared concept,
 * which is the point of the graph. A bilingual node is still one node.
 */
export const TRANSFORMERS: SeedTopic = {
  id: 'topic:transformer',
  title: 'Transformer 如何处理顺序',
  about:
    'Transformer 架构中与序列顺序有关的部分：为什么仅靠注意力无法表达顺序，以及为此加入了什么。',
  source: 'paper:arxiv:1706.03762',

  concepts: [
    { id: 'c_transformer', label: 'Transformer' },
    { id: 'c_self_attention', label: '自注意力（Self-Attention）' },
    { id: 'c_positional_encoding', label: '位置编码（Positional Encoding）' },
    { id: 'c_permutation_invariance', label: '置换不变性（Permutation Invariance）' },
    { id: 'c_rope', label: 'RoPE（旋转位置编码）' },
    { id: 'c_attention_head', label: '注意力头（Attention Head）' },
  ],

  questions: [
    { id: 'q_why_order', label: '为什么 Transformer 必须被告知序列顺序？' },
    { id: 'q_how_position', label: '位置信息是怎么给到模型的？' },
    { id: 'q_heads', label: '应该用多少个注意力头？' },
  ],

  // The transformer topic ships no claims: claims are where a learner's own thinking goes, and the whole
  // point of the surface is that they write those.
  claims: [],

  edges: [
    // Claims are not seeded — the learner writes those. These link the concepts and questions so the
    // graph signal has a topology to walk, which is what lets a question about RoPE reach the idea of
    // order at all.
    { from: 'q_why_order', to: 'c_permutation_invariance', type: EDGE.refersTo },
    { from: 'q_why_order', to: 'c_self_attention', type: EDGE.refersTo },
    { from: 'q_how_position', to: 'c_positional_encoding', type: EDGE.refersTo },
    { from: 'q_how_position', to: 'c_rope', type: EDGE.refersTo },
    { from: 'c_rope', to: 'c_positional_encoding', type: EDGE.refersTo },
    { from: 'c_positional_encoding', to: 'c_self_attention', type: EDGE.refersTo },
    { from: 'c_permutation_invariance', to: 'c_self_attention', type: EDGE.refersTo },
    { from: 'c_self_attention', to: 'c_transformer', type: EDGE.refersTo },
    { from: 'c_attention_head', to: 'c_self_attention', type: EDGE.refersTo },
    { from: 'q_heads', to: 'c_attention_head', type: EDGE.refersTo },
  ],
}

/**
 * Adds the topic to a session if it is not already there.
 *
 * Returns whether it seeded anything, so a caller can say what happened instead of silently mutating a
 * learner's graph on every start. Idempotence matters here: opening the surface twice must not double the
 * graph.
 */
export async function seedTopic(
  session: LearnSession,
  topic: SeedTopic = TRANSFORMERS,
): Promise<{ readonly seeded: boolean; readonly nodeCount: number; readonly edgeCount: number }> {
  const existing = new Set(session.listNodes().map((node) => node.nodeId))
  // Every kind counts for the "already seeded" check, not just concepts: a topic file may contain only
  // questions or claims, and checking concepts alone would re-seed it on every start.
  const alreadyThere = [...topic.concepts, ...topic.questions, ...topic.claims].some((node) =>
    existing.has(node.id),
  )
  if (alreadyThere) return { seeded: false, nodeCount: 0, edgeCount: 0 }

  let nodeCount = 0
  for (const concept of topic.concepts) {
    session.addNodeSync({
      id: concept.id,
      label: concept.label,
      type: NODE.concept,
      tier: 'reference',
      topic: topic.id,
      source: topic.source,
    })
    nodeCount += 1
  }
  for (const question of topic.questions) {
    session.addNodeSync({
      id: question.id,
      label: question.label,
      type: NODE.question,
      tier: 'reference',
      topic: topic.id,
      source: topic.source,
    })
    nodeCount += 1
  }
  // A claim from a topic file is material the learner was *given*, so it stays `reference`. The tier decides
  // whether a node counts as the learner's own understanding, and seeding an authored claim as `thought`
  // would put words in their mouth before they had said anything.
  for (const claim of topic.claims) {
    session.addNodeSync({
      id: claim.id,
      label: claim.label,
      type: NODE.claim,
      tier: 'reference',
      topic: topic.id,
      source: topic.source,
    })
    nodeCount += 1
  }

  let edgeCount = 0
  for (const edge of topic.edges) {
    session.linkSync(
      edge.from,
      edge.to,
      edge.type as Parameters<LearnSession['linkSync']>[2],
      `seed_${edge.from}_${edge.to}`,
    )
    edgeCount += 1
  }

  await session.flush()
  return { seeded: true, nodeCount, edgeCount }
}
