import type { IncomingMessage, ServerResponse } from 'node:http'
import { RECORDABLE_DIMENSIONS, type Decision, type LearnSession } from '@episteme/application'
import type { SceneProfile } from './profile.js'

/**
 * The REST API, version 1 (ADR 0010).
 *
 * The surface for human-facing clients, such as a Workspace. Every route calls the same commands and queries
 * in `@episteme/application` as the MCP tools do, so the two protocols cannot drift apart. Deciding a
 * suggestion is offered here and never over MCP. That separates purposes; it does not establish who is
 * calling. Any local process that reaches this API can attempt a decision (ADR 0010, _Constraints_).
 *
 * The contract is written down in this package's README. A breaking change gets `/api/v2`.
 */
export const API_PREFIX = '/api/v1'

export interface ApiContext {
  readonly session: LearnSession
  readonly profile: SceneProfile
  /** Whether this start seeded the profile's topic, or found it already there. */
  readonly seeded: boolean
}

/**
 * Which state a result describes: the session's revision, and the epoch it counts within. A revision alone
 * starts again from zero after a restart, so only the pair identifies a state.
 */
function at(session: LearnSession): { readonly epoch: string; readonly revision: number } {
  return { epoch: session.epoch, revision: session.revision }
}

/** Input that does not have the shape a route needs. Answered with 400, never with a stack. */
class RequestError extends Error {}

/** A JSON response, with no-store so a reload never shows a stale answer. */
export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

/** A refusal: what the caller asked for cannot be done, and why, as a value with a code. */
function sendRefusal(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  sendJson(response, status, { error: message, code })
}

/** Reads a JSON body, bounded so a malformed or hostile request cannot exhaust memory. */
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > 1_000_000) throw new RequestError('request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RequestError('request body is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RequestError('request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RequestError(`"${field}" must be a non-empty string`)
  }
  return value
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RequestError(`"${field}" must be an object`)
  }
  return value as Record<string, unknown>
}

/**
 * Reads a decision from a request body.
 *
 * Only the shape is checked here. Whether a modified value could ever be committed is the application's
 * question, answered the same way for every channel.
 */
function decisionFrom(body: Record<string, unknown>): Decision {
  const action = body['action']
  if (action === 'accept' || action === 'dismiss') return { action }
  if (action !== 'modify') {
    throw new RequestError('"action" must be one of accept, modify, dismiss')
  }
  const fields = asObject(body['proposal'], 'proposal')
  const text = (name: string): string => asString(fields[name], `proposal.${name}`)
  switch (fields['kind']) {
    case 'node': {
      const properties = fields['properties']
      return {
        action,
        proposal: {
          kind: 'node',
          nodeType: text('nodeType'),
          label: text('label'),
          ...(properties === undefined
            ? {}
            : { properties: asObject(properties, 'proposal.properties') }),
        },
      }
    }
    case 'claim': {
      const about = fields['about']
      if (
        about !== undefined &&
        !(Array.isArray(about) && about.every((id) => typeof id === 'string'))
      ) {
        throw new RequestError('"proposal.about" must be a list of node ids')
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
      throw new RequestError('"proposal.kind" must be one of node, claim, link, state')
  }
}

/**
 * Runs a command the application refuses by throwing, such as recording an unknown dimension, and answers
 * its refusal as a value rather than as a failure of the service.
 */
async function refusing<T>(
  response: ServerResponse,
  command: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await command()
  } catch (error) {
    if (error instanceof RequestError || !(error instanceof Error)) throw error
    const code = (error as { code?: unknown }).code
    sendRefusal(response, 422, typeof code === 'string' ? code : 'refused', error.message)
    return undefined
  }
}

const NODE_HISTORY = /^\/api\/v1\/nodes\/([^/]+)\/history$/

/**
 * Serves one request under `/api/v1`. Every path that reaches here is answered, if only with a 404.
 */
export async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  { session, profile, seeded }: ApiContext,
): Promise<void> {
  try {
    await route()
  } catch (error) {
    if (!(error instanceof RequestError)) throw error
    sendRefusal(response, 400, 'invalid_request', error.message)
  }

  async function route(): Promise<void> {
    const method = request.method ?? 'GET'

    // The whole surface state in one read, so a Workspace renders from a single revision rather than from
    // several that could disagree.
    if (path === `${API_PREFIX}/state` && method === 'GET') {
      const nodes = session.listNodes()
      const understanding: Record<string, readonly { id: string; level: string }[]> = {}
      for (const node of nodes) understanding[node.nodeId] = session.understandingOf(node.nodeId)
      sendJson(response, 200, {
        ...at(session),
        scene: profile.name,
        topic: { title: profile.seed.title, about: profile.seed.about, seeded },
        dimensions: RECORDABLE_DIMENSIONS,
        nodes,
        understanding,
        openEnds: session.openEnds(),
        progress: session.progress(),
        // What agents proposed and the learner has not decided. Nothing here is the learner's state yet.
        suggestions: session.pendingSuggestions(),
        events: session.eventCount,
        retriever: session.retrieverName,
        rules: session.rules,
      })
      return
    }

    if (path === `${API_PREFIX}/suggestions` && method === 'GET') {
      sendJson(response, 200, {
        ...at(session),
        suggestions: session.pendingSuggestions(),
      })
      return
    }

    // The person's decision on one suggestion. This route only collects it; what accept, modify and dismiss
    // mean lives in the application layer, shared with every other channel (ADR 0008).
    if (path === `${API_PREFIX}/suggestions/decide` && method === 'POST') {
      const body = await readJson(request)
      const id = asString(body['id'], 'id')
      const result = await session.decide(id, decisionFrom(body), 'learn-review')
      if (!result.ok) {
        sendRefusal(response, 422, result.refusal.code, result.refusal.message)
        return
      }
      sendJson(response, 200, {
        ...at(session),
        result,
        suggestions: session.pendingSuggestions(),
        events: session.eventCount,
      })
      return
    }

    // The same query as the MCP `recall` tool, and the same result.
    if (path === `${API_PREFIX}/recall` && method === 'POST') {
      const body = await readJson(request)
      const recalled = await session.recall(asString(body['question'], 'question'))
      sendJson(response, 200, { ...at(session), ...recalled })
      return
    }

    // The same query as the MCP `reflect` tool, and the same result.
    if (path === `${API_PREFIX}/reflect` && method === 'GET') {
      sendJson(response, 200, {
        ...at(session),
        progress: session.progress(),
        pendingSuggestions: session.pendingSuggestions().length,
      })
      return
    }

    const history = NODE_HISTORY.exec(path)
    if (history !== null && method === 'GET') {
      const target = decodeURIComponent(history[1] ?? '')
      const events = session.historyOf(target)
      if (events === undefined) {
        sendRefusal(response, 404, 'unknown_node', `there is no node "${target}"`)
        return
      }
      sendJson(response, 200, { ...at(session), target, events })
      return
    }

    // Learning material in, pending suggestions out (ADR 0009). Nothing here changes the person's
    // understanding: what is found joins the review queue.
    if (path === `${API_PREFIX}/distill` && method === 'POST') {
      const body = await readJson(request)
      const text = asString(body['text'], 'text')
      const title = typeof body['title'] === 'string' ? body['title'] : undefined
      const outcome = await session.distill(title === undefined ? { text } : { title, text })
      if (!outcome.ok) {
        sendRefusal(response, 422, outcome.refusal.code, outcome.refusal.message)
        return
      }
      sendJson(response, 200, {
        ...at(session),
        status: 'pending',
        sourceId: outcome.sourceId,
        episodes: outcome.episodes,
        suggestions: outcome.suggestions.map((suggestion) => ({
          id: suggestion.id,
          proposal: suggestion.proposal,
          excerpt: suggestion.origin?.excerpt,
        })),
        refused: outcome.refused.map(({ ref, code, message }) => ({ ref, code, message })),
      })
      return
    }

    // What the person states about their own understanding. Authored by them, always.
    if (path === `${API_PREFIX}/record` && method === 'POST') {
      const body = await readJson(request)
      const target = asString(body['target'], 'target')
      const dimensions = asObject(body['dimensions'], 'dimensions')
      const clean: Record<string, string> = {}
      for (const [dimension, level] of Object.entries(dimensions)) {
        clean[dimension] = asString(level, `dimensions.${dimension}`)
      }
      const recorded = await refusing(response, () =>
        session.record(target, clean, {
          reason: typeof body['reason'] === 'string' ? body['reason'] : 'recorded from a Workspace',
        }),
      )
      if (recorded === undefined) return
      sendJson(response, 200, {
        ...at(session),
        ...recorded,
        // Echoed so the client does not have to guess what the recorded state now is.
        understanding: session.understandingOf(target),
        events: session.eventCount,
      })
      return
    }

    // A node of the person's own.
    if (path === `${API_PREFIX}/nodes` && method === 'POST') {
      const body = await readJson(request)
      const label = asString(body['label'], 'label')
      const kind = body['kind'] === 'concept' ? 'concept' : 'claim'
      const node = await refusing(response, () => session.addNode({ label, kind }))
      if (node === undefined) return
      sendJson(response, 200, {
        ...at(session),
        node,
        nodes: session.listNodes(),
        events: session.eventCount,
      })
      return
    }

    sendRefusal(response, 404, 'no_route', `no route for ${method} ${path}`)
  }
}
