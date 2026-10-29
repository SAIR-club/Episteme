import { createServer, type Server } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CognitiveSession } from '@episteme/application'
import { createMcpEndpoint } from '@episteme/mcp'
import { API_PREFIX, handleApi, operationOf, sendJson } from './api.js'
import { boundaryRefusal } from './boundary.js'
import {
  accessRefusal,
  BrowserSessions,
  credentialOf,
  Directory,
  type Caller,
  type DeploymentMode,
} from './identity.js'
import { assertSceneRoutes, learnProfile, type SceneProfile, type SeedTopic } from './profile.js'
import { noWorkspaceNotice, serveWorkspace } from './workspace.js'

export interface ServiceOptions {
  /** The graph this service owns. Defaults to `EPISTEME_FILE`, then a file in the user's home directory. */
  readonly graph?: string
  readonly port?: number
  readonly host?: string
  /** The scene the service is composed with. Defaults to the deprecated built-in Learn profile. */
  readonly profile?: SceneProfile
  /** A directory holding a prebuilt Workspace to serve at `/`. Without one, `/` says how to connect. */
  readonly workspace?: string
  /** `local` (the default) serves one person on loopback; `shared` serves the people in `users` (ADR 0012). */
  readonly mode?: DeploymentMode
  /** The user file. Required in shared mode. */
  readonly users?: string
  /** The origin people reach a shared deployment at, through its HTTPS proxy. Required in shared mode. */
  readonly publicOrigin?: string
  /** In shared mode, take an elicitation answer as the person's decision anyway (ADR 0012, decision 4). */
  readonly trustElicitation?: boolean
  /** Allow people to publish (ADR 0014). Off by default; the graph is copied aside before its first one. */
  readonly sharing?: boolean
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
  readonly mode: DeploymentMode
  /**
   * In local mode, the person's token for this run, for a client that is not the served Workspace. It decides
   * in the person's name, so it is printed for them and never logged.
   */
  readonly humanToken: string | undefined
  close(): Promise<void>
}

export const DEFAULT_GRAPH = join(homedir(), '.episteme', 'learn.db')
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
  const profile = options.profile ?? learnProfile()
  // Checked before the graph is opened, so a profile or deployment that cannot be served never takes the
  // graph's lock.
  assertSceneRoutes(profile.routes ?? [])
  const people = await peopleFor(options)
  const session = await CognitiveSession.open({
    filePath: graph,
    scene: profile.scene,
    sharing: options.sharing === true,
  })
  // From here the session owns the graph. Every path out of this function either hands that ownership to the
  // returned service or releases it, so a failed start cannot leave the graph locked.
  try {
    return await serve(session, graph, profile, options, people)
  } catch (error) {
    await session.close()
    throw error
  }
}

async function seedTopicIfPresent(
  session: CognitiveSession,
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
      // A topic is material the person is given: its questions and claims are not theirs until they say so.
      given: true,
      ...(topic.id === undefined ? {} : { topic: topic.id }),
      ...(topic.source === undefined ? {} : { source: topic.source }),
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

/** The user file of a shared deployment, or nothing in local mode. A shared deployment missing either setting stops here. */
async function peopleFor(options: ServiceOptions): Promise<Directory | undefined> {
  if ((options.mode ?? 'local') === 'local') return undefined
  if (options.users === undefined) {
    throw new Error('a shared service needs a user file (--users): who may use it')
  }
  if (options.publicOrigin === undefined) {
    throw new Error(
      'a shared service needs its public origin (--public-origin): where people reach it',
    )
  }
  return Directory.open(options.users)
}

async function serve(
  session: CognitiveSession,
  graph: string,
  profile: SceneProfile,
  options: ServiceOptions,
  people: Directory | undefined,
): Promise<EpistemeService> {
  const mode: DeploymentMode = people === undefined ? 'local' : 'shared'
  // Local mode is shared mode with one person, the session's own, whose token is minted for this run.
  const local = people === undefined ? Directory.single(session.actorId, 'you') : undefined
  const directory = people ?? local!.directory
  const localPerson = local === undefined ? undefined : directory.resolve(local.token)
  const browsers = new BrowserSessions()
  const { seeded } = await seedTopicIfPresent(session, profile.seed)
  // The same session behind both protocols, so an agent reads and proposes against exactly the graph a
  // Workspace shows.
  const publicHost =
    options.publicOrigin === undefined ? undefined : new URL(options.publicOrigin).hostname
  const mcp = createMcpEndpoint(session, {
    sceneTools: profile.mcpTools ?? [],
    elicitationDecisions: mode === 'local' || options.trustElicitation === true,
    ...(publicHost === undefined ? {} : { allowedHostnames: [publicHost] }),
    ...(options.publicOrigin === undefined ? {} : { allowedOrigins: [options.publicOrigin] }),
  })
  const workspace = options.workspace

  // Known once the socket is bound. No request can arrive before then.
  let boundPort = 0
  let origin = ''

  const server: Server = createServer((request, response) => {
    // One boundary for everything served: the Workspace, the API and the MCP endpoint alike.
    const refusal = boundaryRefusal(request, boundPort, options.publicOrigin)
    if (refusal !== undefined) {
      sendJson(response, refusal.status, { error: refusal.error, code: 'outside_boundary' })
      return
    }
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    const method = request.method ?? 'GET'

    // Who the request is for, from its credential and nothing else (ADR 0012). A Bearer token that does not
    // resolve is refused; a stale cookie, such as one from the previous run, counts as no credential.
    const credential = credentialOf(request.headers)
    let caller: Caller | undefined
    if (credential !== undefined && 'token' in credential) {
      caller = directory.resolve(credential.token)
      if (caller === undefined) {
        sendJson(response, 401, { error: 'this token is not valid', code: 'unauthenticated' })
        return
      }
    } else if (credential !== undefined) {
      caller = browsers.resolve(credential.session)
      // A session ends with the token that opened it: once that is revoked, the cookie counts as no credential.
      if (caller !== undefined && !directory.isLive(caller.credentialId)) caller = undefined
    }

    const handled =
      path === `${API_PREFIX}/session` && method === 'POST'
        ? signIn(request, response)
        : path === MCP_PATH
          ? authorized(response, caller, 'read', () => mcp.handle(request, response, caller))
          : path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)
            ? authorized(response, caller, operationOf(method, path), () =>
                handleApi(request, response, path, {
                  // Each person reads and writes through their own session over the one graph (ADR 0014).
                  session: caller === undefined ? session : session.forActor(caller.actorId),
                  profile,
                  seeded,
                  caller,
                  people,
                }),
              )
            : workspace !== undefined
              ? method === 'GET' || method === 'HEAD'
                ? serveWorkspace(workspace, path, response, pageHeaders())
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

  /** Runs `serve` only when the caller may perform `operation`; otherwise answers why not. */
  function authorized(
    response: Parameters<typeof sendJson>[0],
    caller: Caller | undefined,
    operation: ReturnType<typeof operationOf>,
    serve: () => Promise<void>,
  ): Promise<void> {
    const refused = accessRefusal(mode, caller, operation)
    if (refused === undefined) return serve()
    sendJson(response, refused.status, { error: refused.message, code: refused.code })
    return Promise.resolve()
  }

  /** In local mode, the served page carries the person's session, so they never handle a token themselves. */
  function pageHeaders(): Readonly<Record<string, string>> {
    return localPerson === undefined ? {} : { 'set-cookie': browsers.open(localPerson) }
  }

  /** Exchanges a person's own token for a session cookie (ADR 0012, decision 2). */
  async function signIn(
    request: Parameters<typeof mcp.handle>[0],
    response: Parameters<typeof sendJson>[0],
  ): Promise<void> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      size += (chunk as Buffer).length
      if (size > 10_000) {
        sendJson(response, 400, { error: 'request body too large', code: 'invalid_request' })
        return
      }
      chunks.push(chunk as Buffer)
    }
    let token: unknown
    try {
      token = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { token?: unknown } | null)
        ?.token
    } catch {
      sendJson(response, 400, {
        error: 'the body must be JSON: { "token": … }',
        code: 'invalid_request',
      })
      return
    }
    const person = typeof token === 'string' ? directory.resolve(token) : undefined
    if (person === undefined) {
      sendJson(response, 401, { error: 'this token is not valid', code: 'unauthenticated' })
      return
    }
    if (person.kind !== 'human') {
      sendJson(response, 403, {
        error: 'only the person’s own token opens a Workspace session',
        code: 'human_required',
      })
      return
    }
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': browsers.open(person),
    })
    response.end(JSON.stringify({ actorId: person.actorId, label: person.label }))
  }

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
    mode,
    humanToken: local?.token,
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
