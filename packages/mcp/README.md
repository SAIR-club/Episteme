# @episteme/mcp

The MCP surface of an Episteme host. It lets an agent `recall`, `propose`, `reflect` and `distill` over one
learner's graph, and nothing else. See [ADR 0008](../../docs/decisions/0008-agent-plugin-surface.md).

It is a package rather than an app because the host that serves it is the same process that serves the Learn
surface. That process owns the graph file, and no app depends on another app.

## Connecting

`pnpm learn:web` starts the host and prints the endpoint, by default `http://127.0.0.1:4321/mcp`. Point an MCP
host that speaks Streamable HTTP at that URL. There is no stdio shim yet. While the host runs, it owns the
graph, so the terminal surface cannot open the same file.

## Tools

| tool      | what it does                                                                                                     | changes anything |
| --------- | ---------------------------------------------------------------------------------------------------------------- | ---------------- |
| `recall`  | the learner's prior understanding relevant to a question, with why each item was retrieved                       | no               |
| `propose` | keeps a claim, a link or a state change as a pending suggestion, or refuses it with the reason                   | no               |
| `reflect` | what the learner has recorded, grouped by what needs attention next, and how many are pending                    | no               |
| `distill` | distils learning material with Episteme's own distiller into pending suggestions, each with its words (ADR 0009) | no               |

There is no tool that confirms a suggestion and none that writes a node, an edge or a state event. An agent
that could confirm would be confirming itself. A suggestion is accepted through the one human-decision path,
from the Learn review queue or from an elicitation form answered in the host. See _Trust_ below for what each
of these can and cannot guarantee.

Every result carries the same data twice: as text addressed to the agent, and as `structuredContent`.

`distill` never asks the learner through the host, even one that could show a form. A single distillation yields
many suggestions, and they wait in the review queue. The client that asked is recorded as `requestedBy`, for
provenance only. Material is limited to 20,000 characters, and the queue to 500 pending suggestions.

## Asking the learner

If the client declared that it can show the user a form (`elicitation`), `propose` asks the learner right
away, using the multi-round-trip model of MCP 2026-07-28 (ADR 0008):

1. `propose` keeps the draft and returns `input_required`. The result carries a form offering accept, modify
   or dismiss, plus the one field a modification of this kind changes, and a `requestState` naming the draft.
2. The host shows the form to the user and retries the original call, with the answer in `inputResponses`.
3. The retry hands the answer to `LearnSession.decide()`, the same path the Learn review queue uses.

Both values that come back are treated as untrusted. `requestState` is sealed with an HMAC under a key held
only by the host process, expires after fifteen minutes, and is bound to the method. A forged or expired
state is rejected before the tool runs. The draft comes from that state, never from the retried arguments.
`inputResponses` is validated against the schema the form was built from. Content that fails it, and a
declined or cancelled form, are not decisions, and the draft stays in the review queue.

A client that declared no such capability is not asked, and gets a pending draft. That includes 2025-era
clients over this host's stateless HTTP leg, which cannot carry the request. Over a connection that can carry
it, the SDK's legacy shim serves the same result as a 2025-style elicitation, so there is one implementation.

## Trust

The two ways a suggestion gets decided offer different guarantees (ADR 0008, _Trust boundaries_).

- **The Learn review queue** is the human-decision channel Episteme controls. No MCP tool can reach it.
- **Elicitation is a trusted-host boundary.** Episteme verifies that a retry carries state it sealed and an
  answer that fits its form. It cannot verify that a person gave the answer: any process that speaks MCP can
  declare the capability and answer its own form.

On both channels, nothing a client sends can name who confirmed. That is always the session's own human.
Until authentication exists, rely on an elicitation confirmation only in a single-user, local setup with MCP
clients you trust.

## Identity

Each proposal is attributed to `actor_agent_<client name>`, taken from the client information the request
carries. A client that sends none, as a 2025-era client served statelessly does, is recorded as
`actor_agent_unidentified` rather than given an invented name. The name is self-declared. It is provenance,
not authentication.

## The network boundary

The Learn host serves this endpoint and its own pages behind one boundary (`boundaryRefusal` in
`apps/learn/src/server.ts`). It binds to `127.0.0.1`, and it refuses a request in any of these cases:

- `Host` is not a loopback name with the host's port.
- `Origin` is present and is not the host's own origin.
- `Sec-Fetch-Site` marks the request as coming from another site.
- The request changes something and is not sent as `application/json`.

The endpoint also repeats the SDK's Host and Origin checks before the SDK sees a request. Without these checks, a
web page could reach the surface through DNS rebinding or a cross-site POST. That is a network boundary, not
authorization: any local process can still connect, and `recall` is unscoped until the follow-up ADR on scoped
recall is accepted.

## Dependencies

Only `@modelcontextprotocol/server` (v2), whose runtime dependencies are `@modelcontextprotocol/core` and
`zod`. `node:http` is bridged to web-standard `Request`/`Response` in `src/endpoint.ts` instead of through
`@modelcontextprotocol/node`, which would bring in `hono`. `@modelcontextprotocol/client` arrives with the
stdio shim, if one is ever built. The v1 `@modelcontextprotocol/sdk` is not used.

## Layout

| File              | Contents                                                              |
| ----------------- | --------------------------------------------------------------------- |
| `src/server.ts`   | the three tools, their input schemas and the agent identity           |
| `src/confirm.ts`  | the decision form, the sealed state, and reading the learner's answer |
| `src/endpoint.ts` | the HTTP endpoint: Host and Origin checks, `node:http` bridge         |
