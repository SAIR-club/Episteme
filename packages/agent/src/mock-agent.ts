import type { StateValue } from '@episteme/core'
import type {
  AgentContext,
  AgentInput,
  AgentResponse,
  AgentWorkspace,
  CognitiveAgent,
  Suggestion,
  StateChangeSuggestion,
} from './types.js'

/**
 * A responder consulted before the default one.
 *
 * The default is deliberately generic so the package stays domain-agnostic; a caller with
 * domain knowledge — the Learn scene, say — supplies its own wording here.
 */
export type MockResponder = (input: AgentInput, context: AgentContext) => AgentResponse | undefined

/**
 * A scripted agent used to prove the loop before any model is connected.
 *
 * Phase 0's job is to show that stored understanding *changes the next response*. A real
 * LLM would make that claim unverifiable — the model might have produced the same answer
 * anyway. This agent answers from the context it was handed, so the test can hold
 * everything else fixed and vary only the history.
 */
export interface ScriptedSuggestion {
  readonly forState?: Readonly<Record<string, StateValue>>
  readonly suggestions: readonly Suggestion[]
  readonly note?: string
}

export interface MockAgentOptions {
  readonly id?: string
  readonly script?: readonly ScriptedSuggestion[]
  /**
   * Unconditional answers by capability. Consulted when no scripted rule matches.
   */
  readonly fallback?: Partial<Record<Capability, readonly Suggestion[]>>
  /** Domain-aware wording for `respond`; takes precedence over the default. */
  readonly responder?: MockResponder
}

export type Capability =
  | 'respond'
  | 'suggestStructure'
  | 'suggestStateChange'
  | 'suggestConnections'

export interface AgentInvocation {
  readonly capability: Capability
  readonly input: AgentInput
  readonly context: AgentContext
  readonly workspace: AgentWorkspace
}

/**
 * Records every input and context it was given.
 *
 * The recorded invocations are the evidence for the critical test: they show that the
 * agent's input carried the stored cognitive state rather than it being reconstructed after
 * the fact.
 */
export class MockCognitiveAgent implements CognitiveAgent {
  readonly id: string
  readonly description = 'Scripted agent used to verify the cognitive loop without an LLM.'

  readonly #script: readonly ScriptedSuggestion[]
  readonly #fallback: Partial<Record<Capability, readonly Suggestion[]>>
  readonly #responder: MockResponder | undefined
  readonly #invocations: AgentInvocation[] = []

  constructor(options: MockAgentOptions = {}) {
    this.id = options.id ?? 'mock-agent'
    this.#script = options.script ?? []
    this.#fallback = options.fallback ?? {}
    this.#responder = options.responder
  }

  /**
   * Answers, and records what it was told.
   *
   * The default answer is *not* a template with a slot filled in: it changes its structure
   * depending on whether prior understanding exists at all. That is the honest shape of the
   * claim under test — with no recorded context the agent has to start by explaining the
   * foundation, and with it the agent can begin from what the human already holds. A caller
   * with domain wording supplies a `responder` instead.
   */
  respond(input: AgentInput, context: AgentContext): Promise<AgentResponse> {
    this.#record('respond', input, context)

    const custom = this.#responder?.(input, context)
    if (custom !== undefined) return Promise.resolve(custom)

    const summary = context.summary?.trim() ?? ''
    if (summary === '') {
      return Promise.resolve({
        text: `Let's establish the basics first: ${input.text}`,
        usedContext: false,
      })
    }

    return Promise.resolve({
      text: `Starting from what you already understand (${summary}): ${input.text}`,
      usedContext: true,
      contextSummary: summary,
    })
  }

  get invocations(): readonly AgentInvocation[] {
    return this.#invocations
  }

  /** The most recent workspace the agent saw, for assertions in tests. */
  get lastWorkspace(): AgentWorkspace | undefined {
    return this.#invocations[this.#invocations.length - 1]?.workspace
  }

  suggestStructure(workspace: AgentWorkspace): Promise<readonly Suggestion[]> {
    return this.#suggest('suggestStructure', workspace)
  }

  suggestStateChange(workspace: AgentWorkspace): Promise<readonly Suggestion[]> {
    return this.#suggest('suggestStateChange', workspace)
  }

  suggestConnections(workspace: AgentWorkspace): Promise<readonly Suggestion[]> {
    return this.#suggest('suggestConnections', workspace)
  }

  #suggest(capability: Capability, workspace: AgentWorkspace): Promise<readonly Suggestion[]> {
    this.#record(
      capability,
      { text: capability },
      { summary: describeWorkspace(workspace) },
      workspace,
    )

    const matched = this.#script.find((rule) => matchesState(rule.forState, workspace.state))
    if (matched !== undefined) return Promise.resolve(matched.suggestions)

    return Promise.resolve(this.#fallback[capability] ?? [])
  }

  #record(
    capability: Capability,
    input: AgentInput,
    context: AgentContext,
    workspace: AgentWorkspace = { actorId: '', nodeIds: [], state: {} },
  ): void {
    this.#invocations.push({ capability, input, context, workspace })
  }
}

/**
 * Whether a scripted rule's preconditions hold for the current state.
 *
 * A rule with no precondition always matches, which is how a caller provides a default
 * answer for a capability that does not depend on history.
 */
function matchesState(
  required: Readonly<Record<string, StateValue>> | undefined,
  actual: Readonly<Record<string, StateValue>>,
): boolean {
  if (required === undefined) return true
  return Object.entries(required).every(([dimension, expected]) => {
    const current = actual[dimension]
    if (current === undefined) return false
    if (expected.level !== undefined && current.level !== expected.level) return false
    if (expected.scalar !== undefined && current.scalar !== expected.scalar) return false
    return true
  })
}

/**
 * Renders a workspace as a short human-readable summary.
 *
 * Used by the demo to show, side by side, that the *input* to the agent differed. Without
 * that visibility a changed answer would look like luck.
 */
export function describeWorkspace(workspace: AgentWorkspace): string {
  const state = Object.entries(workspace.state)
    .map(([dimension, value]) => `${dimension}=${value.level ?? value.scalar ?? '?'}`)
    .sort()
    .join(', ')
  return state === '' ? '(no recorded state)' : state
}

/** The state-change candidate a mock agent produces, as a typed convenience. */
export function stateChange(
  target: string,
  actorId: string,
  dimensions: Readonly<Record<string, StateValue>>,
  rationale: string,
  evidence: readonly string[] = [],
): StateChangeSuggestion {
  return { kind: 'state', target, actorId, dimensions, evidence, rationale }
}

export function createMockAgent(options: MockAgentOptions = {}): MockCognitiveAgent {
  return new MockCognitiveAgent(options)
}
