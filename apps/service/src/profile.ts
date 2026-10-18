import { learnScene, type SceneView, type SessionScene } from '@episteme/application'
import type { SceneTool } from '@episteme/mcp'

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
  /** The packs, distillation policy and recordable dimensions the session is opened with (ADR 0013). */
  readonly scene: SessionScene
  /** Tools the scene adds to the MCP surface, beside `recall`, `propose`, `distill` and `reflect`. */
  readonly mcpTools?: readonly SceneTool[]
  /** Routes the scene adds to the REST API, served under `/api/v1/scene/<name>`. */
  readonly routes?: readonly SceneRoute[]
}

/** What a scene's route receives: a view of the session that cannot decide or write, and the request. */
export interface SceneRouteContext {
  readonly view: SceneView
  /** The JSON body of a `POST`, or an empty object. */
  readonly body: Readonly<Record<string, unknown>>
  readonly query: URLSearchParams
}

/**
 * A REST route a scene adds (ADR 0013, scene extensions).
 *
 * Served behind the same boundary as every other route, under `/api/v1/scene/<profile name><path>`. It sees the
 * session only through `SceneView`: deciding and recording stay on the API's own routes, the one human-decision
 * path. A refusal it throws (`isRefusal`) is answered with 422, like every other refusal.
 */
export interface SceneRoute {
  readonly method: 'GET' | 'POST'
  /** Starts with `/`, for example `/projects`. */
  readonly path: string
  readonly handle: (
    context: SceneRouteContext,
  ) => Readonly<Record<string, unknown>> | Promise<Readonly<Record<string, unknown>>>
}

/** Throws unless every route has a path that starts with `/` and no two share a method and path. */
export function assertSceneRoutes(routes: readonly SceneRoute[]): void {
  const seen = new Set<string>()
  for (const route of routes) {
    if (!route.path.startsWith('/')) {
      throw new Error(`scene route "${route.path}" must start with "/"`)
    }
    const key = `${route.method} ${route.path}`
    if (seen.has(key)) throw new Error(`scene route ${key} is declared twice`)
    seen.add(key)
  }
}

/**
 * A profile on the built-in Learn scene with a blank starting topic, for the development CLI.
 *
 * @deprecated Its scene is the deprecated built-in Learn scene. A scene's own launcher supplies its profile.
 */
export function defaultProfile(seed: SeedTopic = BLANK_TOPIC): SceneProfile {
  return { name: 'default', seed, scene: learnScene }
}

/**
 * The Learn scene, starting from `topic`, or from the transformer demonstration topic.
 *
 * @deprecated MindLink supplies the Learn profile (ADR 0013); this one is removed in step M6.
 */
export function learnProfile(topic: SeedTopic = TRANSFORMERS): SceneProfile {
  return { name: 'learn', seed: topic, scene: learnScene }
}
