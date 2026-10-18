import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import type { CognitiveSession } from '@episteme/application'
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
} from '@modelcontextprotocol/server'
import { createDecisionCodec } from './confirm.js'
import {
  assertSceneToolNames,
  createEpistemeMcpServer,
  type McpCaller,
  type SceneTool,
} from './server.js'

/**
 * The MCP endpoint of an Episteme host, over Streamable HTTP.
 *
 * Served by the same process that owns the graph and serves the Learn surface (ADR 0008), so it reads and
 * proposes through the one session that holds the graph's lock rather than opening the file itself.
 *
 * Host and Origin are validated before anything reaches the SDK, which is deliberately validation-free: an
 * endpoint on 127.0.0.1 is reachable from any web page through DNS rebinding unless it checks both. That is a
 * network boundary and not authorization. Which agent may recall what is a later decision (ADR 0008).
 */
export interface McpEndpoint {
  /** Serves one web-standard request, for `caller` when the host established one. */
  fetch(request: Request, caller?: McpCaller): Promise<Response>
  /** Serves one `node:http` request, for a host built on `node:http`. */
  handle(request: IncomingMessage, response: ServerResponse, caller?: McpCaller): Promise<void>
  /** Aborts in-flight exchanges. The session stays open; its owner closes it. */
  close(): Promise<void>
}

/** Bounded like the SDK's own default, so a hostile body cannot exhaust memory before the SDK sees it. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

export interface McpEndpointOptions {
  readonly sceneTools?: readonly SceneTool[]
  /** Whether an elicitation answer counts as the person's decision (ADR 0012, decision 4). Defaults to true. */
  readonly elicitationDecisions?: boolean
  /** Host names accepted besides the loopback ones, such as a shared deployment's public name. */
  readonly allowedHostnames?: readonly string[]
  /** Origins accepted besides the loopback ones. */
  readonly allowedOrigins?: readonly string[]
}

export function createMcpEndpoint(
  session: CognitiveSession,
  options: McpEndpointOptions = {},
): McpEndpoint {
  const sceneTools = options.sceneTools ?? []
  assertSceneToolNames(sceneTools)
  const elicitationDecisions = options.elicitationDecisions ?? true
  const hostnames = [...localhostAllowedHostnames(), ...(options.allowedHostnames ?? [])]
  const origins = [...localhostAllowedOrigins(), ...(options.allowedOrigins ?? [])]
  // One codec for the endpoint's lifetime: a server is built per request, and the round that verifies a
  // learner's answer is a different request from the one that asked.
  const codec = createDecisionCodec()
  // The SDK hands the factory the request it serves, so the caller the host established travels with it.
  const callers = new WeakMap<Request, McpCaller>()
  const handler = createMcpHandler(({ requestInfo }) => {
    const caller = requestInfo === undefined ? undefined : callers.get(requestInfo)
    // An agent acts for the person its credential belongs to, so it reads and proposes in their session.
    const own = caller === undefined ? session : session.forActor(caller.actorId)
    return createEpistemeMcpServer(own, codec, sceneTools, {
      ...(caller === undefined ? {} : { caller }),
      elicitationDecisions,
    })
  })

  const fetch = async (request: Request, caller?: McpCaller): Promise<Response> => {
    if (caller !== undefined) callers.set(request, caller)
    return (
      hostHeaderValidationResponse(request, hostnames) ??
      originValidationResponse(request, origins) ??
      handler.fetch(request)
    )
  }

  return {
    fetch,
    handle: async (request, response, caller) => {
      const answer = await fetch(await toWebRequest(request), caller)
      await writeWebResponse(answer, response)
    },
    close: () => handler.close(),
  }
}

/**
 * Builds a web-standard request from a `node:http` one.
 *
 * Written here rather than taken from `@modelcontextprotocol/node`, which would bring in `hono` and
 * `@hono/node-server` for these few lines (ADR 0008).
 */
async function toWebRequest(request: IncomingMessage): Promise<Request> {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
  }

  const method = request.method ?? 'GET'
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
  if (method === 'GET' || method === 'HEAD') return new Request(url, { method, headers })

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return new Request(url, { method, headers, body: Buffer.concat(chunks) })
}

/** Writes a web-standard response, streaming its body so a server-sent event stream stays a stream. */
async function writeWebResponse(answer: Response, response: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {}
  answer.headers.forEach((value, name) => {
    headers[name] = value
  })
  response.writeHead(answer.status, headers)
  if (answer.body === null) {
    response.end()
    return
  }
  await pipeline(Readable.fromWeb(answer.body as NodeReadableStream<Uint8Array>), response)
}
