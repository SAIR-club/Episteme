# 0008 — Episteme as a plugin for other agents

Status: **accepted** (2026-10-05). Amended the same day: the confirmation flow follows the multi-round-trip
model of MCP 2026-07-28, and both channels share one decision use case. Amended again: the trust each
confirmation channel can and cannot offer is stated precisely (see _Trust boundaries_). Amended by
[ADR 0010](0010-episteme-service.md): the host is the Episteme service, no longer part of the Learn surface.

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

**One local process owns a learner's graph. Agents reach it through MCP and can only read and propose. A
decision on a proposal enters through one human-decision path. Episteme controls one channel into it, and
trusts the host for the other.**

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

- **Accept** commits the agent's proposed value through the ordinary path, `validateMutation`. A state change is
  committed as `authority: 'confirmed'`. `confirmedBy` is the instance's human actor, injected by the host and
  **never read from tool arguments or any other client input**.
- **Modify** commits the human's edited value instead. Because the human wrote it, it is authored, not
  confirmed.
- **Dismiss** removes the draft and produces no cognitive event. Drafts are not history, so removing one is
  not a deletion of cognitive record. The graph never saw it.

Claims and links have no `authority` field. For them, as for state changes, the committed record's `source`
names the suggestion, the agent that proposed it and the channel that resolved it, so provenance survives
the draft.

Losing the suggestions file costs pending drafts, never understanding. Corrupting it cannot corrupt the graph.

A decision writes two files, and no single write covers both. Before an accepted or modified decision commits
anything, its write-ahead record goes into the suggestions file. The record carries a stable operation id and
the ids the decision will create. After the graph is written, a single write removes the draft and the record
together. A start that finds a record left behind asks the graph whether the change landed. If it did, the
draft is removed. If it did not, the record is dropped and the draft stays pending. Either way the decision
lands at most once. Dismissing touches only the suggestions file, so it needs no record.

### One decision path, two channels

The decision itself (_human decision → resolve the draft → `validateMutation` → graph or event log_) is **one
use case in `@episteme/application`**. Both channels below collect the human's decision and hand it to that use
case. Neither implements accept, modify or dismiss on its own, so the two cannot drift apart, and the
injection of `confirmedBy` exists in exactly one place.

1. **MCP elicitation**, through the multi-round-trip model of the MCP 2026-07-28 revision. `propose` keeps the
   draft. If the client declared the elicitation capability, the tool then returns `inputRequired(...)`: a
   form-mode elicitation that offers accept, modify or dismiss, together with a `requestState` that names the
   draft. The client puts the form in front of the user and retries the original call with the user's answer in
   `inputResponses`. On the retry, the tool hands the decision to the shared use case.
   - `requestState` comes back from the client, so it is attacker-controlled input. It is sealed with an HMAC
     under a key held only by the host process, expires, and is bound to the method. A single process can use
     a per-process key because a single owner serves every round of a flow.
   - `inputResponses` are untrusted input too. They are validated against the same schema the form was built
     from. Content that fails validation is not a decision, and the draft stays pending.
   - A declined or cancelled prompt is not a decision either, and the draft stays pending. Dismissing is an
     explicit choice inside the form.
   - 2025-era connections are served by the SDK's own legacy shim, which fulfils the same `inputRequired`
     result as a server-to-client elicitation where the connection can carry one. Episteme does not keep a
     second confirmation implementation for them. A connection that cannot carry one, such as the stateless
     2025-era HTTP serving this host uses, declares no capabilities. The tool asks only a client that declared
     the capability, so such a client gets a pending draft instead of a failed call.
2. **The review queue** on the local Learn surface. It always exists, and it is the only channel for clients
   without elicitation. `propose` then returns the draft's id and its pending state. An agent can tell the user
   to review it. No MCP tool reaches the queue.

### Trust boundaries

The two channels do not offer the same assurance.

- **The Learn review queue is the human-decision channel Episteme controls.** Episteme serves it, renders the
  suggestion, and receives the decision through its own surface. That surface accepts only same-origin
  requests from a loopback host. No MCP tool can reach it.
- **MCP elicitation is a trusted-host boundary.** Episteme can verify that a retry carries a `requestState` it
  sealed itself and an answer that fits the form it sent. It **cannot** verify that the answer came from a
  person. A host is expected to put the form in front of its user, but from Episteme's side, any process that
  speaks MCP can declare the elicitation capability, call `propose` and retry with an answer of its own. To
  Episteme, that is indistinguishable from a person answering. An agent running inside a trusted host does not
  see the form. A client program can still write the answer itself.

What holds on both channels:

- **No client or agent supplies `confirmedBy`.** The confirming human is the session's own human, injected by
  the application. No tool argument, form answer or request field can name another.
- **Provenance is recorded and is not authority.** Every resolved suggestion records the draft, the proposing
  agent and the channel. A client's name and information are used for that provenance only, never to authorize
  anything.

Until authentication and authorization exist (Phase 4), **a confirmation through MCP elicitation means
something only in a single-user, local environment whose MCP clients the user trusts.** In any other setting,
treat elicitation answers as unverified, and treat the review queue as the only confirmation Episteme itself
stands behind. Restricting which clients may confirm, or requiring the review queue for some decisions, is
deferred to that work.

## Alternatives

**A confirm tool the agent calls after asking the user in chat.** This is the simplest option and works in
every host. Rejected because the agent would be reporting the user's consent rather than the user giving it,
and an agent that misreads "sure, whatever" commits on its own word. It would bring back the exact back door
the guard was moved into Core to close.

**A push-style elicitation alongside the multi-round-trip one.** The 2025 revisions sent `elicitation/create`
from the server mid-call. Keeping that path for older clients would mean two confirmation implementations to
keep equivalent. Rejected because the SDK's legacy shim already serves 2025-era connections from the same
`inputRequired` result, wherever such a connection can carry a server-to-client request at all.

**Each channel resolving drafts itself.** The review queue and the MCP tool could each commit what the human
chose. Rejected because two implementations of accept, modify and dismiss would drift, and the rule that
`confirmedBy` comes only from the host would then have two places to be gotten wrong.

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
- "AI suggests, human confirms" now holds across a real process boundary, within the limits of _Trust
  boundaries_. The structural parts hold everywhere: no tool writes, no input names the confirming human, and
  every decision passes the one path. The rule that a person made the decision holds for the review queue,
  and for elicitation only as far as the host is trusted. Until authentication exists, that limits
  elicitation to single-user, local, trusted-client use.
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
