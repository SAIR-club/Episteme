import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { RECORDABLE_DIMENSIONS, LearnSession, type Decision } from '@episteme/application'
import { createMcpEndpoint, type McpEndpoint } from '@episteme/mcp'
import { seedTopic, TRANSFORMERS, type SeedTopic } from '@episteme/application/seed'

/**
 * A local HTTP surface for the Learn session.
 *
 * Deliberately `node:http` and one HTML file, with no framework and no build step. The project's persistent
 * claim is that it runs with no database, no model and no frontend toolchain; adding a bundler to show that
 * would undercut the demonstration. It also keeps the whole UI readable in one sitting, which matters while
 * the interaction model is still being worked out.
 *
 * Binds to the loopback address only. This is a single-user local surface with no authentication by design,
 * and a policy layer does not exist yet; exposing it on a network interface would be a security decision
 * nobody has made.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX = join(HERE, '..', 'public', 'index.html')

export interface ServerOptions {
  readonly port?: number
  readonly host?: string
  /** Where the graph lives. Defaults to a file in the user's home directory. */
  readonly filePath?: string
  /**
   * The topic to start from. Defaults to the transformer demonstration topic.
   *
   * Injected rather than read here, so this file needs to know nothing about where a topic came from.
   */
  readonly topic?: SeedTopic
}

export interface LearnServer {
  readonly url: string
  /** Where an agent connects over MCP (Streamable HTTP). */
  readonly mcpUrl: string
  readonly port: number
  close(): Promise<void>
}

const DEFAULT_PATH = join(homedir(), '.episteme', 'learn.jsonl')
const MCP_PATH = '/mcp'

/** A JSON response, with no-store so a reload never shows a stale answer. */
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

function sendText(response: ServerResponse, status: number, text: string, type: string): void {
  response.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    'cache-control': 'no-store',
  })
  response.end(text)
}

/** Reads a JSON body, bounded so a malformed or hostile request cannot exhaust memory. */
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > 1_000_000) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/**
 * Reads a decision from the page's request body.
 *
 * Only the shape is checked here. Whether a modified value could ever be committed is the application's
 * question, answered the same way for every channel.
 */
function decisionFrom(body: Record<string, unknown>): Decision {
  const action = body['action']
  if (action === 'accept' || action === 'dismiss') return { action }
  if (action !== 'modify') {
    throw new TypeError('"action" must be one of accept, modify, dismiss')
  }
  const proposal = body['proposal']
  if (typeof proposal !== 'object' || proposal === null || Array.isArray(proposal)) {
    throw new TypeError('"proposal" must be an object when the action is modify')
  }
  const fields = proposal as Record<string, unknown>
  const text = (name: string): string => asString(fields[name], `proposal.${name}`)
  switch (fields['kind']) {
    case 'node': {
      const properties = fields['properties']
      if (
        properties !== undefined &&
        (typeof properties !== 'object' || properties === null || Array.isArray(properties))
      ) {
        throw new TypeError('"proposal.properties" must be an object')
      }
      return {
        action,
        proposal: {
          kind: 'node',
          nodeType: text('nodeType'),
          label: text('label'),
          ...(properties === undefined
            ? {}
            : { properties: properties as Record<string, unknown> }),
        },
      }
    }
    case 'claim': {
      const about = fields['about']
      if (
        about !== undefined &&
        !(Array.isArray(about) && about.every((id) => typeof id === 'string'))
      ) {
        throw new TypeError('"proposal.about" must be a list of node ids')
      }
      return {
        action,
        proposal: {
          kind: 'claim',
          label: text('label'),
          ...(about === undefined ? {} : { about }),
        },
      }
    }
    case 'link':
      return {
        action,
        proposal: { kind: 'link', from: text('from'), to: text('to'), relation: text('relation') },
      }
    case 'state':
      return {
        action,
        proposal: {
          kind: 'state',
          target: text('target'),
          dimension: text('dimension'),
          level: text('level'),
        },
      }
    default:
      throw new TypeError('"proposal.kind" must be one of node, claim, link, state')
  }
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`"${field}" must be a non-empty string`)
  }
  return value
}

/**
 * Starts the surface.
 *
 * The session is built and seeded *before* the socket opens, so the first request cannot race the seeding
 * and see an empty graph.
 */
export async function startLearnServer(options: ServerOptions = {}): Promise<LearnServer> {
  const filePath = options.filePath ?? process.env.EPISTEME_FILE ?? DEFAULT_PATH
  const session = await LearnSession.open({ filePath })
  // From here the session owns the graph file. Every path out of this function either hands that ownership
  // to the returned server or releases it, so a failed start cannot leave the graph locked.
  try {
    return await serve(session, options)
  } catch (error) {
    await session.close()
    throw error
  }
}

async function serve(session: LearnSession, options: ServerOptions): Promise<LearnServer> {
  // Seeded before the socket opens, so the first request cannot race it and see an empty graph.
  const seed = await seedTopic(session, options.topic)
  const topic = options.topic ?? TRANSFORMERS
  // The same session, so an agent reads and proposes against exactly the graph this surface shows.
  const mcp = createMcpEndpoint(session)

  // Known once the socket is bound. No request can arrive before then.
  let boundPort = 0

  const server: Server = createServer((request, response) => {
    // One boundary for the whole surface: the page, its API and the MCP endpoint alike.
    const refusal = boundaryRefusal(request, boundPort)
    if (refusal !== undefined) {
      sendJson(response, refusal.status, { error: refusal.error })
      return
    }
    handle(request, response, session, mcp, topic, seed.seeded).catch((error: unknown) => {
      // Every handler that can fail is awaited inside `handle`, so a rejection here is a bug in this file
      // rather than bad input. Reported as 500 with the message, never swallowed: a surface that fails
      // quietly is worse than one that fails visibly.
      const message = error instanceof Error ? error.message : String(error)
      if (!response.headersSent) sendJson(response, 500, { error: message })
      else response.end()
    })
  })

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

  return {
    url: `http://${host}:${boundPort}`,
    mcpUrl: `http://${host}:${boundPort}${MCP_PATH}`,
    port: boundPort,
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

/** The host names this surface answers to. It binds to the loopback address and to nothing else. */
const LOCAL_HOSTNAMES: readonly string[] = ['127.0.0.1', 'localhost', '[::1]']

/**
 * Why a request must not reach this surface, or `undefined` when it may.
 *
 * The surface has no authentication, so what keeps another web page from using it is that the page is not
 * this one. Without these checks, a site the learner visits could write their understanding with a
 * cross-site POST, accept a pending suggestion in their name, or, by rebinding its own host name to
 * 127.0.0.1, read everything the learner has recorded.
 *
 * - **Host** must be a loopback name with this server's port. A rebound host name arrives with the
 *   attacker's name in it.
 * - **Origin**, when a browser sends one, must be this server's own origin. A client that is not a browser,
 *   such as an MCP host, sends none.
 * - **Sec-Fetch-Site**, when present, must be `same-origin` or `none`. It covers cross-site reads a browser
 *   sends without an Origin, such as an image or a script tag pointed at the API.
 * - **Content-Type** must be JSON on anything that is not a read. A cross-site page can only send a
 *   form or text body without asking first, and the browser's preflight for JSON is never answered.
 *
 * This is a network boundary, not authorization: any local process can still connect (ADR 0008).
 */
export function boundaryRefusal(
  request: IncomingMessage,
  port: number,
): { readonly status: number; readonly error: string } | undefined {
  const allowedHosts = LOCAL_HOSTNAMES.map((name) => `${name}:${port}`)
  const host = request.headers.host?.toLowerCase()
  if (host === undefined || !allowedHosts.includes(host)) {
    return { status: 403, error: `host "${host ?? ''}" is not this local surface` }
  }

  const origin = request.headers.origin
  if (
    origin !== undefined &&
    !allowedHosts.map((name) => `http://${name}`).includes(origin.toLowerCase())
  ) {
    return { status: 403, error: `requests from "${origin}" are not accepted` }
  }

  const site = request.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    return { status: 403, error: `${site} requests are not accepted` }
  }

  const method = request.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') {
    const type = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
    if (type !== 'application/json') {
      return {
        status: 415,
        error: 'a request that changes anything must be sent as application/json',
      }
    }
  }
  return undefined
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  session: LearnSession,
  mcp: McpEndpoint,
  topic: SeedTopic,
  seeded: boolean,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const path = url.pathname

  // The agent surface (ADR 0008). It validates Host and Origin itself, before anything else reads the request.
  if (path === MCP_PATH) {
    await mcp.handle(request, response)
    return
  }

  if (path === '/' || path === '/index.html') {
    try {
      const html = await readFile(INDEX, 'utf8')
      sendText(response, 200, html, 'text/html')
    } catch {
      sendText(
        response,
        500,
        'The interface file is missing. Run `pnpm build` from the repository root.',
        'text/plain',
      )
    }
    return
  }

  // The whole surface state in one call, so the page renders from a single read rather than one per node.
  if (path === '/api/state' && request.method === 'GET') {
    const nodes = session.listNodes()
    // Understanding is attached here rather than fetched per node: a page that needed N requests to draw
    // N rows would make the record panel flash empty on every reload.
    const understanding: Record<string, readonly { id: string; level: string }[]> = {}
    for (const node of nodes) understanding[node.nodeId] = session.understandingOf(node.nodeId)

    sendJson(response, 200, {
      topic: { title: topic.title, about: topic.about, seeded },
      dimensions: RECORDABLE_DIMENSIONS,
      nodes,
      understanding,
      openEnds: session.openEnds(),
      // Sent with the state rather than behind its own route: it is derived from the same reads, so two
      // requests could disagree, and a panel that disagrees with the graph beside it is worse than no panel.
      progress: session.progress(),
      // What agents proposed and the learner has not decided. Nothing here is the learner's state yet.
      suggestions: session.pendingSuggestions(),
      events: session.eventCount,
      retriever: session.retrieverName,
      rules: session.rules,
    })
    return
  }

  // The review queue on its own, so the page can notice an agent's proposal while the learner is working
  // without re-reading the whole surface.
  if (path === '/api/suggestions' && request.method === 'GET') {
    sendJson(response, 200, { suggestions: session.pendingSuggestions() })
    return
  }

  // The learner's decision on one suggestion. This surface only collects it; what accept, modify and dismiss
  // mean lives in the application layer, shared with every other channel (ADR 0008).
  if (path === '/api/suggestions/decide' && request.method === 'POST') {
    const body = await readJson(request)
    const id = asString(body['id'], 'id')
    const result = await session.decide(id, decisionFrom(body), 'learn-review')
    if (!result.ok) {
      sendJson(response, 422, { error: result.refusal.message, code: result.refusal.code })
      return
    }
    sendJson(response, 200, {
      result,
      suggestions: session.pendingSuggestions(),
      events: session.eventCount,
    })
    return
  }

  // Learning material in, pending suggestions out (ADR 0009). Nothing here changes the learner's understanding:
  // what is found joins the review queue, and the learner decides on each.
  if (path === '/api/distill' && request.method === 'POST') {
    const body = await readJson(request)
    const text = asString(body['text'], 'text')
    const title = typeof body['title'] === 'string' ? body['title'] : undefined
    const outcome = await session.distill(title === undefined ? { text } : { title, text })
    if (!outcome.ok) {
      sendJson(response, 422, { error: outcome.refusal.message, code: outcome.refusal.code })
      return
    }
    sendJson(response, 200, {
      sourceId: outcome.sourceId,
      episodes: outcome.episodes,
      suggestions: outcome.suggestions.length,
      refused: outcome.refused,
    })
    return
  }

  if (path === '/api/ask' && request.method === 'POST') {
    const body = await readJson(request)
    const question = asString(body['question'], 'question')
    sendJson(response, 200, await session.ask(question))
    return
  }

  if (path === '/api/record' && request.method === 'POST') {
    const body = await readJson(request)
    const target = asString(body['target'], 'target')
    const dimensions = body['dimensions']
    if (typeof dimensions !== 'object' || dimensions === null || Array.isArray(dimensions)) {
      throw new TypeError('"dimensions" must be an object of dimension → level')
    }

    const entries = Object.entries(dimensions as Record<string, unknown>)
    const clean: Record<string, string> = {}
    for (const [dimension, level] of entries) {
      clean[dimension] = asString(level, `dimensions.${dimension}`)
    }

    const recorded = await session.record(target, clean, {
      reason:
        typeof body['reason'] === 'string' ? body['reason'] : 'recorded from the learn surface',
    })

    sendJson(response, 200, {
      ...recorded,
      // Echoed so the page does not have to guess what the recorded state now is.
      understanding: session.understandingOf(target),
      events: session.eventCount,
    })
    return
  }

  if (path === '/api/claim' && request.method === 'POST') {
    const body = await readJson(request)
    const label = asString(body['label'], 'label')
    const kind = body['kind'] === 'concept' ? 'concept' : 'claim'
    const node = await session.addNode({ label, kind })
    sendJson(response, 200, { node, nodes: session.listNodes(), events: session.eventCount })
    return
  }

  sendJson(response, 404, { error: `no route for ${request.method ?? 'GET'} ${path}` })
}
