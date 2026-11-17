import {
  startService,
  type EpistemeService,
  type SceneProfile,
  type SeedTopic,
  type ServiceOptions,
} from '@episteme/service'
import { testScene } from './test-scene.js'

/** The demonstration topic the service used to seed by default, now kept with the test scene. */
export const TEST_TOPIC = Object.freeze({
  title: 'Transformer 如何处理顺序',
  id: 'transformer',
  source: 'paper:arxiv:1706.03762',
  about:
    'Transformer 架构中与序列顺序有关的部分：为什么仅靠注意力无法表达顺序，以及为此加入了什么。',
  nodes: [
    { id: 'c_transformer', label: 'Transformer', kind: 'concept' },
    { id: 'c_self_attention', label: '自注意力（Self-Attention）', kind: 'concept' },
    { id: 'c_positional_encoding', label: '位置编码（Positional Encoding）', kind: 'concept' },
    {
      id: 'c_permutation_invariance',
      label: '置换不变性（Permutation Invariance）',
      kind: 'concept',
    },
    { id: 'c_rope', label: 'RoPE（旋转位置编码）', kind: 'concept' },
    { id: 'c_attention_head', label: '注意力头（Attention Head）', kind: 'concept' },
    {
      id: 'q_why_order',
      label: '为什么 Transformer 必须被告知序列顺序？',
      kind: 'question',
    },
    { id: 'q_how_position', label: '位置信息是怎么给到模型的？', kind: 'question' },
    { id: 'q_heads', label: '应该用多少个注意力头？', kind: 'question' },
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
} satisfies SeedTopic)

export function testProfile(seed: SeedTopic = TEST_TOPIC): SceneProfile {
  return { name: 'test', seed, scene: testScene }
}

type TestServiceOptions = Omit<ServiceOptions, 'profile'> & { readonly profile?: SceneProfile }

/** Starts the service with the explicit test scene; every caller may still override the profile. */
export function startTestService(options: TestServiceOptions = {}): Promise<EpistemeService> {
  const { profile = testProfile(), ...rest } = options
  return startService({ profile, ...rest })
}
