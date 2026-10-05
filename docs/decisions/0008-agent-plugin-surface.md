# 0008 — Episteme as a plugin for other agents

Status: **accepted** (2026-10-05). Nothing below is built yet.

## Context

Episteme was built so that it never needed its own model: Core runs without one, the agent sits behind the
`CognitiveAgent` interface, and `packages/agent` is a scripted mock. The plan was to connect a model provider
next. That plan is withdrawn. Agents are plentiful, and an agent of our own would compete with all of them for
a user's attention. What none of them has is a durable, inspectable record of how the person they are talking
to understands something. That record is what Episteme is, so the product is a **surface agents attach to**,
starting with hosts that speak the Model Context Protocol (MCP). The host agent supplies the language model.

Attaching to someone else's agent puts three existing commitments under pressure, and they cannot be decided
one at a time, because the answer to each constrains the others:

1. **Who confirms.** _No agent may write to the graph directly. Everything it infers is `suggested` and needs
   human confirmation._ The guard in `packages/core/src/guards/index.ts` enforces the data half: a `suggested`
   value is refused at commit, and a `confirmed` one must name a registered **human** in `confirmedBy`. It
   cannot enforce the other half: `confirmedBy` is an id supplied by the caller. If the agent can call a tool
   that commits a confirmed value, the agent is confirming itself, and the rule exists only on paper.
2. **Where a suggestion lives until then.** Because the guard refuses `suggested`, a suggestion never enters
   the event log. Something has to hold it between "the agent proposed it" and "the human decided", and that
   place must not become a second graph.
3. **Who writes the file.** `storage-local` loads the file into memory on `open()` and rewrites the whole file
   on `save()` ([ADR 0006](0006-persistence-format.md)). That is correct for one process, and ADR 0006 says so.
   MCP clients usually start one server process each, next to `pnpm learn:web`. Several processes over one file
   do not just overwrite each other's work. Each process also resumes its own id counter from what it loaded,
   so two of them would mint the same `evt_N` for different moments. The collision would be silent, which is
   the failure ADR 0006 was written to prevent.

## Decision

**One local process owns a learner's graph. Agents reach it through MCP and can only read and propose. A human
confirms through a channel the agent cannot answer.**

### One owner per graph file

A single long-running local process (the _Episteme host_) opens the JSONL file and is the only thing that
writes it. It serves:

- the existing Learn web surface, which becomes the place suggestions are reviewed;
- an MCP endpoint over **Streamable HTTP** on `127.0.0.1`;
- a thin **stdio shim** for hosts that only launch stdio servers. The shim forwards to the running host and
  holds no graph of its own. If no host is running, the shim **fails with the exact command that starts one**.
  It never starts a host itself. A launcher, if one is ever wanted, is a separate design.

On `open()` the host takes an exclusive lock file next to the graph. A second process that tries to open the
same file **fails with a message that names the holder**. It does not wait, and it does not fall back to a
private copy, because a fallback is exactly the silent divergence described above. This turns ADR 0006's
single-writer assumption into something that is checked when the file is opened.

The rest of ADR 0006 is unchanged: still one JSONL file, the same records, the same atomic rewrite. Choosing
one owner over many writers is what keeps the persistence format out of this decision.

### What an agent can do

The MCP surface has three tools. None of them mutates cognitive state.

| tool      | effect                                                                                                                     |
| --------- | -------------------------------------------------------------------------------------------------------------------------- |
| `recall`  | the learner's relevant prior understanding for a question, with each candidate's per-signal contributions (as Learn shows) |
| `propose` | a claim, a connection, or a change on one state dimension, recorded as a **pending suggestion**                            |
| `reflect` | what has been understood so far and what needs attention, using the same grouping as Learn's progress view                 |

`reflect` is named for what it does: it reflects the learner's understanding back to the agent. It is not
called `review` because reviewing is what the human does to a suggestion, and the agent must never appear to
do that.

There is deliberately **no confirm tool, and no tool that writes nodes, edges or events directly**. A node the
agent wants to exist is proposed like any other suggestion. This is stricter than Learn's own surface, where
the human types and therefore authors.

Each connected client is registered as an **agent actor**. Its id is derived from the client name it sends
when the MCP session starts, and that actor is recorded as the source of everything it proposes. The client
name is self-declared and proves nothing. It is provenance, not authentication.

### Suggestions are drafts, held outside the graph

A pending suggestion is a **draft** in the sense of _Draft → Thought → Reference_. It stays out of the graph
and out of the event log until a human acts on it. The host keeps drafts in a separate file next to the graph
(`<graph>.suggestions.jsonl`). The file is written by the same owner, and it is disposable by construction:

- **Accept** commits through the ordinary path, `validateMutation`, as `authority: 'confirmed'`.
  `confirmedBy` is the instance's human actor, set by the host and **never read from tool arguments**.
- **Modify** does the same with the human's edited value. Because the human wrote it, it is authored, not
  confirmed.
- **Dismiss** removes the draft. Drafts are not history, so removing one is not a deletion of cognitive
  record. The graph never saw it.

Losing the suggestions file costs pending drafts, never understanding. Corrupting it cannot corrupt the graph.

### Two confirmation channels, both outside the agent's reach

1. **MCP elicitation**, when the client declares support for it. During `propose`, the host asks the client to
   put the suggestion in front of the user and waits for accept, edit or decline. The answer comes from the
   host application's UI, not from the model. If the user accepts or edits, the draft is resolved and committed
   in that same call. If they decline or cancel, the draft stays pending. A cancelled prompt is not a decision.
2. **The review queue** on the local Learn surface. It always exists, and it is the only channel for clients
   without elicitation. `propose` then returns the draft's id, its pending state, and where it can be reviewed.
   An agent can tell the user to go there. It cannot go there itself.

Elicitation trusts the host application to show the prompt to a person. A client that auto-answered would
defeat it, just as a browser extension clicking "accept" would defeat the review page. Episteme cannot prevent
either. It can keep provenance honest: every confirmed event records which channel confirmed it.

## Alternatives

**A confirm tool the agent calls after asking the user in chat.** This is the simplest option and works in
every host. Rejected because the agent would be reporting the user's consent rather than the user giving it,
and an agent that misreads "sure, whatever" commits on its own word. It would bring back the exact back door
the guard was moved into Core to close.

**One server process per client, each opening the file.** This is MCP's default shape and needs no running
host. Rejected because of the id collision described above, and because no locking scheme makes in-memory
graphs in several processes agree with each other without reloading on every read.

**Reload-and-merge on every write, under a file lock.** This keeps per-client processes. Rejected because
Core's graph port is synchronous and loads once ([ADR 0006](0006-persistence-format.md)). Making every write
re-read the world turns the port inside out. It also still needs one id authority, which is the single owner
by another name.

**Store suggestions in the graph file as a new record kind.** One file is simpler. Rejected because it puts
drafts in the store the graph is reduced from. Old readers would then refuse the file because the record kind
is unknown, and a dismissed suggestion would become something that has to be revoked rather than something
that can just be dropped.

**Let the agent author nodes directly and gate only state changes.** Rejected for now. A node the agent
creates still changes what `recall` returns and what Learn shows, so it shapes the learner's view without
their decision. If this proves too strict in use, loosening it is a later, explicit decision. Tightening it
after nodes have accumulated would not be possible.

**Build our own agent around a model provider.** This was the previous plan. It is withdrawn for the reasons
in Context. `packages/agent` stays as the deterministic test double that the loop's proofs depend on.

## Consequences

- Episteme becomes reachable from MCP hosts without depending on any one of them, and nothing in Core
  changes. This is an Application-layer decision. Reads use existing retrieval and projection, and writes use
  the existing validation path.
- Being reachable is not the same as having an effect. MCP offers tools; it cannot make a host call them.
  An agent that never calls `recall` gets nothing from Episteme. Without elicitation, confirmation falls back
  to the review queue. How much of the loop a given host delivers depends on that host. Where it falls short,
  thin host-specific packaging is the remedy, for example a plugin that runs `recall` on every question
  instead of leaving it to the model's judgement. That is decided host by host and measured, not assumed.
- A process has to be running, and that is visible on purpose. The shim does not start one, so process
  lifetime and single ownership stay explicit. The cost is one manual step for the user, and the shim's error
  message names it.
- The "AI suggests, human confirms" rule now holds across a real process boundary, not only inside one
  program. Its remaining weak point, a host that auto-answers elicitations, is named rather than hidden.
- `LearnSession` becomes the use-case layer that both the web surface and the MCP endpoint drive. It moves
  out of `apps/learn` into its own package, and both surfaces depend on that package. No app depends on another
  app.
- An MCP endpoint on localhost can be reached by any local process. It binds to `127.0.0.1` and validates the
  `Origin` header against DNS rebinding, as the MCP transport specification requires. That is a network
  boundary, not authorization.
- **`recall` is unscoped under this decision**: any connected client can read all of the learner's
  understanding. Which agent may recall what is left to a follow-up ADR, **Cognitive Access Control / Scoped
  Recall**. It covers per-client grants, scoping by topic, tag and branch, which actor's state a client may
  see, and how a refusal is shown to the agent. That ADR must be accepted before anyone other than the graph's
  own author uses the MCP surface. It belongs with encryption at rest in Phase 4.
- Agents will phrase questions in ways the deterministic embedding adapter cannot match. A real provider and a
  recalibrated `SEMANTIC_MATCH_THRESHOLD` are prerequisites for this surface to be useful
  ([ADR 0007](0007-semantic-retrieval.md)), though not for it to be correct.
- **Dependencies.** The MCP TypeScript SDK's v2 line is split into separate packages. Episteme adds only what
  each part needs, each in the commit that first uses it:
  - **The host: `@modelcontextprotocol/server` (v2).** Its only runtime dependencies are
    `@modelcontextprotocol/core` and `zod`. It provides `McpServer`, a Streamable HTTP transport over web-standard
    `Request`/`Response`, `Origin` validation and elicitation. Tool inputs are declared as JSON Schema through
    `fromJsonSchema`, so `zod` is not a direct dependency. The host bridges `node:http` to `Request`/`Response`
    itself. The official `@modelcontextprotocol/node` adapter is not used, because it would bring in `hono` and
    `@hono/node-server` to save a few lines.
  - **The shim: `@modelcontextprotocol/client` (v2), and only when the shim is built.** The shim relays
    between two transports: stdio towards the host application (`@modelcontextprotocol/server/stdio`) and
    Streamable HTTP towards the Episteme host. The second needs the client package's
    `StreamableHTTPClientTransport`. Writing that ourselves would mean reimplementing sessions, SSE and
    server-initiated requests such as elicitation. Hosts that connect over HTTP need no shim, so the shim and
    its dependency wait until a target host requires stdio.
  - The single `@modelcontextprotocol/sdk` package is the v1 line and is not used.
