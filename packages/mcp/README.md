# @episteme/mcp

The MCP surface of an Episteme host. It lets an agent `recall`, `propose` and `reflect` over one learner's
graph, and nothing else. See [ADR 0008](../../docs/decisions/0008-agent-plugin-surface.md).

It is a package rather than an app because the host that serves it is the same process that serves the Learn
surface. That process owns the graph file, and no app depends on another app.

## Connecting

`pnpm learn:web` starts the host and prints the endpoint, by default `http://127.0.0.1:4321/mcp`. Point an MCP
host that speaks Streamable HTTP at that URL. There is no stdio shim yet. While the host runs, it owns the
graph, so the terminal surface cannot open the same file.

## Tools

| tool      | what it does                                                                                   | changes anything |
| --------- | ---------------------------------------------------------------------------------------------- | ---------------- |
| `recall`  | the learner's prior understanding relevant to a question, with why each item was retrieved     | no               |
| `propose` | keeps a claim, a link or a state change as a pending suggestion, or refuses it with the reason | no               |
| `reflect` | what the learner has recorded, grouped by what needs attention next, and how many are pending  | no               |

There is no tool that confirms a suggestion and none that writes a node, an edge or a state event. An agent
that could confirm would be confirming itself. Accepting a suggestion is the learner's act, on a channel the
agent cannot answer. That channel is the next round of work (ADR 0008).

Every result carries the same data twice: as text addressed to the agent, and as `structuredContent`.

## Identity

Each proposal is attributed to `actor_agent_<client name>`, taken from the client information the request
carries. A client that sends none, as a 2025-era client served statelessly does, is recorded as
`actor_agent_unidentified` rather than given an invented name. The name is self-declared. It is provenance,
not authentication.

## The network boundary

The endpoint binds to `127.0.0.1` and rejects a request whose `Host` is not a localhost name or whose
`Origin` is a non-local web page, before the SDK sees it. Without both checks, any web page could reach it
through DNS rebinding. That is a network boundary, not authorization: any local process can still connect, and
`recall` is unscoped until the follow-up ADR on scoped recall is accepted.

## Dependencies

Only `@modelcontextprotocol/server` (v2), whose runtime dependencies are `@modelcontextprotocol/core` and
`zod`. `node:http` is bridged to web-standard `Request`/`Response` in `src/endpoint.ts` instead of through
`@modelcontextprotocol/node`, which would bring in `hono`. `@modelcontextprotocol/client` arrives with the
stdio shim, if one is ever built. The v1 `@modelcontextprotocol/sdk` is not used.

## Layout

| File              | Contents                                                      |
| ----------------- | ------------------------------------------------------------- |
| `src/server.ts`   | the three tools, their input schemas and the agent identity   |
| `src/endpoint.ts` | the HTTP endpoint: Host and Origin checks, `node:http` bridge |
