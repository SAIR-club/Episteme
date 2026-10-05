/**
 * Speaking MCP to an Episteme host in raw JSON-RPC, as an arbitrary agent host would.
 *
 * Raw rather than through an MCP client library, so what the tests exercise is the wire itself: the
 * per-request envelope of the 2026-07-28 revision, the stateless 2025 leg, and the multi-round-trip retry
 * that carries a learner's answer back.
 */

export const PROTOCOL = '2026-07-28'

export interface ToolResult {
  readonly content?: readonly { readonly type: string; readonly text: string }[]
  readonly structuredContent?: Record<string, unknown>
  readonly isError?: boolean
  /** `input_required` when the tool asks the client for input before it can finish. */
  readonly resultType?: string
  readonly inputRequests?: Record<string, { readonly method: string; readonly params: unknown }>
  readonly requestState?: string
}

export interface WireOptions {
  /** Speak the stateless 2025 leg: no envelope, no capabilities, no identity. */
  readonly legacy?: boolean
  readonly headers?: Record<string, string>
}

export interface Client {
  readonly name: string
  readonly version: string
  /** What the client declares it can do, such as showing the user an elicitation form. */
  readonly capabilities?: Record<string, unknown>
}

/** Plain functions rather than methods, so they can be taken apart and passed around. */
export interface McpWire {
  readonly rpc: (
    method: string,
    params?: Record<string, unknown>,
    options?: WireOptions,
  ) => Promise<{ status: number; body: Record<string, unknown> }>
  /** A tool call. `extra` carries a retry's `requestState` and `inputResponses`. */
  readonly call: (
    name: string,
    args: Record<string, unknown>,
    extra?: Record<string, unknown>,
    options?: WireOptions,
  ) => Promise<ToolResult>
}

export function mcpWire(url: () => string, client: Client): McpWire {
  let nextId = 1

  const rpc: McpWire['rpc'] = async (method, params = {}, options = {}) => {
    const modern = options.legacy !== true
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(modern ? { 'mcp-protocol-version': PROTOCOL, 'mcp-method': method } : {}),
      ...(modern && method === 'tools/call' ? { 'mcp-name': String(params['name']) } : {}),
      ...options.headers,
    }
    const envelope = {
      'io.modelcontextprotocol/protocolVersion': PROTOCOL,
      'io.modelcontextprotocol/clientInfo': { name: client.name, version: client.version },
      'io.modelcontextprotocol/clientCapabilities': client.capabilities ?? {},
    }
    const response = await fetch(url(), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: nextId++,
        method,
        params: modern ? { ...params, _meta: envelope } : params,
      }),
    })
    const text = await response.text()
    // A response may be one JSON body or a server-sent event stream carrying it.
    const json = response.headers.get('content-type')?.includes('text/event-stream')
      ? text
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice('data: '.length))
          .at(-1)
      : text
    return {
      status: response.status,
      body: json === undefined || json === '' ? {} : (JSON.parse(json) as Record<string, unknown>),
    }
  }

  const call: McpWire['call'] = async (name, args, extra = {}, options = {}) => {
    const { body } = await rpc('tools/call', { name, arguments: args, ...extra }, options)
    if (body['result'] === undefined) {
      throw new Error(`no result for ${name}: ${JSON.stringify(body)}`)
    }
    return body['result'] as ToolResult
  }

  return { rpc, call }
}

/** The learner's answer to the decision form, as a host sends it back on the retry. */
export function answer(
  action: 'accept' | 'decline' | 'cancel',
  content?: Record<string, unknown>,
): Record<string, unknown> {
  return { decision: content === undefined ? { action } : { action, content } }
}
