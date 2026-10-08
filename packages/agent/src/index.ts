/**
 * Episteme agent surface.
 *
 * Phase 0 ships the interface and a scripted mock. No real model is connected until the
 * Core + Learn loop is stable, because an agent that cannot be held constant would make
 * the central claim — "the response changed *because* of stored understanding" —
 * impossible to verify.
 */
export {
  MockCognitiveAgent,
  createMockAgent,
  describeWorkspace,
  stateChange,
} from './mock-agent.js'
export type {
  MockAgentOptions,
  MockResponder,
  ScriptedSuggestion,
  AgentInvocation,
  Capability,
} from './mock-agent.js'

export { suggestion, isActionable, CANDIDATE_PREFIX } from './types.js'
export type {
  AgentContext,
  AgentInput,
  AgentResponse,
  AgentWorkspace,
  CognitiveAgent,
  Suggestion,
  NodeSuggestion,
  EdgeSuggestion,
  StateChangeSuggestion,
  AgentSuggestion,
  AgentMaterial,
  KnownNode,
  CandidateNode,
} from './types.js'
