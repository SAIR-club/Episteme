/**
 * What the service is composed with for one scene (ADR 0010, decision 8).
 */

export interface SeedNode {
  readonly id?: string
  readonly label: string
  readonly kind?: 'concept' | 'question' | 'claim'
  readonly properties?: Readonly<Record<string, unknown>>
}

export interface SeedTopic {
  readonly title: string
  readonly about?: string
  readonly nodes: readonly SeedNode[]
  readonly edges?: readonly {
    readonly from: string
    readonly to: string
    readonly relation?: string
  }[]
}

export const BLANK_TOPIC: SeedTopic = Object.freeze({ title: 'blank', nodes: [] })

export const TRANSFORMERS: SeedTopic = Object.freeze({
  title: 'Transformer 如何处理顺序',
  about:
    'Transformer 架构中与序列顺序有关的部分：为什么仅靠注意力无法表达顺序，以及为此加入了什么。',
  nodes: [
    { id: 'c_transformer', label: 'Transformer', kind: 'concept' as const },
    { id: 'c_self_attention', label: '自注意力（Self-Attention）', kind: 'concept' as const },
    {
      id: 'c_positional_encoding',
      label: '位置编码（Positional Encoding）',
      kind: 'concept' as const,
    },
    {
      id: 'c_permutation_invariance',
      label: '置换不变性（Permutation Invariance）',
      kind: 'concept' as const,
    },
    { id: 'c_rope', label: 'RoPE（旋转位置编码）', kind: 'concept' as const },
    { id: 'c_attention_head', label: '注意力头（Attention Head）', kind: 'concept' as const },
    {
      id: 'q_why_order',
      label: '为什么 Transformer 必须被告知序列顺序？',
      kind: 'question' as const,
    },
    { id: 'q_how_position', label: '位置信息是怎么给到模型的？', kind: 'question' as const },
    { id: 'q_heads', label: '应该用多少个注意力头？', kind: 'question' as const },
  ],
  edges: [
    { from: 'q_why_order', to: 'c_permutation_invariance', relation: 'refers_to' },
    { from: 'q_why_order', to: 'c_self_attention', relation: 'refers_to' },
    { from: 'q_how_position', to: 'c_positional_encoding', relation: 'refers_to' },
    { from: 'q_how_position', to: 'c_rope', relation: 'refers_to' },
    { from: 'c_rope', to: 'c_positional_encoding', relation: 'refers_to' },
    { from: 'c_positional_encoding', to: 'c_self_attention', relation: 'refers_to' },
    { from: 'c_permutation_invariance', to: 'c_self_attention', relation: 'refers_to' },
    { from: 'c_self_attention', to: 'c_transformer', relation: 'refers_to' },
    { from: 'c_attention_head', to: 'c_self_attention', relation: 'refers_to' },
    { from: 'q_heads', to: 'c_attention_head', relation: 'refers_to' },
  ],
})

export interface SceneProfile {
  readonly name: string
  /** Seeded on first start, before the service accepts a request. Seeding is idempotent. */
  readonly seed: SeedTopic
}

/** Default scene profile with blank starting topic. */
export function defaultProfile(seed: SeedTopic = BLANK_TOPIC): SceneProfile {
  return { name: 'default', seed }
}

/** The Learn scene, starting from `topic`, or from the transformer demonstration topic. */
export function learnProfile(topic: SeedTopic = TRANSFORMERS): SceneProfile {
  return { name: 'learn', seed: topic }
}
