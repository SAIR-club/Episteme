import type { SceneView, SessionScene } from '@episteme/application'
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
  /** The topic every seeded node is tagged with: `transformer` tags it `topic:transformer`. */
  readonly id?: string
  /** Where the material comes from, such as `paper:arxiv:1706.03762`, recorded on every seeded node. */
  readonly source?: string
  readonly nodes: readonly SeedNode[]
  readonly edges?: readonly {
    readonly from: string
    readonly to: string
    readonly relation?: string
  }[]
}

export const BLANK_TOPIC: SeedTopic = Object.freeze({ title: 'blank', nodes: [] })

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
