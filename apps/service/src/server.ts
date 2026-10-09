import { createServer, type Server } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LearnSession } from '@episteme/application'
import { createMcpEndpoint } from '@episteme/mcp'
import { API_PREFIX, handleApi, sendJson } from './api.js'
import { boundaryRefusal } from './boundary.js'
import { learnProfile, type SceneProfile, type SeedTopic } from './profile.js'
import { noWorkspaceNotice, serveWorkspace } from './workspace.js'

export interface ServiceOptions {
  /** The graph this service owns. Defaults to `EPISTEME_FILE`, then a file in the user's home directory. */
  readonly graph?: string
  readonly port?: number
  readonly host?: string
  /** The scene the service is composed with. Defaults to Learn. */
  readonly profile?: SceneProfile
  /** A directory holding a prebuilt Workspace to serve at `/`. Without one, `/` says how to connect. */
  readonly workspace?: string
}

export interface EpistemeService {
  /** The service's origin. */
  readonly url: string
  /** Where an agent connects over MCP (Streamable HTTP). */
  readonly mcpUrl: string
  /** Where a human-facing client reaches the REST API. */
  readonly apiUrl: string
  /** Where the served Workspace opens, when there is one. */
  readonly workspaceUrl: string | undefined
  readonly port: number
  /** Where the graph it owns lives. */
  readonly graph: string
  close(): Promise<void>
}

export const DEFAULT_GRAPH = join(homedir(), '.episteme', 'learn.jsonl')
const MCP_PATH = '/mcp'

/**
 * Starts the Episteme service: the single owner of one graph, serving MCP to agents and REST to
 * human-facing clients behind one boundary (ADR 0010).
 *
 * The session is opened and seeded *before* the socket opens, so the first request cannot race the seeding
 * and see an empty graph.
 */
export async function startService(options: ServiceOptions = {}): Promise<EpistemeService> {
  const graph = options.graph ?? process.env.EPISTEME_FILE ?? DEFAULT_GRAPH
  const session = await LearnSession.open({ filePath: graph })
  // From here the session owns the graph. Every path out of this function either hands that ownership to the
  // returned service or releases it, so a failed start cannot leave the graph locked.
  try {
    return await serve(session, graph, options)
  } catch (error) {
    await session.close()
    throw error
  }
}

async function seedTopicIfPresent(
  session: LearnSession,
  topic?: SeedTopic,
): Promise<{ seeded: boolean }> {
  if (topic === undefined || topic.nodes.length === 0) return { seeded: false }
  const existing = new Set(session.listNodes().map((node) => node.nodeId))
  const alreadyThere = topic.nodes.some((n) => n.id !== undefined && existing.has(n.id))
  if (alreadyThere) return { seeded: false }

  let count = 0
  for (const n of topic.nodes) {
    await session.addNode({
      id: n.id ?? `node_${n.label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
      label: n.label,
      kind: n.kind ?? 'concept',
    })
    count += 1
  }
  if (topic.edges !== undefined) {
    for (const edge of topic.edges) {
      await session.link(
        edge.from,
        edge.to,
        edge.relation as Parameters<typeof session.link>[2],
        `seed_${edge.from}_${edge.to}`,
      )
    }
  }
  return { seeded: count > 0 }
}

async function serve(
  session: LearnSession,
  graph: string,
  options: ServiceOptions,
): Promise<EpistemeService> {
  const profile = options.profile ?? learnProfile()
  const { seeded } = await seedTopicIfPresent(session, profile.seed)
  // The same session behind both protocols, so an agent reads and proposes against exactly the graph a
  // Workspace shows.
  const mcp = createMcpEndpoint(session)
  const workspace = options.workspace

  // Known once the socket is bound. No request can arrive before then.
  let boundPort = 0
  let origin = ''

  const server: Server = createServer((request, response) => {
    // One boundary for everything served: the Workspace, the API and the MCP endpoint alike.
    const refusal = boundaryRefusal(request, boundPort)
    if (refusal !== undefined) {
      sendJson(response, refusal.status, { error: refusal.error, code: 'outside_boundary' })
      return
    }
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    const handled =
      path === MCP_PATH
        ? mcp.handle(request, response)
        : path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)
          ? handleApi(request, response, path, { session, profile, seeded })
          : workspace !== undefined
            ? request.method === 'GET' || request.method === 'HEAD'
              ? serveWorkspace(workspace, path, response)
              : Promise.resolve(sendJson(response, 405, { error: 'read only', code: 'no_route' }))
            : Promise.resolve(notice(response, path))
    handled.catch((error: unknown) => {
      // Bad input is answered inside each handler, so a rejection here is a bug rather than a refusal.
      // Reported as 500 with the message, never swallowed: a service that fails quietly is worse than one
      // that fails visibly.
      const message = error instanceof Error ? error.message : String(error)
      if (!response.headersSent) sendJson(response, 500, { error: message, code: 'internal' })
      else response.end()
    })
  })

  function notice(response: Parameters<typeof sendJson>[0], path: string): void {
    if (path !== '/') {
      sendJson(response, 404, { error: `nothing is served at ${path}`, code: 'no_route' })
      return
    }
    response.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(noWorkspaceNotice(`${origin}${API_PREFIX}`, `${origin}${MCP_PATH}`))
  }

  const port = options.port ?? 4321
  const host = options.host ?? '127.0.0.1'
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const address = server.address()
  boundPort = typeof address === 'object' && address !== null ? address.port : port
  origin = `http://${host}:${boundPort}`

  return {
    url: origin,
    mcpUrl: `${origin}${MCP_PATH}`,
    apiUrl: `${origin}${API_PREFIX}`,
    workspaceUrl: workspace === undefined ? undefined : `${origin}/`,
    port: boundPort,
    graph,
    // In-flight agent exchanges first, since an open stream would hold the socket open; then the socket, so no
    // request arrives at a session that is closing; then the session, which writes what is pending and gives
    // up the graph.
    close: async () => {
      await mcp.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      })
      await session.close()
    },
  }
}
