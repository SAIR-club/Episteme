import {
  CLIENT_INFO_META_KEY,
  McpServer,
  fromJsonSchema,
  type CallToolResult,
  type RequestStateCodec,
  type ServerContext,
} from '@modelcontextprotocol/server'
import { askLearner, canAskLearner, resolveAnswer, type PendingDecisionState } from './confirm.js'
import {
  MAX_HOST_ITEMS,
  MAX_MATERIAL,
  RECORDABLE_DIMENSIONS,
  type DistillOutcome,
  type HostItem,
  type LearnSession,
  type Proposal,
  type RecallResult,
  type ProgressSummary,
} from '@episteme/application'

/**
 * The tools an agent sees (ADR 0008): `recall`, `propose`, `reflect` and `distill` (ADR 0009), and nothing
 * that writes. `distill` only produces suggestions, like `propose`.
 *
 * There is deliberately no tool that confirms a suggestion and none that writes a node, an edge or a state
 * event. An agent that could confirm would be confirming itself. Everything it wants to change is proposed,
 * and becomes the learner's only through the one human-decision path: the Learn review queue, which Episteme
 * controls, or a form the host shows its user, which Episteme can validate but cannot prove a person answered
 * (ADR 0008, Trust boundaries). The decision never comes from the tool's arguments, and nothing a client sends
 * names who confirmed.
 *
 * Text is addressed to the agent, in English, with the same data as `structuredContent` so a host can use
 * either. The learner-facing Chinese of the Learn surface stays there.
 */

/** Who an agent is, as far as anyone can tell: its self-declared client name. Provenance, not authentication. */
export function agentActorFor(clientName: string | undefined): string {
  const slug = (clientName ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48)
  // A 2025-era client served statelessly sends no identity with a tool call. Saying so beats inventing one.
  return `actor_agent_${slug === '' ? 'unidentified' : slug}`
}

function clientNameOf(context: ServerContext): string | undefined {
  const envelope = context.mcpReq.envelope as Readonly<Record<string, unknown>> | undefined
  const info = envelope?.[CLIENT_INFO_META_KEY] as { readonly name?: unknown } | undefined
  return typeof info?.name === 'string' ? info.name : undefined
}

const RECALL_INPUT = fromJsonSchema<{ question: string }>({
  type: 'object',
  properties: {
    question: {
      type: 'string',
      minLength: 1,
      description: 'The question being worked on, in the learner’s words where possible.',
    },
  },
  required: ['question'],
  additionalProperties: false,
})

interface ProposeInput {
  kind: 'claim' | 'link' | 'state'
  rationale: string
  label?: string
  about?: string[]
  from?: string
  to?: string
  relation?: string
  target?: string
  dimension?: string
  level?: string
}

const PROPOSE_INPUT = fromJsonSchema<ProposeInput>({
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: ['claim', 'link', 'state'],
      description:
        'claim: a new claim (label, optional about). link: connect two existing nodes (from, to, relation). state: a change on one dimension of an existing node (target, dimension, level).',
    },
    rationale: {
      type: 'string',
      minLength: 1,
      description: 'Why you propose this, so the learner can judge it.',
    },
    label: { type: 'string', description: 'claim: the claim, as the learner would state it.' },
    about: {
      type: 'array',
      items: { type: 'string' },
      description: 'claim: ids of the concepts or questions the claim is about.',
    },
    from: { type: 'string', description: 'link: the id of the node the edge starts from.' },
    to: { type: 'string', description: 'link: the id of the node the edge points to.' },
    relation: {
      type: 'string',
      description: 'link: a registered edge type, for example refers_to, supports, contradicts.',
    },
    target: { type: 'string', description: 'state: the id of the node the change is about.' },
    dimension: {
      type: 'string',
      enum: RECORDABLE_DIMENSIONS.map((dimension) => dimension.id),
      description: 'state: which dimension of the learner’s understanding.',
    },
    level: {
      type: 'string',
      description: `state: the proposed level. ${RECORDABLE_DIMENSIONS.map((dimension) => `${dimension.id}: ${dimension.levels.join(' | ')}`).join('; ')}.`,
    },
  },
  required: ['kind', 'rationale'],
  additionalProperties: false,
})

interface DistillInput {
  title?: string
  text: string
  candidates?: HostItem[]
  learner?: string
  hostSession?: string
  submissionId?: string
}

const SHORT_TEXT = { type: 'string', minLength: 1, maxLength: 200 } as const

const DISTILL_INPUT = fromJsonSchema<DistillInput>({
  type: 'object',
  properties: {
    title: { type: 'string', maxLength: 200, description: 'A short title for the material.' },
    text: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_MATERIAL,
      description:
        'The learning material or dialogue, verbatim. A dialogue reads best as "speaker: utterance" lines, optionally starting with [mm:ss]. Send only the stretch you read, never a whole transcript.',
    },
    candidates: {
      type: 'array',
      maxItems: MAX_HOST_ITEMS,
      description:
        'Your own reading of the text. With it you are the reader and Episteme does not also read the text; without it, Episteme reads it with its own rules. Each item quotes the words it rests on, verbatim; Episteme checks every quote against the text and refuses what it cannot find.',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['node', 'relation', 'state'] },
          ref: {
            type: 'string',
            maxLength: 100,
            description:
              'Your name for the item. Required for a node, which other items name as "cand:<ref>"; refusals are reported under it.',
          },
          role: {
            type: 'string',
            enum: ['concept', 'question', 'claim', 'evidence'],
            description: 'node: what it is.',
          },
          label: {
            type: 'string',
            description: 'node: the unit of understanding, as the learner would state it.',
          },
          from: { type: 'string', description: 'relation: "cand:<ref>" or an existing node id.' },
          to: { type: 'string', description: 'relation: "cand:<ref>" or an existing node id.' },
          relation: {
            type: 'string',
            enum: ['about', 'answers', 'supports', 'contradicts', 'revises'],
            description:
              'relation: revises points from an earlier claim to the one that corrects it, and never withdraws the earlier one.',
          },
          target: {
            type: 'string',
            description: 'state: "cand:<ref>" or an existing node id (from recall).',
          },
          dimension: { type: 'string', description: 'state: which dimension.' },
          level: {
            type: 'string',
            description:
              'state: the level. A conflict may be suggested as suspected or open only; settling one is the learner’s act.',
          },
          quote: {
            type: 'string',
            minLength: 1,
            maxLength: 1000,
            description: 'The words the item rests on, copied exactly from the text.',
          },
          occurrence: {
            type: 'integer',
            minimum: 1,
            description:
              'Which occurrence of the quote in the whole text, counting from 1. Required when the quote occurs more than once.',
          },
          basis: {
            type: 'string',
            enum: ['stated', 'inferred'],
            description:
              'stated: the quoted words are the learner’s own, in their turn. inferred: this is your reading of what was said. Say inferred whenever you are interpreting, even when the words you quote are the learner’s. Neither means the learner has mastered anything.',
          },
          rationale: { type: 'string', minLength: 1, description: 'Why you propose it.' },
        },
        required: ['kind', 'quote', 'basis', 'rationale'],
        additionalProperties: false,
      },
    },
    learner: {
      ...SHORT_TEXT,
      description:
        'The learner’s speaker label in the text, exactly as written, such as "学生" or "User". Without it nothing can be stated.',
    },
    hostSession: {
      ...SHORT_TEXT,
      description: 'Your own identifier for this conversation. Provenance only.',
    },
    submissionId: {
      ...SHORT_TEXT,
      description:
        'An idempotency key. Sending the same request again with it changes nothing and returns what became of the first; a different request under the same key is refused.',
    },
  },
  required: ['text'],
  additionalProperties: false,
})

const REFLECT_INPUT = fromJsonSchema<Record<string, never>>({
  type: 'object',
  properties: {},
  additionalProperties: false,
})

/** One MCP server over one session. Built per request by the HTTP endpoint; it holds no state of its own. */
export function createEpistemeMcpServer(
  session: LearnSession,
  codec: RequestStateCodec<PendingDecisionState>,
): McpServer {
  // Every echoed `requestState` is verified before a handler runs. A forged or expired one never reaches it.
  const server = new McpServer(
    { name: 'episteme', version: '0.1.0' },
    { requestState: { verify: (state, context) => codec.verify(state, context) } },
  )

  server.registerTool(
    'recall',
    {
      title: 'Recall prior understanding',
      description:
        'Before answering, find what this learner already understands that bears on the question, with why each item was retrieved and what they have recorded about it. Build on what is settled; do not build on anything marked with an open conflict. Changes nothing.',
      inputSchema: RECALL_INPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ question }) => {
      const recalled = await session.recall(question)
      return result(describeRecall(recalled), recalled)
    },
  )

  server.registerTool(
    'propose',
    {
      title: 'Propose a change to the learner’s understanding',
      description:
        'Propose a claim, a link or a state change. It is kept as a pending suggestion and changes nothing until the learner decides on it themselves; you cannot decide for them. If your host can show the learner a form, they are asked right away; otherwise it waits in their review queue. A proposal that could never be accepted is refused with the reason.',
      inputSchema: PROPOSE_INPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input, context) => {
      // A retry carrying the learner's answer to a form this tool asked for. The signed state, not the
      // arguments, says which draft it is about.
      const answered = context.mcpReq.requestState<PendingDecisionState>()
      if (answered !== undefined) return resolveAnswer(session, answered, context)

      const proposal = proposalFrom(input)
      if (typeof proposal === 'string') return refused('invalid_proposal', proposal)

      const outcome = await session.propose(proposal, {
        proposedBy: agentActorFor(clientNameOf(context)),
        rationale: input.rationale,
      })
      if (!outcome.ok) return refused(outcome.refusal.code, outcome.refusal.message)

      const { suggestion } = outcome
      if (canAskLearner(server)) return askLearner(session, suggestion, codec, context)
      return result(
        `Kept as pending suggestion ${suggestion.id}. It changes nothing until the learner accepts it; ` +
          `do not tell them it has been recorded.`,
        { status: 'pending', suggestion },
      )
    },
  )

  server.registerTool(
    'distill',
    {
      title: 'Distil learning material into suggestions',
      description:
        'Hand Episteme a stretch of learning material or a learning dialogue, and optionally your own reading of it as candidates. Episteme keeps the text, checks every quote against it, and turns what passes the domain’s checks (questions, claims, evidence, terms, how they relate, and what the learner said about their own understanding) into pending suggestions, each with the words it came from. A verified quote only shows the words are in the text you sent. Nothing is recorded: the learner decides on each in their review queue, and is not asked here. Do not tell the learner anything was recorded.',
      inputSchema: DISTILL_INPUT,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input, context) => {
      const { title, text, candidates, learner, hostSession, submissionId } = input
      // Who asked is recorded for provenance. With candidates, the asking agent's model did the reading and
      // proposes what is kept; without them, Episteme's distiller does.
      const outcome = await session.distill(title === undefined ? { text } : { title, text }, {
        requestedBy: agentActorFor(clientNameOf(context)),
        ...(learner === undefined ? {} : { learner }),
        ...(candidates === undefined
          ? {}
          : {
              host: {
                candidates,
                ...(hostSession === undefined ? {} : { hostSession }),
                ...(submissionId === undefined ? {} : { submissionId }),
              },
            }),
      })
      if (!outcome.ok) return refused(outcome.refusal.code, outcome.refusal.message)
      return result(describeDistilled(outcome), {
        status: outcome.status,
        reader: outcome.reader,
        sourceId: outcome.sourceId,
        episodes: outcome.episodes,
        suggestions: outcome.suggestions.map((suggestion) => ({
          id: suggestion.id,
          proposal: suggestion.proposal,
          excerpt: suggestion.origin?.excerpt,
          ...(suggestion.origin?.speaker === undefined
            ? {}
            : { speaker: suggestion.origin.speaker }),
          ...(suggestion.basis === undefined ? {} : { basis: suggestion.basis }),
        })),
        refused: outcome.refused.map(({ ref, code, message, existingNodeId }) => ({
          ref,
          code,
          message,
          ...(existingNodeId === undefined ? {} : { existingNodeId }),
        })),
        ...(outcome.receipt === undefined ? {} : { receipt: outcome.receipt }),
      })
    },
  )

  server.registerTool(
    'reflect',
    {
      title: 'Reflect the learner’s understanding back',
      description:
        'What this learner has recorded so far, grouped by what needs attention next (an open conflict, shaky ground, something believed but not yet explainable) and what is settled, plus how many of your suggestions are still pending. Changes nothing.',
      inputSchema: REFLECT_INPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => {
      const progress = session.progress()
      const pending = session.pendingSuggestions().length
      return result(describeProgress(progress, pending), {
        progress,
        pendingSuggestions: pending,
      })
    },
  )

  return server
}

/**
 * Turns the flat tool input into one proposal kind, or says which field is missing.
 *
 * The input schema is one flat object rather than a union, because a union at the top of a tool schema is
 * not accepted by every host. The cost is that "which fields belong to which kind" is checked here.
 */
function proposalFrom(input: ProposeInput): Proposal | string {
  const need = (fields: readonly (keyof ProposeInput)[]): string | undefined => {
    const missing = fields.filter((field) => {
      const value = input[field]
      return typeof value !== 'string' || value.trim() === ''
    })
    return missing.length === 0 ? undefined : `${input.kind} needs ${missing.join(', ')}`
  }

  switch (input.kind) {
    case 'claim':
      return (
        need(['label']) ?? {
          kind: 'claim',
          label: input.label ?? '',
          ...(input.about === undefined ? {} : { about: input.about }),
        }
      )
    case 'link':
      return (
        need(['from', 'to', 'relation']) ?? {
          kind: 'link',
          from: input.from ?? '',
          to: input.to ?? '',
          relation: input.relation ?? '',
        }
      )
    case 'state':
      return (
        need(['target', 'dimension', 'level']) ?? {
          kind: 'state',
          target: input.target ?? '',
          dimension: input.dimension ?? '',
          level: input.level ?? '',
        }
      )
  }
}

function describeRecall(recalled: RecallResult): string {
  if (recalled.known.length === 0 && recalled.ranked.length === 0) {
    return 'Nothing in this learner’s graph bears on that question yet. Establish the ground; there is nothing recorded to build on.'
  }

  const lines: string[] = []
  if (recalled.known.length === 0) {
    lines.push('The learner has recorded nothing about the retrieved items yet.')
  } else {
    lines.push('What the learner has recorded:')
    for (const entry of recalled.known) {
      const levels = entry.dimensions.map((dimension) => `${dimension.id}=${dimension.level}`)
      const standing =
        entry.openConflicts.length > 0
          ? 'OPEN CONFLICT: do not build on it'
          : entry.settled
            ? 'settled: build on it'
            : 'not settled'
      lines.push(`- ${entry.label} [${entry.nodeId}] ${levels.join(', ')} (${standing})`)
    }
  }

  lines.push('', 'Retrieved, most relevant first:')
  for (const entry of recalled.ranked) {
    const reasons = entry.reasons
      .filter((reason) => reason.contribution > 0)
      .map((reason) => `${reason.signal} ${(reason.share * 100).toFixed(0)}%`)
    lines.push(
      `- ${entry.label} [${entry.nodeId}] score ${entry.score.toFixed(2)}${reasons.length === 0 ? '' : ` (${reasons.join(', ')})`}`,
    )
  }
  return lines.join('\n')
}

function describeDistilled(outcome: Extract<DistillOutcome, { ok: true }>): string {
  if (outcome.status === 'duplicate_submission') {
    const pending = outcome.receipt?.kept.filter((entry) => entry.status === 'pending').length ?? 0
    return (
      `This submission was already made${outcome.receipt === undefined ? '' : ` (${outcome.receipt.submissionId})`}; nothing was changed or queued again. ` +
      `${pending} of its suggestion(s) still wait in the learner’s review queue; the receipt says what became of each.`
    )
  }
  return (
    `Distilled ${outcome.episodes} episode(s) into ${outcome.suggestions.length} pending suggestion(s)` +
    (outcome.refused.length > 0
      ? `; ${outcome.refused.length} candidate(s) did not pass the checks`
      : '') +
    '. They wait in the learner’s review queue. Nothing has been recorded.'
  )
}

function describeProgress(progress: ProgressSummary, pending: number): string {
  const lines = [
    `The learner has recorded understanding of ${progress.touched} of ${progress.totalNodes} nodes; ${progress.settled} settled, ${progress.withOpenConflict} with an open conflict.`,
  ]
  for (const item of progress.items) {
    lines.push(`- [${item.attention}] ${item.label} [${item.nodeId}]`)
  }
  lines.push(`${pending} suggestion(s) pending the learner’s decision.`)
  return lines.join('\n')
}

function result(text: string, structured: object): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
  }
}

/** A refusal is a normal answer to an agent, not a protocol error: it says what to change. */
function refused(code: string, message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: `Refused (${code}): ${message}` }],
    structuredContent: { status: 'refused', code, message },
    isError: true,
  }
}
