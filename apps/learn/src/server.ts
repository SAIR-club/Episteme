import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { RECORDABLE_DIMENSIONS, LearnSession } from '@episteme/application'
import { seedTopic, TRANSFORMERS, type SeedTopic } from './seed.js'

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
  readonly port: number
  close(): Promise<void>
}

const DEFAULT_PATH = join(homedir(), '.episteme', 'learn.jsonl')

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
  // Seeded before the socket opens, so the first request cannot race it and see an empty graph.
  const seed = await seedTopic(session, options.topic)
  const topic = options.topic ?? TRANSFORMERS

  const server: Server = createServer((request, response) => {
    handle(request, response, session, topic, seed.seeded).catch((error: unknown) => {
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
  const boundPort = typeof address === 'object' && address !== null ? address.port : port

  return {
    url: `http://${host}:${boundPort}`,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      }),
  }
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  session: LearnSession,
  topic: SeedTopic,
  seeded: boolean,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const path = url.pathname

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
      events: session.eventCount,
      retriever: session.retrieverName,
      rules: session.rules,
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
