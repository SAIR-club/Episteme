import { Hono, type Context } from 'hono'
import { isRefusal, sceneViewOf, type CognitiveSession, type Decision } from '@episteme/application'
import {
  accessRefusal,
  resolveCaller,
  type BrowserSessions,
  type Caller,
  type DeploymentMode,
  type Directory,
  type Operation,
} from './identity.js'
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
function operationOf(method: string, path: string): Operation {
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
  /** The user file, or the one in-memory person of local mode. */
  readonly directory: Directory
  readonly browsers: BrowserSessions
  readonly mode: DeploymentMode
}

type ApiEnv = {
  Variables: {
    session: CognitiveSession
    caller: Caller | undefined
  }
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
function json(status: number, body: unknown): Response {
  const text = JSON.stringify(body)
  return new Response(text, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': String(Buffer.byteLength(text)),
    },
  })
}

/** A refusal: what the caller asked for cannot be done, and why, as a value with a code. */
function refusal(status: number, code: string, message: string): Response {
  return json(status, { error: message, code })
}

/**
 * A malformed percent escape is malformed input, not a route that happens not to exist.
 *
 * Hono decodes path parameters for us, but leaves an invalid escape as it was. Checking the raw pathname keeps
 * that answer explicit instead of letting the encoded text reach a command as if it were an id.
 */
function assertPathEncoding(path: string): void {
  if (/%(?![0-9A-Fa-f]{2})/.test(path)) {
    throw new RequestError('a path segment is not valid percent-encoding')
  }
}

/** Reads a JSON body, bounded so a malformed or hostile request cannot exhaust memory. */
async function readJson(context: Context<ApiEnv>): Promise<Record<string, unknown>> {
  const declared = context.req.header('content-length')
  if (declared !== undefined && Number(declared) > 1_000_000) {
    throw new RequestError('request body too large')
  }
  const stream = context.req.raw.body
  if (stream === null) return {}
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = stream.getReader()
  for (;;) {
    const chunk = (await reader.read()) as { done: boolean; value?: Uint8Array }
    if (chunk.done) break
    const value = chunk.value
    if (value === undefined) continue
    size += value.byteLength
    if (size > 1_000_000) {
      await reader.cancel()
      throw new RequestError('request body too large')
    }
    chunks.push(value)
  }
  if (size === 0) return {}
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(body))
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

/** A list of strings in a body field, or nothing when it is absent. */
function strings(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new RequestError(`"${field}" must be a list of strings`)
  }
  return value as string[]
}

/** What a token's label may be: a short name for the host, as `actor_agent_<label>` will show it. */
const MAX_LABEL = 64

/**
 * The API as one Hono app. Every route is declared on its method and path; authorization, malformed input and
 * application refusals are settled once, by middleware and `onError`, rather than by each route.
 */
export function createApiApp(context: ApiContext): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>()

  app.use('*', async (c, next) => {
    const path = c.req.path
    assertPathEncoding(path)

    // Who the request is for, from its credential and nothing else (ADR 0012).
    const resolved = resolveCaller(
      { authorization: c.req.header('authorization'), cookie: c.req.header('cookie') },
      context.directory,
      context.browsers,
    )
    if (!resolved.ok) {
      return json(401, { error: resolved.message, code: 'unauthenticated' })
    }
    const caller = resolved.caller

    const refused = accessRefusal(context.mode, caller, operationOf(c.req.method, path))
    if (refused !== undefined) {
      return json(refused.status, { error: refused.message, code: refused.code })
    }
    c.set('caller', caller)
    // Each person reads and writes through their own session over the one graph (ADR 0014).
    c.set(
      'session',
      caller === undefined ? context.session : context.session.forActor(caller.actorId),
    )
    return await next()
  })

  // The whole surface state in one read, so a Workspace renders from a single revision rather than from
  // several that could disagree.
  app.get(`${API_PREFIX}/state`, (c) => {
    const session = c.get('session')
    const nodes = session.listNodes()
    const understanding: Record<string, readonly { id: string; level: string }[]> = {}
    for (const node of nodes) understanding[node.nodeId] = session.understandingOf(node.nodeId)
    return json(200, {
      ...at(session),
      scene: context.profile.name,
      topic: {
        title: context.profile.seed.title,
        about: context.profile.seed.about,
        seeded: context.seeded,
      },
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
  })

  // The registered vocabulary, so a Workspace offers only levels the graph accepts (ADR 0013).
  app.get(`${API_PREFIX}/vocabulary`, (c) => {
    const session = c.get('session')
    return json(200, { ...at(session), dimensions: session.vocabulary() })
  })

  // Every decision, dismissals included, with its channel and credential: for finding one after the fact.
  app.get(`${API_PREFIX}/reviews`, (c) => {
    const session = c.get('session')
    const channel = c.req.query('channel')
    return json(200, {
      ...at(session),
      reviews: session
        .reviews()
        .filter((review) => channel === undefined || review.channel === channel),
    })
  })

  // Delegated confirmation (ADR 0016).
  app.get(`${API_PREFIX}/delegations`, (c) => {
    const session = c.get('session')
    return json(200, { ...at(session), delegations: session.delegations() })
  })
  app.post(`${API_PREFIX}/delegations`, async (c) => {
    const session = c.get('session')
    const body = await readJson(c)
    const delegation = await session.grantDelegation(
      typeof body['scope'] === 'string' ? body['scope'] : '*',
    )
    return json(200, { ...at(session), delegation })
  })
  app.post(`${API_PREFIX}/delegations/:id/revoke`, async (c) => {
    const session = c.get('session')
    const delegation = await session.revokeDelegation(c.req.param('id'))
    return json(200, { ...at(session), delegation })
  })
  app.post(`${API_PREFIX}/reviews/:id/undo`, async (c) => {
    const session = c.get('session')
    const undone = await session.undoDelegated(c.req.param('id'))
    return json(200, { ...at(session), ...undone })
  })

  // A person's own tokens (ADR 0012, decision 2): list them, issue an agent token, revoke one. Only the person's
  // own credential reaches here; authorization has refused an agent's.
  const selfService = (
    caller: Caller | undefined,
  ): { readonly caller: Caller; readonly people: Directory } | Response => {
    const people = context.mode === 'shared' ? context.directory : undefined
    if (people === undefined || !people.selfService || caller === undefined) {
      return refusal(
        422,
        'not_available_in_local_mode',
        'local mode has no user file: agents need no token here, and the person’s token is minted at each start',
      )
    }
    return { caller, people }
  }
  app.get(`${API_PREFIX}/tokens`, (c) => {
    const access = selfService(c.get('caller'))
    if (access instanceof Response) return access
    return json(200, {
      tokens: access.people.tokensOf(access.caller.actorId).map((token) => ({
        ...token,
        current: token.id === access.caller.credentialId,
      })),
    })
  })
  app.post(`${API_PREFIX}/tokens`, async (c) => {
    const access = selfService(c.get('caller'))
    if (access instanceof Response) return access
    const body = await readJson(c)
    if (body['kind'] !== undefined && body['kind'] !== 'agent') {
      return refusal(
        422,
        'agent_tokens_only',
        'only agent tokens are issued here; a human token is issued with the CLI on the service’s machine',
      )
    }
    const label = asString(body['label'], 'label').trim()
    const unprintable = [...label].some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code < 0x20 || code === 0x7f
    })
    if (label.length > MAX_LABEL || unprintable) {
      throw new RequestError(`"label" must be at most ${MAX_LABEL} printable characters`)
    }
    const issued = await access.people.issueAgentToken(access.caller.actorId, label)
    // The secret is in this response and nowhere else: the user file keeps only its hash.
    return json(200, { token: issued.summary, secret: issued.token })
  })
  app.post(`${API_PREFIX}/tokens/:id/revoke`, async (c) => {
    const access = selfService(c.get('caller'))
    if (access instanceof Response) return access
    const tokenId = c.req.param('id')
    if (tokenId === access.caller.credentialId) {
      return refusal(
        422,
        'current_credential',
        'this is the token this request is made with; revoke it from another of your credentials, or with the CLI',
      )
    }
    const revoked = await access.people.revokeOwnToken(access.caller.actorId, tokenId)
    if (revoked === undefined) {
      return refusal(404, 'unknown_token', 'there is no such token of yours')
    }
    return json(200, { token: revoked })
  })

  app.get(`${API_PREFIX}/suggestions`, (c) => {
    const session = c.get('session')
    return json(200, { ...at(session), suggestions: session.pendingSuggestions() })
  })

  // The person's decision on one suggestion. This route only collects it; what accept, modify and dismiss
  // mean lives in the application layer, shared with every other channel (ADR 0008).
  app.post(`${API_PREFIX}/suggestions/decide`, async (c) => {
    const session = c.get('session')
    const body = await readJson(c)
    const id = asString(body['id'], 'id')
    const caller = c.get('caller')
    const userAgent = c.req.header('user-agent')
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
      return refusal(422, result.refusal.code, result.refusal.message)
    }
    return json(200, {
      ...at(session),
      result,
      suggestions: session.pendingSuggestions(),
      events: session.eventCount,
    })
  })

  // The same query as the MCP `recall` tool, and the same result.
  app.post(`${API_PREFIX}/recall`, async (c) => {
    const session = c.get('session')
    const body = await readJson(c)
    const question = asString(body['question'], 'question')
    const options = typeof body['scope'] === 'string' ? { scope: body['scope'] } : {}
    if (body['depth'] === 'summary') {
      const { epoch, revision, result } = await readSettled(session, () =>
        session.recallSummary(question, {
          ...options,
          ...(typeof body['budget'] === 'number' ? { budget: body['budget'] } : {}),
        }),
      )
      return json(200, { epoch, revision, ...result })
    }
    const { epoch, revision, result } = await readSettled(session, () =>
      session.recall(question, options),
    )
    return json(200, { epoch, revision, ...result })
  })

  // The same query as the MCP `reflect` tool, and the same result.
  app.get(`${API_PREFIX}/reflect`, (c) => {
    const session = c.get('session')
    return json(200, {
      ...at(session),
      progress: session.progress(),
      pendingSuggestions: session.pendingSuggestions().length,
    })
  })

  app.get(`${API_PREFIX}/nodes/:id`, (c) => {
    const session = c.get('session')
    const expanded = session.expand(c.req.param('id'))
    if (expanded === undefined) {
      return refusal(404, 'unknown_node', 'there is no such node you can see')
    }
    return json(200, { ...at(session), node: expanded })
  })

  app.get(`${API_PREFIX}/nodes/:id/history`, (c) => {
    const session = c.get('session')
    const target = c.req.param('id')
    const events = session.historyOf(target)
    if (events === undefined) {
      return refusal(404, 'unknown_node', `there is no node "${target}"`)
    }
    return json(200, { ...at(session), target, events })
  })

  // Learning material in, pending suggestions out (ADR 0009). Nothing here changes the person's
  // understanding: what is found joins the review queue.
  app.post(`${API_PREFIX}/distill`, async (c) => {
    const session = c.get('session')
    const body = await readJson(c)
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
      return refusal(422, outcome.refusal.code, outcome.refusal.message)
    }
    return json(200, {
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
  })

  // What the person states about their own understanding. Authored by them, always.
  app.post(`${API_PREFIX}/record`, async (c) => {
    const session = c.get('session')
    const body = await readJson(c)
    const target = asString(body['target'], 'target')
    const dimensions = asObject(body['dimensions'], 'dimensions')
    const clean: Record<string, string> = {}
    for (const [dimension, level] of Object.entries(dimensions)) {
      clean[dimension] = asString(level, `dimensions.${dimension}`)
    }
    const recorded = await session.record(target, clean, {
      reason: typeof body['reason'] === 'string' ? body['reason'] : 'recorded from a Workspace',
    })
    return json(200, {
      ...at(session),
      ...recorded,
      // Echoed so the client does not have to guess what the recorded state now is.
      understanding: session.understandingOf(target),
      events: session.eventCount,
    })
  })

  // A node of the person's own.
  app.post(`${API_PREFIX}/nodes`, async (c) => {
    const session = c.get('session')
    const body = await readJson(c)
    const label = asString(body['label'], 'label')
    const kind = body['kind'] === 'concept' ? 'concept' : 'claim'
    const scope = body['scope'] === undefined ? undefined : asString(body['scope'], 'scope')
    const node = await session.addNode({ label, kind, ...(scope === undefined ? {} : { scope }) })
    return json(200, {
      ...at(session),
      node,
      nodes: session.listNodes(),
      events: session.eventCount,
    })
  })

  // Conversation threads (ADR 0015). Every one is the caller's own; another person's is not found.
  app.get(`${API_PREFIX}/threads`, (c) => {
    const session = c.get('session')
    const scope = c.req.query('scope')
    return json(200, { ...at(session), threads: session.threads(scope) })
  })
  app.post(`${API_PREFIX}/threads`, async (c) => {
    const session = c.get('session')
    const body = await readJson(c)
    const thread = await session.openThread({
      title: asString(body['title'], 'title'),
      ...(typeof body['scope'] === 'string' ? { scope: body['scope'] } : {}),
      ...(typeof body['hostSession'] === 'string' ? { hostSession: body['hostSession'] } : {}),
    })
    return json(200, { ...at(session), thread })
  })
  app.get(`${API_PREFIX}/threads/:id`, (c) => {
    const session = c.get('session')
    const view = session.threadView(c.req.param('id'))
    if (view === undefined) {
      return refusal(404, 'unknown_thread', 'there is no such thread of yours')
    }
    return json(200, { ...at(session), ...view })
  })
  app.post(`${API_PREFIX}/threads/:id/turns`, async (c) => {
    const session = c.get('session')
    const body = await readJson(c)
    const speaker = body['speaker']
    if (speaker !== 'learner' && speaker !== 'agent') {
      throw new RequestError('"speaker" must be learner or agent')
    }
    const turn = await session.appendTurn(c.req.param('id'), {
      speaker,
      text: asString(body['text'], 'text'),
    })
    return json(200, { ...at(session), turn })
  })
  app.post(`${API_PREFIX}/threads/:id/turns/:turnId/summary`, async (c) => {
    const session = c.get('session')
    const body = await readJson(c)
    const quotes = Array.isArray(body['quotes'])
      ? body['quotes'].filter((quote): quote is string => typeof quote === 'string')
      : []
    const summary = await session.summarizeTurn(c.req.param('id'), c.req.param('turnId'), {
      text: asString(body['text'], 'text'),
      quotes,
    })
    return json(200, { ...at(session), summary })
  })
  app.post(`${API_PREFIX}/threads/:id/fork`, async (c) => {
    const session = c.get('session')
    const body = await readJson(c)
    const thread = await session.forkThread(
      c.req.param('id'),
      asString(body['turn'], 'turn'),
      typeof body['title'] === 'string' ? body['title'] : undefined,
    )
    return json(200, { ...at(session), thread })
  })

  // A scene's own records, the caller's only (ADR 0015, decision 7).
  app.get(`${API_PREFIX}/scene-records/:scene`, (c) => {
    const session = c.get('session')
    const prefix = c.req.query('prefix')
    return json(200, {
      ...at(session),
      records: session.sceneRecords(c.req.param('scene'), prefix ?? ''),
    })
  })
  app.get(`${API_PREFIX}/scene-records/:scene/:key{.+}`, (c) => {
    const session = c.get('session')
    const record = session.sceneRecord(c.req.param('scene'), c.req.param('key'))
    if (record === undefined) {
      return refusal(404, 'unknown_record', 'there is no such record of yours')
    }
    return json(200, { ...at(session), record })
  })
  app.put(`${API_PREFIX}/scene-records/:scene/:key{.+}`, async (c) => {
    const session = c.get('session')
    const body = await readJson(c)
    if (!('value' in body)) throw new RequestError('"value" is required; null removes the record')
    const record = await session.putSceneRecord(
      c.req.param('scene'),
      c.req.param('key'),
      body['value'],
    )
    return json(200, { ...at(session), record })
  })

  // Sharing (ADR 0014): publish, browse, adopt, follow updates. Each acts for the caller's person.
  const publicationRequest = (body: Record<string, unknown>) => {
    const include = strings(body['include'], 'include')
    const threads = strings(body['threads'], 'threads')
    return {
      root: asString(body['root'], 'root'),
      ...(include === undefined ? {} : { include }),
      ...(threads === undefined ? {} : { threads }),
      ...(typeof body['supersedes'] === 'string' ? { supersedes: body['supersedes'] } : {}),
      ...(typeof body['note'] === 'string' ? { note: body['note'] } : {}),
    }
  }
  app.post(`${API_PREFIX}/publications/preview`, async (c) => {
    const session = c.get('session')
    const plan = session.publicationPlan(publicationRequest(await readJson(c)))
    if (!plan.ok) return refusal(422, plan.refusal.code, plan.refusal.message)
    return json(200, { ...at(session), ...plan })
  })
  app.post(`${API_PREFIX}/publications`, async (c) => {
    const session = c.get('session')
    const published = await session.publish(publicationRequest(await readJson(c)))
    if (!published.ok) return refusal(422, published.refusal.code, published.refusal.message)
    return json(200, { ...at(session), publication: published.publication })
  })
  app.get(`${API_PREFIX}/publications`, (c) => {
    const session = c.get('session')
    const author = c.req.query('author')
    const scope = c.req.query('scope')
    const q = c.req.query('q')
    return json(200, {
      ...at(session),
      publications: session.browsePublications({
        ...(author === undefined ? {} : { author }),
        ...(scope === undefined ? {} : { scope }),
        ...(q === undefined ? {} : { q }),
      }),
    })
  })
  app.get(`${API_PREFIX}/publications/:id`, (c) => {
    const session = c.get('session')
    const view = session.publicationView(c.req.param('id'))
    if (view === undefined) {
      return refusal(404, 'unknown_publication', 'there is no such publication to read')
    }
    return json(200, { ...at(session), ...view })
  })
  app.post(`${API_PREFIX}/publications/:id/withdraw`, async (c) => {
    const session = c.get('session')
    const body = await readJson(c)
    const withdrawn = await session.withdrawPublication(
      c.req.param('id'),
      typeof body['reason'] === 'string' ? body['reason'] : undefined,
    )
    if (!withdrawn.ok) {
      return refusal(422, withdrawn.refusal.code, withdrawn.refusal.message)
    }
    return json(200, { ...at(session), withdrawal: withdrawn.withdrawal })
  })
  app.post(`${API_PREFIX}/publications/:id/adopt`, async (c) => {
    const session = c.get('session')
    const id = c.req.param('id')
    const body = await readJson(c)
    const node = asString(body['node'], 'node')
    const dimensions = asObject(body['dimensions'], 'dimensions')
    const levels: Record<string, string> = {}
    for (const [dimension, level] of Object.entries(dimensions)) {
      levels[dimension] = asString(level, `dimensions.${dimension}`)
    }
    const adopted = await session.adopt(id, node, levels, {
      ...(typeof body['reason'] === 'string' ? { reason: body['reason'] } : {}),
    })
    return json(200, {
      ...at(session),
      ...adopted,
      understanding: session.understandingOf(node),
    })
  })
  app.get(`${API_PREFIX}/updates`, (c) => {
    const session = c.get('session')
    return json(200, { ...at(session), updates: session.updates() })
  })

  // A route the scene added. It sees the session only through the scene view.
  for (const route of context.profile.routes ?? []) {
    const path = `${API_PREFIX}/scene/${context.profile.name}${route.path}`
    app.on(route.method, path, async (c) => {
      const session = c.get('session')
      const body = route.method === 'POST' ? await readJson(c) : {}
      const query = new URLSearchParams()
      for (const [name, values] of Object.entries(c.req.queries())) {
        for (const value of values) query.append(name, value)
      }
      const answer = await route.handle({ view: sceneViewOf(session), body, query })
      return json(200, { ...at(session), ...answer })
    })
  }

  app.notFound((c) =>
    json(404, {
      error: `no route for ${c.req.method} ${c.req.path}`,
      code: 'no_route',
    }),
  )

  app.onError((error) => {
    if (error instanceof RequestError) {
      return json(400, { error: error.message, code: 'invalid_request' })
    }
    // Only a refusal is answered as one. A failure, such as a write that did not reach the disk, propagates and
    // is answered as 500: the change it interrupted may already be in memory, and 422 would say nothing changed.
    if (isRefusal(error)) {
      return json(422, { error: error.message, code: error.code })
    }
    const message = error instanceof Error ? error.message : String(error)
    return json(500, { error: message, code: 'internal' })
  })

  return app
}
