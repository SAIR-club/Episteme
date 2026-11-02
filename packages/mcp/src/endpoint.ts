import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import type { CognitiveSession } from '@episteme/application'
import {
  type AuthInfo,
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
  /** Told of each JSON-RPC message that passed validation, for showing which clients use the endpoint. */
  readonly onActivity?: (activity: McpActivity) => void
}

/**
 * One message a client sent, as far as the message itself says. `client` is the `client` query parameter of the
 * address the client was given, and `clientInfo` what it said at `initialize`: both are the client's own word, for
 * telling clients apart and never for deciding what one may do.
 */
export interface McpActivity {
  readonly at: number
  readonly method: string
  readonly client?: string
  readonly userAgent?: string
  readonly clientInfo?: { readonly name: string; readonly version?: string }
  /** For `tools/call`: the tool it called. */
  readonly tool?: string
  /** Whether the request carried a credential, and whose. */
  readonly credential?: 'person' | 'agent'
}

const MAX_NOTED = 64

/** Reads what `request` asks without consuming it. Anything unreadable is simply not reported. */
async function activitiesOf(
  request: Request,
  caller: McpCaller | undefined,
): Promise<McpActivity[]> {
  if (request.method !== 'POST') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(await request.clone().text())
  } catch {
    return []
  }
  const url = new URL(request.url)
  const client = url.searchParams.get('client')?.slice(0, MAX_NOTED)
  const userAgent = request.headers.get('user-agent')?.slice(0, 200)
  const credential = caller === undefined ? undefined : caller.kind === 'human' ? 'person' : 'agent'
  const at = Date.now()
  const messages = Array.isArray(parsed) ? parsed : [parsed]
  const found: McpActivity[] = []
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    const { method, params } = message as { method?: unknown; params?: unknown }
    if (typeof method !== 'string') continue
    const given = (typeof params === 'object' && params !== null ? params : {}) as Record<
      string,
      unknown
    >
    // `initialize` names the client; in the stateless protocol every request names it in its `_meta`.
    const meta = (
      typeof given['_meta'] === 'object' && given['_meta'] !== null ? given['_meta'] : {}
    ) as Record<string, unknown>
    const info = (given['clientInfo'] ?? meta['io.modelcontextprotocol/clientInfo']) as
      | { name?: unknown; version?: unknown }
      | undefined
    const name = method === 'tools/call' ? given['name'] : undefined
    found.push({
      at,
      method: method.slice(0, MAX_NOTED),
      ...(client === undefined || client === '' ? {} : { client }),
      ...(userAgent === undefined ? {} : { userAgent }),
      ...(typeof info?.name === 'string'
        ? {
            clientInfo: {
              name: info.name.slice(0, MAX_NOTED),
              ...(typeof info.version === 'string'
                ? { version: info.version.slice(0, MAX_NOTED) }
                : {}),
            },
          }
        : {}),
      ...(typeof name === 'string' ? { tool: name.slice(0, MAX_NOTED) } : {}),
      ...(credential === undefined ? {} : { credential }),
    })
  }
  return found
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
  const onActivity = options.onActivity
  // One codec for the endpoint's lifetime: a server is built per request, and the round that verifies a
  // learner's answer is a different request from the one that asked.
  const codec = createDecisionCodec()
  // The caller the host established travels to the factory through the SDK's `authInfo`, which the SDK passes
  // through untouched and never fills from request headers. It does not travel with the `Request`: the SDK
  // clones a POST before serving it, so anything keyed on the request object is lost on the way.
  const handler = createMcpHandler(({ authInfo }) => {
    // Every request this endpoint serves carries a binding, even one with no caller. A request that arrives
    // without one lost its caller on the way, so it is refused rather than served as the session's own person.
    const binding = bindingOf(authInfo)
    if (binding === undefined) {
      throw new Error('the caller of this MCP request could not be established; refusing it')
    }
    const caller = binding.caller
    // An agent acts for the person its credential belongs to, so it reads and proposes in their session.
    const own = caller === undefined ? session : session.forActor(caller.actorId)
    return createEpistemeMcpServer(own, codec, sceneTools, {
      ...(caller === undefined ? {} : { caller }),
      elicitationDecisions,
    })
  })

  const fetch = async (request: Request, caller?: McpCaller): Promise<Response> => {
    const refused =
      hostHeaderValidationResponse(request, hostnames) ?? originValidationResponse(request, origins)
    if (refused !== undefined) return refused
    if (onActivity !== undefined) {
      for (const activity of await activitiesOf(request, caller)) {
        try {
          onActivity(activity)
        } catch {
          // Noting who called is never a reason to fail the call.
        }
      }
    }
    return handler.fetch(request, { authInfo: authInfoFor(caller) })
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

/** Where the binding sits in `AuthInfo.extra`. Only this endpoint writes it; the SDK never fills `authInfo`. */
const BINDING = 'episteme.caller'

interface CallerBinding {
  /** The caller the host established, or `undefined` for a request it served without a credential. */
  readonly caller: McpCaller | undefined
}

/**
 * The SDK's `authInfo` for one request. Never the secret: `token` names the credential, not its value, so
 * nothing downstream that logs or echoes `authInfo` can leak it.
 */
function authInfoFor(caller: McpCaller | undefined): AuthInfo {
  const binding: CallerBinding = { caller }
  return {
    token: caller?.credentialId ?? 'none',
    clientId: caller?.label ?? 'none',
    scopes: caller === undefined ? [] : [caller.kind],
    extra: { [BINDING]: binding },
  }
}

/** The binding `authInfoFor` made, or `undefined` when the request reached the factory without one. */
function bindingOf(authInfo: AuthInfo | undefined): CallerBinding | undefined {
  const binding = authInfo?.extra?.[BINDING]
  if (typeof binding !== 'object' || binding === null || !('caller' in binding)) return undefined
  return binding as CallerBinding
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
