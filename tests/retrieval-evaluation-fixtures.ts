import { asId, type EdgeId, type GraphNode, type NodeId } from '@episteme/core'
import { EDGE, NODE, learnTags } from './fixtures.js'
import type { EpistemeContext } from './fixtures.js'

/**
 * A small, deterministic retrieval evaluation set.
 *
 * The purpose is to make regressions visible, not to measure quality. Every expectation here is
 * hand-checked against the graph below, so a failure means a change altered what retrieval returns —
 * which is the thing worth knowing before a weight or a signal is touched.
 *
 * It is deliberately tiny. A large benchmark would invite tuning against it, and the project's risk is
 * not retrieval quality: it is that semantic similarity quietly becomes the only signal that matters.
 * These cases are chosen to catch *that*.
 */
export interface RetrievalCase {
  readonly name: string
  readonly query: string
  /** Node ids that must appear in the result. */
  readonly expected: readonly NodeId[]
  /** Node ids that must rank *below* every expected node. */
  readonly hardNegatives: readonly NodeId[]
  /** Why this case exists, so a reader knows what a failure means. */
  readonly rationale: string
}

const CLAIM = {
  order: asId<NodeId>('claim_order'),
  orderless: asId<NodeId>('claim_orderless'),
  heads: asId<NodeId>('claim_heads'),
  learningRate: asId<NodeId>('claim_lr'),
  tokenizer: asId<NodeId>('claim_tokenizer'),
  ropeRelative: asId<NodeId>('claim_rope_relative'),
  ropeAbsolute: asId<NodeId>('claim_rope_absolute'),
  peSinusoidal: asId<NodeId>('claim_pe_sinusoidal'),
  peIndex: asId<NodeId>('claim_pe_index'),
} as const

export const EVALUATION_CLAIM_IDS = CLAIM

/**
 * The graph every case is evaluated against.
 *
 * Two deliberate properties:
 *
 * 1. **Every claim is tagged `topic:transformer`.** A shared topic makes the graph and lexical signals
 *    useless as discriminators, so a case can only be passed by the signal it is meant to test.
 * 2. **The hard negatives share an incidental word with their query.** `claim_heads` and `claim_order`
 *    both concern attention; only one concerns order. That is exactly the discrimination the phase has
 *    to demonstrate, and it is why "does it contain the word" is not the question being asked.
 */
export function seedEvaluationGraph(context: EpistemeContext): void {
  const concept = (id: string, label: string, topic: string) =>
    context.graph.addNode({
      id: asId<NodeId>(id),
      type: NODE.concept,
      label,
      properties: { text: label },
      tags: learnTags(topic),
      tier: 'reference',
      source: 'paper:arxiv:1706.03762',
    })

  concept('c_transformer', 'Transformer', 'transformer')
  concept('c_self_attention', 'Self-Attention', 'transformer')
  concept('c_positional_encoding', 'Positional Encoding', 'transformer')
  concept('c_permutation', 'Permutation Invariance', 'transformer')
  concept('c_rope', 'RoPE', 'transformer')

  const claim = (id: NodeId, label: string): GraphNode =>
    context.graph.addNode({
      id,
      type: NODE.claim,
      label,
      properties: { text: label },
      tags: learnTags('transformer'),
      tier: 'thought',
      source: 'session:1',
    })

  claim(CLAIM.order, 'Self-attention does not encode sequence order.')
  claim(CLAIM.orderless, 'Self-attention treats its input as an unordered set.')
  claim(CLAIM.heads, 'How many attention heads should I use?')
  claim(CLAIM.learningRate, 'What learning rate schedule works best for fine-tuning?')
  claim(CLAIM.tokenizer, 'Which tokenizer should I pick for Chinese text?')
  claim(CLAIM.ropeRelative, 'RoPE injects relative position by rotating queries and keys.')
  claim(CLAIM.ropeAbsolute, 'RoPE removes the need for absolute position embeddings.')
  claim(CLAIM.peSinusoidal, 'Sinusoidal positional encoding uses fixed frequencies.')
  claim(CLAIM.peIndex, 'Positional encoding gives every token an index.')

  const refers = (id: string, from: NodeId, to: string): void => {
    context.graph.addEdge({
      id: asId<EdgeId>(id),
      type: EDGE.refersTo,
      from,
      to: asId<NodeId>(to),
    })
  }

  refers('e_order_attention', CLAIM.order, 'c_self_attention')
  refers('e_orderless_permutation', CLAIM.orderless, 'c_permutation')
  refers('e_heads_attention', CLAIM.heads, 'c_self_attention')
  refers('e_rope_relative_rope', CLAIM.ropeRelative, 'c_rope')
  refers('e_rope_absolute_positional', CLAIM.ropeAbsolute, 'c_positional_encoding')
  refers('e_pe_sinusoidal_positional', CLAIM.peSinusoidal, 'c_positional_encoding')
  refers('e_pe_index_positional', CLAIM.peIndex, 'c_positional_encoding')
}

/**
 * Every query avoids the words of its expected claim.
 *
 * That is the point of the fixture: a case that could be passed by string matching would not tell us
 * anything about semantic retrieval.
 */
export const RETRIEVAL_EVALUATION: readonly RetrievalCase[] = [
  {
    name: 'sequence order, asked without the words "sequence" or "order"',
    query: 'Which word comes first in the input?',
    expected: [CLAIM.order],
    hardNegatives: [CLAIM.heads, CLAIM.learningRate, CLAIM.tokenizer],
    rationale:
      'The words "sequence" and "order" do not appear in the question. Only a semantic signal reaches the claim, and the head-count claim must not win on the shared word "attention".',
  },
  {
    name: 'sequence order, asked as "unordered"',
    query: 'Does the model care about the arrangement of its input?',
    expected: [CLAIM.order, CLAIM.orderless],
    hardNegatives: [CLAIM.heads, CLAIM.tokenizer],
    rationale:
      'Both order claims should surface; the head-count and tokenizer claims share no vocabulary with the question beyond the topic.',
  },
  {
    name: 'positional encoding, asked about why it exists',
    query: 'Why does the model need to know where each word sits?',
    expected: [CLAIM.peIndex, CLAIM.peSinusoidal],
    hardNegatives: [CLAIM.heads, CLAIM.learningRate],
    rationale: 'The claim states the mechanism in words the question does not use.',
  },
  {
    name: 'RoPE, asked about relative placement',
    query: 'How does rotating the vectors encode where things are relative to each other?',
    expected: [CLAIM.ropeRelative],
    hardNegatives: [CLAIM.heads, CLAIM.learningRate, CLAIM.tokenizer],
    rationale:
      'The distinctive term "RoPE" is absent. The claim about absolute embeddings should rank below the relative one, since the question is about relativeness.',
  },
  {
    name: 'hard negative: the shared word must not decide',
    query: 'How many attention heads should I use?',
    expected: [CLAIM.heads],
    hardNegatives: [CLAIM.order, CLAIM.orderless],
    rationale:
      'The mirror of the first case. Both the query and the order claims contain "attention", so a retriever that ranks on that word alone fails here.',
  },
  {
    name: 'unrelated question retrieves nothing relevant',
    query: 'What is the capital of Portugal?',
    expected: [],
    hardNegatives: [CLAIM.order, CLAIM.heads, CLAIM.ropeRelative, CLAIM.peIndex],
    rationale:
      'A question with no connection to the graph must not drag in cognition. Suppression matters as much as recall.',
  },
]

export interface EvaluationOutcome {
  readonly case: RetrievalCase
  readonly ranked: readonly NodeId[]
  /** Expected nodes that were found. */
  readonly found: readonly NodeId[]
  /** Expected nodes that were missed. */
  readonly missed: readonly NodeId[]
  /** Hard negatives that ranked at or above an expected node. */
  readonly violations: readonly NodeId[]
  readonly passed: boolean
}

/**
 * Evaluates one case against a ranked result.
 *
 * A case passes when every expected node is present, and no hard negative outranks the *worst-placed*
 * expected node. Rank position among the expected nodes is not asserted, because that would be tuning
 * rather than correctness — the property that matters is that relevant cognition is above irrelevant
 * cognition.
 */
export function evaluateCase(
  testCase: RetrievalCase,
  ranked: readonly NodeId[],
): EvaluationOutcome {
  const position = new Map<NodeId, number>()
  ranked.forEach((id, index) => position.set(id, index))

  const found = testCase.expected.filter((id) => position.has(id))
  const missed = testCase.expected.filter((id) => !position.has(id))

  const worstExpected = found.reduce(
    (worst, id) => Math.max(worst, position.get(id) ?? Number.POSITIVE_INFINITY),
    -1,
  )
  const violations =
    worstExpected < 0
      ? []
      : testCase.hardNegatives.filter((id) => {
          const at = position.get(id)
          return at !== undefined && at < worstExpected
        })

  return {
    case: testCase,
    ranked,
    found,
    missed,
    violations,
    passed: missed.length === 0 && violations.length === 0,
  }
}
