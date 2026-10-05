# @episteme/mcp

The MCP surface of an Episteme host. It lets an agent `recall`, `propose` and `reflect` over one learner's
graph, and nothing else. See [ADR 0008](../../docs/decisions/0008-agent-plugin-surface.md).

It is a package rather than an app because the host that serves it is the same process that serves the Learn
surface. That process owns the graph file, and no app depends on another app.

## Dependencies

Only `@modelcontextprotocol/server` (v2), whose runtime dependencies are `@modelcontextprotocol/core` and
`zod`. `@modelcontextprotocol/client` arrives with the stdio shim, if one is ever built. The v1
`@modelcontextprotocol/sdk` is not used.
