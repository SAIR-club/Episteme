/**
 * The MCP surface of an Episteme host: what an agent may do with one learner's graph.
 *
 * See ADR 0008. An agent can recall, propose and reflect. It cannot confirm, and it cannot write nodes,
 * edges or state events.
 */
export { createMcpEndpoint, type McpEndpoint, type McpEndpointOptions } from './endpoint.js'
export {
  agentActorFor,
  assertSceneToolNames,
  BUILT_IN_TOOLS,
  createEpistemeMcpServer,
  type McpAccess,
  type McpCaller,
  type SceneTool,
  type SceneToolAnswer,
  type SceneToolContext,
} from './server.js'
