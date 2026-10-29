import type { IncomingMessage, ServerResponse } from 'node:http'
import { isRefusal, sceneViewOf, type CognitiveSession, type Decision } from '@episteme/application'
import type { Caller, Directory, Operation } from './identity.js'
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

/**
 * The routes only a person may use (ADR 0012, decision 3), so authorization can run before a route does.
 * Everything else reads, proposes or distills.
 */
const DECISION_ROUTES: readonly string[] = [
  `POST ${API_PREFIX}/suggestions/decide`,
  `POST ${API_PREFIX}/record`,
  `POST ${API_PREFIX}/nodes`,
  `POST ${API_PREFIX}/publications/preview`,
  `POST ${API_PREFIX}/publications`,
  // A person's own tokens: listing them included, since it shows which hosts act for them.
  `GET ${API_PREFIX}/tokens`,
  `POST ${API_PREFIX}/tokens`,
]

/** Publishing, withdrawing and adopting are contributions only a person makes (ADR 0014, decision 3). */
const DECISION_PATTERNS: readonly RegExp[] = [
  /^POST \/api\/v1\/publications\/[^/]+\/(withdraw|adopt)$/,
  // Granting, revoking and undoing delegation are the person's alone (ADR 0016, decision 1).
  /^POST \/api\/v1\/delegations(\/[^/]+\/revoke)?$/,
  /^POST \/api\/v1\/reviews\/[^/]+\/undo$/,
  /^POST \/api\/v1\/tokens\/[^/]+\/revoke$/,
]

/** What a request to the API asks to do. */
export function operationOf(method: string, path: string): Operation {
  const route = `${method} ${path}`
  return DECISION_ROUTES.includes(route) || DECISION_PATTERNS.some((pattern) => pattern.test(route))
    ? 'decide'
    : 'read'
}

export interface ApiContext {
  readonly session: CognitiveSession
  readonly profile: SceneProfile
  /** Whether this start seeded the profile's topic, or found it already there. */
  readonly seeded: boolean
  /** Who the request is for, when its credential says (ADR 0012). Authorization has already run. */
  readonly caller: Caller | undefined
  /** The people of a shared deployment and their tokens; `undefined` in local mode, which has no user file. */
  readonly people: Directory | undefined
}

/**
 * Which state a result describes: the session's revision, and the epoch it counts within. A revision alone
 * starts again from zero after a restart, so only the pair identifies a state.
 */
function at(session: CognitiveSession): { readonly epoch: string; readonly revision: number } {
  return { epoch: session.epoch, revision: session.revision }
}

/**
 * Runs a read that awaits, such as `recall` waiting on embeddings, and says which state it saw.
 *
 * Reads are not queued, so a change can land while one is waiting, and the result may then hold some of it and
 * not the rest. Such a read is reported at an odd revision, which promises nothing, rather than at the even
 * revision the change left behind, which would claim the result describes that state.
 */
export async function readSettled<T>(
  session: CognitiveSession,
  read: () => Promise<T>,
): Promise<{ readonly epoch: string; readonly revision: number; readonly result: T }> {
  const before = session.revision
  const result = await read()
  const after = session.revision
  return { epoch: session.epoch, revision: before === after ? after : after | 1, result }
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
    // Only a refusal is answered as one. A failure, such as a write that did not reach the disk, propagates and
    // is answered as 500: the change it interrupted may already be in memory, and 422 would say nothing changed.
    if (!isRefusal(error)) throw error
    sendRefusal(response, 422, error.code, error.message)
    return undefined
  }
}

const NODE_HISTORY = /^\/api\/v1\/nodes\/([^/]+)\/history$/
const NODE_DETAIL = /^\/api\/v1\/nodes\/([^/]+)$/
const THREAD = /^\/api\/v1\/threads\/([^/]+)$/
const THREAD_TURNS = /^\/api\/v1\/threads\/([^/]+)\/turns$/
const TURN_SUMMARY = /^\/api\/v1\/threads\/([^/]+)\/turns\/([^/]+)\/summary$/
const THREAD_FORK = /^\/api\/v1\/threads\/([^/]+)\/fork$/
const SCENE_RECORDS = /^\/api\/v1\/scene-records\/([^/]+)$/
const PUBLICATION = /^\/api\/v1\/publications\/([^/]+)$/
const DELEGATION_REVOKE = /^\/api\/v1\/delegations\/([^/]+)\/revoke$/
const REVIEW_UNDO = /^\/api\/v1\/reviews\/([^/]+)\/undo$/
const TOKEN_REVOKE = /^\/api\/v1\/tokens\/([^/]+)\/revoke$/
/** What a token's label may be: a short name for the host, as `actor_agent_<label>` will show it. */
const MAX_LABEL = 64
const PUBLICATION_ACTION = /^\/api\/v1\/publications\/([^/]+)\/(withdraw|adopt)$/

/** A list of strings in a body field, or nothing when it is absent. */
function strings(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new RequestError(`"${field}" must be a list of strings`)
  }
  return value as string[]
}
const SCENE_RECORD = /^\/api\/v1\/scene-records\/([^/]+)\/(.+)$/

/** A path segment, decoded, or a 400 when it is not valid percent-encoding. */
function segment(value: string | undefined): string {
  try {
    return decodeURIComponent(value ?? '')
  } catch {
    throw new RequestError('a path segment is not valid percent-encoding')
  }
}

/**
 * Serves one request under `/api/v1`. Every path that reaches here is answered, if only with a 404.
 */
export async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  { session, profile, seeded, caller, people }: ApiContext,
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
        dimensions: session.recordableDimensions,
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

    // The registered vocabulary, so a Workspace offers only levels the graph accepts (ADR 0013).
    if (path === `${API_PREFIX}/vocabulary` && method === 'GET') {
      sendJson(response, 200, { ...at(session), dimensions: session.vocabulary() })
      return
    }

    // Every decision, dismissals included, with its channel and credential: for finding one after the fact.
    if (path === `${API_PREFIX}/reviews` && method === 'GET') {
      const channel = new URL(request.url ?? '/', 'http://localhost').searchParams.get('channel')
      sendJson(response, 200, {
        ...at(session),
        reviews: session
          .reviews()
          .filter((review) => channel === null || review.channel === channel),
      })
      return
    }

    // Delegated confirmation (ADR 0016).
    if (path === `${API_PREFIX}/delegations` && method === 'GET') {
      sendJson(response, 200, { ...at(session), delegations: session.delegations() })
      return
    }
    if (path === `${API_PREFIX}/delegations` && method === 'POST') {
      const body = await readJson(request)
      const delegation = await session.grantDelegation(
        typeof body['scope'] === 'string' ? body['scope'] : '*',
      )
      sendJson(response, 200, { ...at(session), delegation })
      return
    }
    const revokePath = DELEGATION_REVOKE.exec(path)
    if (revokePath !== null && method === 'POST') {
      const delegation = await refusing(response, () =>
        session.revokeDelegation(segment(revokePath[1])),
      )
      if (delegation !== undefined) sendJson(response, 200, { ...at(session), delegation })
      return
    }
    const undoPath = REVIEW_UNDO.exec(path)
    if (undoPath !== null && method === 'POST') {
      const undone = await refusing(response, () => session.undoDelegated(segment(undoPath[1])))
      if (undone !== undefined) sendJson(response, 200, { ...at(session), ...undone })
      return
    }

    // A person's own tokens (ADR 0012, decision 2): list them, issue an agent token, revoke one. Only the person's
    // own credential reaches here; authorization has refused an agent's.
    const revokeTokenPath = TOKEN_REVOKE.exec(path)
    if (
      (path === `${API_PREFIX}/tokens` && (method === 'GET' || method === 'POST')) ||
      (revokeTokenPath !== null && method === 'POST')
    ) {
      if (people === undefined || !people.selfService || caller === undefined) {
        sendRefusal(
          response,
          422,
          'not_available_in_local_mode',
          'local mode has no user file: agents need no token here, and the person’s token is minted at each start',
        )
        return
      }
      if (method === 'GET' && revokeTokenPath === null) {
        sendJson(response, 200, {
          tokens: people
            .tokensOf(caller.actorId)
            .map((token) => ({ ...token, current: token.id === caller.credentialId })),
        })
        return
      }
      if (revokeTokenPath === null) {
        const body = await readJson(request)
        if (body['kind'] !== undefined && body['kind'] !== 'agent') {
          sendRefusal(
            response,
            422,
            'agent_tokens_only',
            'only agent tokens are issued here; a human token is issued with the CLI on the service’s machine',
          )
          return
        }
        const label = asString(body['label'], 'label').trim()
        const unprintable = [...label].some((character) => {
          const code = character.codePointAt(0) ?? 0
          return code < 0x20 || code === 0x7f
        })
        if (label.length > MAX_LABEL || unprintable) {
          throw new RequestError(`"label" must be at most ${MAX_LABEL} printable characters`)
        }
        const issued = await people.issueAgentToken(caller.actorId, label)
        // The secret is in this response and nowhere else: the user file keeps only its hash.
        sendJson(response, 200, { token: issued.summary, secret: issued.token })
        return
      }
      const tokenId = segment(revokeTokenPath[1])
      if (tokenId === caller.credentialId) {
        sendRefusal(
          response,
          422,
          'current_credential',
          'this is the token this request is made with; revoke it from another of your credentials, or with the CLI',
        )
        return
      }
      const revoked = await people.revokeOwnToken(caller.actorId, tokenId)
      if (revoked === undefined) {
        sendRefusal(response, 404, 'unknown_token', 'there is no such token of yours')
        return
      }
      sendJson(response, 200, { token: revoked })
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
      const userAgent = request.headers['user-agent']
      const result = await session.decide(
        id,
        decisionFrom(body),
        'review',
        caller === undefined
          ? undefined
          : {
              actorId: caller.actorId,
              credentialId: caller.credentialId,
              label: caller.label,
              ...(userAgent === undefined ? {} : { userAgent }),
            },
      )
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
      const question = asString(body['question'], 'question')
      const options = typeof body['scope'] === 'string' ? { scope: body['scope'] } : {}
      if (body['depth'] === 'summary') {
        const { epoch, revision, result } = await readSettled(session, () =>
          session.recallSummary(question, {
            ...options,
            ...(typeof body['budget'] === 'number' ? { budget: body['budget'] } : {}),
          }),
        )
        sendJson(response, 200, { epoch, revision, ...result })
        return
      }
      const { epoch, revision, result } = await readSettled(session, () =>
        session.recall(question, options),
      )
      sendJson(response, 200, { epoch, revision, ...result })
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

    const detail = NODE_DETAIL.exec(path)
    if (detail !== null && method === 'GET') {
      const expanded = session.expand(segment(detail[1]))
      if (expanded === undefined) {
        sendRefusal(response, 404, 'unknown_node', 'there is no such node you can see')
        return
      }
      sendJson(response, 200, { ...at(session), node: expanded })
      return
    }

    const history = NODE_HISTORY.exec(path)
    if (history !== null && method === 'GET') {
      let target: string
      try {
        target = decodeURIComponent(history[1] ?? '')
      } catch {
        throw new RequestError('the node id in the path is not valid percent-encoding')
      }
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
      // Either material sent as text, or turns of one of the caller's threads (ADR 0015, decision 5).
      // The application-defined scope the suggestions are made in; nodes accepted from them carry it.
      const scope = body['scope'] === undefined ? undefined : asString(body['scope'], 'scope')
      const outcome =
        typeof body['thread'] === 'string'
          ? await session.distillThread(body['thread'], {
              ...(scope === undefined ? {} : { scope }),
              ...(Array.isArray(body['turns'])
                ? { turns: body['turns'].filter((id): id is string => typeof id === 'string') }
                : {}),
            })
          : await (async () => {
              const text = asString(body['text'], 'text')
              const title = typeof body['title'] === 'string' ? body['title'] : undefined
              return session.distill(
                title === undefined ? { text } : { title, text },
                scope === undefined ? {} : { scope },
              )
            })()
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
        refused: outcome.refused.map(({ ref, code, message, existingNodeId }) => ({
          ref,
          code,
          message,
          ...(existingNodeId === undefined ? {} : { existingNodeId }),
        })),
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
      const scope = body['scope'] === undefined ? undefined : asString(body['scope'], 'scope')
      const node = await refusing(response, () =>
        session.addNode({ label, kind, ...(scope === undefined ? {} : { scope }) }),
      )
      if (node === undefined) return
      sendJson(response, 200, {
        ...at(session),
        node,
        nodes: session.listNodes(),
        events: session.eventCount,
      })
      return
    }

    // Conversation threads (ADR 0015). Every one is the caller's own; another person's is not found.
    if (path === `${API_PREFIX}/threads` && method === 'GET') {
      const scope = new URL(request.url ?? '/', 'http://localhost').searchParams.get('scope')
      sendJson(response, 200, { ...at(session), threads: session.threads(scope ?? undefined) })
      return
    }
    if (path === `${API_PREFIX}/threads` && method === 'POST') {
      const body = await readJson(request)
      const thread = await refusing(response, () =>
        session.openThread({
          title: asString(body['title'], 'title'),
          ...(typeof body['scope'] === 'string' ? { scope: body['scope'] } : {}),
          ...(typeof body['hostSession'] === 'string' ? { hostSession: body['hostSession'] } : {}),
        }),
      )
      if (thread !== undefined) sendJson(response, 200, { ...at(session), thread })
      return
    }
    const threadPath = THREAD.exec(path)
    if (threadPath !== null && method === 'GET') {
      const view = session.threadView(segment(threadPath[1]))
      if (view === undefined) {
        sendRefusal(response, 404, 'unknown_thread', 'there is no such thread of yours')
        return
      }
      sendJson(response, 200, { ...at(session), ...view })
      return
    }
    const turnsPath = THREAD_TURNS.exec(path)
    if (turnsPath !== null && method === 'POST') {
      const body = await readJson(request)
      const speaker = body['speaker']
      if (speaker !== 'learner' && speaker !== 'agent') {
        throw new RequestError('"speaker" must be learner or agent')
      }
      const turn = await refusing(response, () =>
        session.appendTurn(segment(turnsPath[1]), {
          speaker,
          text: asString(body['text'], 'text'),
        }),
      )
      if (turn !== undefined) sendJson(response, 200, { ...at(session), turn })
      return
    }
    const summaryPath = TURN_SUMMARY.exec(path)
    if (summaryPath !== null && method === 'POST') {
      const body = await readJson(request)
      const quotes = Array.isArray(body['quotes'])
        ? body['quotes'].filter((quote): quote is string => typeof quote === 'string')
        : []
      const summary = await refusing(response, () =>
        session.summarizeTurn(segment(summaryPath[1]), segment(summaryPath[2]), {
          text: asString(body['text'], 'text'),
          quotes,
        }),
      )
      if (summary !== undefined) sendJson(response, 200, { ...at(session), summary })
      return
    }
    const forkPath = THREAD_FORK.exec(path)
    if (forkPath !== null && method === 'POST') {
      const body = await readJson(request)
      const thread = await refusing(response, () =>
        session.forkThread(
          segment(forkPath[1]),
          asString(body['turn'], 'turn'),
          typeof body['title'] === 'string' ? body['title'] : undefined,
        ),
      )
      if (thread !== undefined) sendJson(response, 200, { ...at(session), thread })
      return
    }

    // A scene's own records, the caller's only (ADR 0015, decision 7).
    const recordsPath = SCENE_RECORDS.exec(path)
    if (recordsPath !== null && method === 'GET') {
      const prefix = new URL(request.url ?? '/', 'http://localhost').searchParams.get('prefix')
      sendJson(response, 200, {
        ...at(session),
        records: session.sceneRecords(segment(recordsPath[1]), prefix ?? ''),
      })
      return
    }
    const recordPath = SCENE_RECORD.exec(path)
    if (recordPath !== null && method === 'GET') {
      const record = session.sceneRecord(segment(recordPath[1]), segment(recordPath[2]))
      if (record === undefined) {
        sendRefusal(response, 404, 'unknown_record', 'there is no such record of yours')
        return
      }
      sendJson(response, 200, { ...at(session), record })
      return
    }
    if (recordPath !== null && method === 'PUT') {
      const body = await readJson(request)
      if (!('value' in body)) throw new RequestError('"value" is required; null removes the record')
      const record = await refusing(response, () =>
        session.putSceneRecord(segment(recordPath[1]), segment(recordPath[2]), body['value']),
      )
      if (record !== undefined) sendJson(response, 200, { ...at(session), record })
      return
    }

    // Sharing (ADR 0014): publish, browse, adopt, follow updates. Each acts for the caller's person.
    if (
      (path === `${API_PREFIX}/publications/preview` || path === `${API_PREFIX}/publications`) &&
      method === 'POST'
    ) {
      const body = await readJson(request)
      const include = strings(body['include'], 'include')
      const threads = strings(body['threads'], 'threads')
      const publicationRequest = {
        root: asString(body['root'], 'root'),
        ...(include === undefined ? {} : { include }),
        ...(threads === undefined ? {} : { threads }),
        ...(typeof body['supersedes'] === 'string' ? { supersedes: body['supersedes'] } : {}),
        ...(typeof body['note'] === 'string' ? { note: body['note'] } : {}),
      }
      if (path.endsWith('/preview')) {
        const plan = session.publicationPlan(publicationRequest)
        if (!plan.ok) {
          sendRefusal(response, 422, plan.refusal.code, plan.refusal.message)
          return
        }
        sendJson(response, 200, { ...at(session), ...plan })
        return
      }
      const published = await session.publish(publicationRequest)
      if (!published.ok) {
        sendRefusal(response, 422, published.refusal.code, published.refusal.message)
        return
      }
      sendJson(response, 200, { ...at(session), publication: published.publication })
      return
    }
    if (path === `${API_PREFIX}/publications` && method === 'GET') {
      const query = new URL(request.url ?? '/', 'http://localhost').searchParams
      sendJson(response, 200, {
        ...at(session),
        publications: session.browsePublications({
          ...(query.get('author') === null ? {} : { author: query.get('author')! }),
          ...(query.get('scope') === null ? {} : { scope: query.get('scope')! }),
          ...(query.get('q') === null ? {} : { q: query.get('q')! }),
        }),
      })
      return
    }
    const publicationPath = PUBLICATION.exec(path)
    if (publicationPath !== null && method === 'GET') {
      const view = session.publicationView(segment(publicationPath[1]))
      if (view === undefined) {
        sendRefusal(response, 404, 'unknown_publication', 'there is no such publication to read')
        return
      }
      sendJson(response, 200, { ...at(session), ...view })
      return
    }
    const actionPath = PUBLICATION_ACTION.exec(path)
    if (actionPath !== null && method === 'POST') {
      const id = segment(actionPath[1])
      const body = await readJson(request)
      if (actionPath[2] === 'withdraw') {
        const withdrawn = await session.withdrawPublication(
          id,
          typeof body['reason'] === 'string' ? body['reason'] : undefined,
        )
        if (!withdrawn.ok) {
          sendRefusal(response, 422, withdrawn.refusal.code, withdrawn.refusal.message)
          return
        }
        sendJson(response, 200, { ...at(session), withdrawal: withdrawn.withdrawal })
        return
      }
      const node = asString(body['node'], 'node')
      const dimensions = asObject(body['dimensions'], 'dimensions')
      const levels: Record<string, string> = {}
      for (const [dimension, level] of Object.entries(dimensions)) {
        levels[dimension] = asString(level, `dimensions.${dimension}`)
      }
      const adopted = await refusing(response, () =>
        session.adopt(id, node, levels, {
          ...(typeof body['reason'] === 'string' ? { reason: body['reason'] } : {}),
        }),
      )
      if (adopted === undefined) return
      sendJson(response, 200, {
        ...at(session),
        ...adopted,
        understanding: session.understandingOf(node),
      })
      return
    }
    if (path === `${API_PREFIX}/updates` && method === 'GET') {
      sendJson(response, 200, { ...at(session), updates: session.updates() })
      return
    }

    // A route the scene added. It sees the session only through the scene view.
    const scenePrefix = `${API_PREFIX}/scene/${profile.name}`
    if (path.startsWith(`${scenePrefix}/`)) {
      const subpath = path.slice(scenePrefix.length)
      const sceneRoute = profile.routes?.find(
        (candidate) => candidate.method === method && candidate.path === subpath,
      )
      if (sceneRoute !== undefined) {
        const body = method === 'POST' ? await readJson(request) : {}
        const query = new URL(request.url ?? '/', 'http://localhost').searchParams
        const answer = await refusing(response, async () =>
          sceneRoute.handle({ view: sceneViewOf(session), body, query }),
        )
        if (answer === undefined) return
        sendJson(response, 200, { ...at(session), ...answer })
        return
      }
    }

    sendRefusal(response, 404, 'no_route', `no route for ${method} ${path}`)
  }
}
