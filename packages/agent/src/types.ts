import type { StateValue } from '@episteme/core'

/**
 * The read-only view an agent is allowed to reason over.
 *
 * An agent sees a *projection* of the actor's graph plus their current cognitive state —
 * never the raw store. That boundary is what keeps "AI advises" from becoming "AI
 * writes", and it is why the agent package depends on Core types rather than storage.
 */
export interface AgentWorkspace {
  /** Id of the human this workspace belongs to. */
  readonly actorId: string
  /** Nodes the agent may see, already filtered by projection rules. */
  readonly nodeIds: readonly string[]
  /** Current understanding of a node, as `dimension → value`. */
  readonly state: Readonly<Record<string, StateValue>>
  /** Recent reasoning, oldest first, for models that need narrative context. */
  readonly notes?: readonly string[]
  /**
   * The passage being distilled, when the agent is asked to read material (ADR 0009).
   *
   * The passage is input to reason over, never something to store: it stays outside the graph, and whatever
   * the agent suggests from it is only a suggestion.
   */
  readonly material?: AgentMaterial
  /** Nodes the human already has, so a passage's words can be matched to them instead of duplicated. */
  readonly known?: readonly KnownNode[]
  /**
   * Nodes suggested earlier for this same passage, which later suggestions may refer to as `cand:<ref>`.
   *
   * They exist only as suggestions. A reference to one resolves only if a human accepts it.
   */
  readonly candidates?: readonly CandidateNode[]
}

export interface AgentMaterial {
  readonly sourceId: string
  readonly episodeId: string
  readonly text: string
  /** Where the passage sits in the source, as character offsets. */
  readonly span: { readonly start: number; readonly end: number }
  /** The passage's time range in the source, in seconds, when the source had timestamps. */
  readonly time?: { readonly from: number; readonly to: number }
}

export interface KnownNode {
  readonly id: string
  readonly label: string
  readonly type: string
}

export interface CandidateNode {
  readonly ref: string
  readonly nodeType: string
  readonly label: string
  /** The passage it was found in, so an agent can tell this passage's candidates from earlier ones. */
  readonly episodeId?: string
  /**
   * The name the reader gave the node (`NodeSuggestion.ref`), so a reader can find the engine's reference for a
   * node it suggested in an earlier passage instead of constructing one (ADR 0011).
   */
  readonly localRef?: string
}

/** How a suggestion names a candidate of the same passage instead of an existing node. */
export const CANDIDATE_PREFIX = 'cand:'

/**
 * Where a suggestion's quote is: in which passage, and which of its occurrences there (ADR 0011).
 *
 * Without it, the quote is looked for in the passage being read, and must occur there once.
 */
export interface QuoteAt {
  readonly episodeId: string
  /** 1-based, among the quote's occurrences in that passage, overlapping ones included. */
  readonly occurrence?: number
}

/**
 * What a suggestion's quote is, as evidence (ADR 0011).
 *
 * - `stated`: the quoted words are in a turn of the learner. It says the learner said those words, nothing more.
 *   It does not say that the suggestion is what the learner meant by them.
 * - `inferred`: the suggestion is a reading of what was said, by whichever reader made it.
 *
 * Neither basis proves that the learner has mastered anything, and the learner's acceptance does not either.
 */
export type Basis = 'stated' | 'inferred'

/**
 * What an agent is told about the human before it answers.
 *
 * Opened up from a bare workspace because the *reason* an answer differs has to be visible:
 * `summary` is a readable rendering of prior understanding, so a demo or a test can show that
 * the agent was told something, rather than inferring it from a changed string.
 */
export interface AgentContext {
  /** Readable rendering of what the human already understands, e.g. `confidence=high`. */
  readonly summary?: string
  /** Node ids the retrieval considered relevant to this input. */
  readonly nodeIds?: readonly string[]
  /** Domain-specific detail, opaque to this package on purpose. */
  readonly detail?: Readonly<Record<string, unknown>>
}

export interface AgentInput {
  readonly text: string
  /** Where the input came from, e.g. `session:2`. */
  readonly source?: string
}

export interface AgentResponse {
  readonly text: string
  /**
   * Whether the answer was shaped by recorded prior understanding.
   *
   * Recorded explicitly rather than guessed from the text, so the critical claim — "the
   * response changed *because* of stored state" — is an assertion about data, not prose.
   */
  readonly usedContext: boolean
  /** The context the answer was conditioned on, echoed back for inspection. */
  readonly contextSummary?: string
  readonly suggestions?: readonly Suggestion[]
}

/**
 * A node the agent proposes, subject to human confirmation.
 */
export interface NodeSuggestion {
  readonly kind: 'node'
  readonly nodeType: string
  readonly label: string
  readonly properties?: Readonly<Record<string, unknown>>
  readonly tags?: readonly string[]
  readonly anchors?: readonly string[]
  readonly rationale: string
  /** A name other suggestions of the same passage can use for this node, as `cand:<ref>`. */
  readonly ref?: string
  /** The words of the material this suggestion rests on, verbatim. */
  readonly quote?: string
  readonly quoteAt?: QuoteAt
  readonly basis?: Basis
}

/** An edge the agent proposes. Either end may be an existing node id or `cand:<ref>`. */
export interface EdgeSuggestion {
  readonly kind: 'edge'
  readonly edgeType: string
  readonly from: string
  readonly to: string
  readonly rationale: string
  /** The reader's own name for it, given back with the result so the reader can tell what became of it. */
  readonly ref?: string
  readonly quote?: string
  readonly quoteAt?: QuoteAt
  readonly basis?: Basis
}

/**
 * A change to the human's understanding that the agent *infers*.
 *
 * The evidence field is not decoration: the confirmation UI has to be able to show the
 * human why the agent thinks their understanding moved, and the human must be able to
 * accept, modify, ignore or inspect it.
 */
export interface StateChangeSuggestion {
  readonly kind: 'state'
  /** An existing node id or `cand:<ref>`. */
  readonly target: string
  readonly actorId: string
  readonly dimensions: Readonly<Record<string, StateValue>>
  readonly evidence: readonly string[]
  readonly rationale: string
  /** The reader's own name for it, given back with the result so the reader can tell what became of it. */
  readonly ref?: string
  readonly quote?: string
  readonly quoteAt?: QuoteAt
  readonly basis?: Basis
}

export type Suggestion = NodeSuggestion | EdgeSuggestion | StateChangeSuggestion

/**
 * A proposal together with its current standing.
 *
 * Agents can only ever produce `suggested`. A suggestion that validation refuses keeps
 * its refusal instead of disappearing, so a human can see what was proposed and why it
 * was not accepted.
 */
export interface AgentSuggestion {
  readonly id: string
  readonly status: 'suggested' | 'accepted' | 'rejected'
  readonly suggestion: Suggestion
  readonly refusal?: { readonly code: string; readonly message: string }
}

/**
 * What a cognitive agent is allowed to do.
 *
 * Deliberately narrow. An agent may answer, suggest structure, connections and state
 * changes, and may ask questions — it may never author the human's understanding, decide
 * which side of a conflict is right, or write to the graph directly. Note what is absent:
 * there is no `commit`, no `write` and no `resolveConflict`.
 */
export interface CognitiveAgent {
  readonly id: string
  readonly description: string
  /**
   * Answers an input, conditioned on what the human already understands.
   *
   * The context is the whole point of the interface: an agent that ignored it would be
   * indistinguishable from a stateless chatbot, which is exactly what this project is not.
   */
  respond(input: AgentInput, context: AgentContext): Promise<AgentResponse>
  suggestStructure(workspace: AgentWorkspace): Promise<readonly Suggestion[]>
  suggestStateChange(workspace: AgentWorkspace): Promise<readonly Suggestion[]>
  suggestConnections(workspace: AgentWorkspace): Promise<readonly Suggestion[]>
}

/** Every suggestion an agent produces starts, and normally stays, `suggested`. */
export function suggestion(
  id: string,
  value: Suggestion,
  status: AgentSuggestion['status'] = 'suggested',
): AgentSuggestion {
  return { id, status, suggestion: value }
}

export function isActionable(value: AgentSuggestion): boolean {
  return value.status === 'suggested' && value.refusal === undefined
}
