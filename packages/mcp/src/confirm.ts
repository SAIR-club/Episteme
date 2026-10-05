import { randomBytes } from 'node:crypto'
import {
  acceptedContent,
  createRequestStateCodec,
  fromJsonSchema,
  inputRequired,
  inputResponse,
  type CallToolResult,
  type InputRequiredResult,
  type McpServer,
  type RequestStateCodec,
  type ServerContext,
} from '@modelcontextprotocol/server'
import {
  RECORDABLE_DIMENSIONS,
  type Decision,
  type LearnSession,
  type Proposal,
  type Suggestion,
} from '@episteme/application'

/**
 * Asking the learner directly, through the agent's host (ADR 0008).
 *
 * MCP 2026-07-28 elicitation is a multi-round-trip: `propose` keeps the draft and returns `inputRequired`, a
 * form the host shows the user, plus a `requestState` naming the draft. The host retries the original call
 * with the user's answer in `inputResponses`. This module builds the form and reads the answer. It does not
 * decide anything itself: the decision goes to `LearnSession.decide`, the path every channel shares.
 *
 * Both values that come back are attacker-controlled. `requestState` is sealed with an HMAC under a key only
 * this process holds, expires, and is bound to the method, so a client cannot point a retry at a draft it was
 * not asked about. `inputResponses` is validated against the schema the form was built from, and anything that
 * fails is not a decision. 2025-era connections are served by the SDK's legacy shim from the same result.
 */

/** What `requestState` carries between rounds. Signed, not encrypted: the id is not a secret. */
export interface PendingDecisionState {
  readonly suggestionId: string
}

/**
 * The codec for one host process.
 *
 * A key generated per process is enough, and never leaves it, because one owner serves every round of every
 * flow on its graph. A restarted host cannot verify state minted before the restart, so such a retry fails
 * closed and the draft waits in the review queue.
 */
export function createDecisionCodec(): RequestStateCodec<PendingDecisionState> {
  return createRequestStateCodec<PendingDecisionState>({
    key: randomBytes(32),
    ttlSeconds: 15 * 60,
    bind: (context) => context.mcpReq.method,
  })
}

/**
 * Whether the client said it can show the user a form.
 *
 * Only such a client is asked. Over the stateless 2025-era HTTP leg no capabilities arrive at all, and the
 * legacy shim would answer an elicitation there with a failed call, so that client gets a pending draft and the
 * learner decides in the review queue instead.
 */
export function canAskLearner(server: McpServer): boolean {
  // Read through the low-level server because it covers both eras: per request on 2026-07-28, from the
  // handshake on a 2025-era connection that has one.
  const elicitation = server.server.getClientCapabilities()?.elicitation
  if (elicitation === undefined) return false
  // An empty object is the 2025 spelling of "form mode". A client that offers only URL mode cannot show a form.
  return elicitation.form !== undefined || elicitation.url === undefined
}

const DECISION_KEY = 'decision'

interface DecisionContent {
  readonly decision: 'accept' | 'modify' | 'dismiss'
  readonly level?: string
  readonly label?: string
  readonly relation?: string
}

/**
 * The form for one suggestion: the three choices, and the one field a modification of this kind changes.
 *
 * The same schema validates the answer, so what the learner can submit and what is accepted cannot differ.
 */
function decisionSchema(proposal: Proposal) {
  // Titled options are `oneOf` with `const` and `title`, the form the elicitation spec defines.
  const choice = {
    type: 'string',
    title: '你的决定',
    oneOf: [
      { const: 'accept', title: '接受' },
      { const: 'modify', title: '按我的修改记录' },
      { const: 'dismiss', title: '不采纳' },
    ],
  }
  switch (proposal.kind) {
    case 'state': {
      const dimension = RECORDABLE_DIMENSIONS.find(
        (candidate) => candidate.id === proposal.dimension,
      )
      const levels = dimension?.levelLabelsZh ?? []
      return fromJsonSchema<DecisionContent>({
        type: 'object',
        properties: {
          decision: choice,
          level: {
            type: 'string',
            title: '如果修改：你自己的判断',
            oneOf: levels.map((entry) => ({ const: entry.level, title: entry.label })),
          },
        },
        required: ['decision'],
      })
    }
    case 'claim':
      return fromJsonSchema<DecisionContent>({
        type: 'object',
        properties: {
          decision: choice,
          label: { type: 'string', title: '如果修改：用你自己的话写', minLength: 1 },
        },
        required: ['decision'],
      })
    case 'link':
      return fromJsonSchema<DecisionContent>({
        type: 'object',
        properties: {
          decision: choice,
          relation: { type: 'string', title: '如果修改：连接的类型', minLength: 1 },
        },
        required: ['decision'],
      })
  }
}

/** Puts a freshly kept draft in front of the learner, through the host. */
export async function askLearner(
  session: LearnSession,
  suggestion: Suggestion,
  codec: RequestStateCodec<PendingDecisionState>,
  context: ServerContext,
): Promise<InputRequiredResult> {
  return inputRequired({
    inputRequests: {
      [DECISION_KEY]: inputRequired.elicit({
        message: describeForLearner(session, suggestion),
        requestedSchema: decisionSchema(suggestion.proposal),
      }),
    },
    requestState: await codec.mint({ suggestionId: suggestion.id }, context),
  })
}

/**
 * Reads the learner's answer on a retried call and hands it to the shared decision path.
 *
 * Anything short of a valid answer leaves the draft pending: a declined or cancelled form, a retry without an
 * answer, content that fails the form's schema, or a modification without the value it modifies.
 */
export async function resolveAnswer(
  session: LearnSession,
  state: PendingDecisionState,
  context: ServerContext,
): Promise<CallToolResult> {
  const suggestion = session
    .pendingSuggestions()
    .find((candidate) => candidate.id === state.suggestionId)
  // Read here only to build the form's schema and a modification. Whether the draft is still pending when
  // the decision runs is answered by `decide` itself, inside the session's mutation queue.
  if (suggestion === undefined) return alreadyDecided(state.suggestionId)

  const view = inputResponse(context.mcpReq.inputResponses, DECISION_KEY)
  if (view.kind !== 'elicit' || view.action !== 'accept') {
    return answer(
      `The learner did not decide on ${suggestion.id}; it stays pending in their review queue. Do not ask again unprompted.`,
      { status: 'pending', suggestion },
    )
  }

  const content = acceptedContent(
    context.mcpReq.inputResponses,
    DECISION_KEY,
    decisionSchema(suggestion.proposal),
  )
  const decision = content === undefined ? undefined : decisionFrom(content, suggestion.proposal)
  if (decision === undefined) {
    return answer(
      `The learner's answer on ${suggestion.id} was not a complete decision; it stays pending in their review queue.`,
      { status: 'pending', suggestion },
    )
  }

  const result = await session.decide(suggestion.id, decision, 'mcp-elicitation')
  // Decided by another channel between the read above and this decision's turn in the queue.
  if (!result.ok && result.refusal.code === 'unknown_suggestion')
    return alreadyDecided(suggestion.id)
  if (!result.ok) {
    return {
      content: [
        {
          type: 'text',
          text: `The learner's decision on ${suggestion.id} could not be recorded (${result.refusal.code}): ${result.refusal.message}. It stays pending.`,
        },
      ],
      structuredContent: { status: 'refused', ...result.refusal, suggestionId: suggestion.id },
      isError: true,
    }
  }
  const told = {
    accepted: 'The learner accepted it. It is now part of their understanding, confirmed by them.',
    modified: 'The learner recorded their own version instead. Build on theirs, not on yours.',
    dismissed: 'The learner dismissed it. Nothing was recorded.',
  }[result.outcome]
  return answer(told, { status: result.outcome, result })
}

/** The answer as a decision, or `undefined` when a modification is missing the value it changes. */
function decisionFrom(content: DecisionContent, proposal: Proposal): Decision | undefined {
  if (content.decision === 'accept') return { action: 'accept' }
  if (content.decision === 'dismiss') return { action: 'dismiss' }
  switch (proposal.kind) {
    case 'state':
      return content.level === undefined
        ? undefined
        : { action: 'modify', proposal: { ...proposal, level: content.level } }
    case 'claim':
      return content.label === undefined
        ? undefined
        : { action: 'modify', proposal: { ...proposal, label: content.label } }
    case 'link':
      return content.relation === undefined
        ? undefined
        : { action: 'modify', proposal: { ...proposal, relation: content.relation } }
  }
}

/** The form's message, in the learner's language: what is proposed, by whom, and why. */
function describeForLearner(session: LearnSession, suggestion: Suggestion): string {
  const label = (id: string): string => session.graph.getNode(id)?.label ?? id
  const proposal = suggestion.proposal
  let what: string
  switch (proposal.kind) {
    case 'state': {
      const dimension = RECORDABLE_DIMENSIONS.find(
        (candidate) => candidate.id === proposal.dimension,
      )
      const level =
        dimension?.levelLabelsZh.find((entry) => entry.level === proposal.level)?.label ??
        proposal.level
      what = `把你对「${label(proposal.target)}」的${dimension?.labelZh ?? proposal.dimension}记为「${level}」`
      break
    }
    case 'claim': {
      const about = (proposal.about ?? []).map((id) => `「${label(id)}」`).join('、')
      what = `记下一条论断「${proposal.label}」${about === '' ? '' : `，关于 ${about}`}`
      break
    }
    case 'link':
      what = `把「${label(proposal.from)}」和「${label(proposal.to)}」连起来（${proposal.relation}）`
      break
  }
  return (
    `一个 agent 建议：${what}。\n理由：${suggestion.rationale}\n\n` +
    `在你决定之前，它不会改变你的理解。你也可以稍后在 Learn 页面的建议队列里处理。`
  )
}

/** Decided meanwhile, for example in the review queue. The first decision stands. */
function alreadyDecided(suggestionId: string): CallToolResult {
  return answer(
    `Suggestion ${suggestionId} is no longer pending; the learner already decided on it.`,
    { status: 'not_pending', suggestionId },
  )
}

function answer(text: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured }
}
