# Roadmap

The plan from here. What is _built_ is described by [`README.md`](../../README.md) and proven by the tests;
this file records what comes next and why, and is rewritten when the direction changes rather than appended
to.

## Where things stand

Each phase proved one claim, and each claim is held by tests rather than by narrative:

| phase | claim                                                                   | proven by                                                                      |
| ----- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 0     | understanding changes, and the change affects the next answer           | `tests/northstar.test.ts`, `tests/critical-loop.test.ts`                       |
| 1     | understanding survives a process restart                                | `tests/restart-recovery.test.ts`, `tests/persistence-integrity.test.ts`        |
| 2     | a paraphrased question reaches stored cognition                         | `tests/paraphrase-critical-loop.test.ts`, `tests/retrieval-evaluation.test.ts` |
| —     | a learner can use the loop, in Chinese or English, on any topic         | `apps/learn`, `tests/learn-*.test.ts`                                          |
| —     | retrieval stays correct among hundreds of unrelated nodes               | `tests/retrieval-at-scale.test.ts`                                             |
| 3     | an agent can propose; what is kept goes through one human-decision path | `tests/confirmation-flow.test.ts`, `tests/mcp-elicitation.test.ts`             |

The details are in [`PHASE1_REPORT.md`](../../PHASE1_REPORT.md) and [`PHASE2_REPORT.md`](../../PHASE2_REPORT.md).

## The gate, unchanged

Every later phase must keep these three a clear **yes**:

- **A** — "I used to understand it this way, and now I understand it differently."
- **B** — "From that same earlier understanding, I later took two different paths."
- **C** — "Because I understood it this way before, today's answer is different."

If one stops being a clear yes, the answer is to stop adding features rather than add more of them.

## Positioning: a layer agents attach to, not another agent

Episteme is **not an agent**. Agents are plentiful; what none of them has is a durable, inspectable record of
how _the person they are talking to_ understands something — one that survives the session, the tool and the
model. That record is what Episteme is.

So the product surface is a **plugin agents attach to**, starting with an MCP server, rather than an assistant
of our own. The host agent supplies the language model; Episteme supplies the understanding it should build on,
and receives what changed. How much of that a host actually delivers depends on whether and when it calls the
tools. That is measured host by host, not promised in general.

This follows from the existing architecture rather than revising it: Core already runs with no model, the
agent is already behind an interface, and the AI-ownership rule already assumes the AI is not the author. It
also settles one candidate from the previous plan — _connecting our own model provider_ — by removing it: the
model is the host's. `packages/agent` stays as the scripted, deterministic test double the loop's proofs
depend on.

## Phase 3 — Episteme as an MCP host: implemented

The question this phase set out to answer:

> Does the loop still hold when the agent is someone else's real model, asking real questions?

**What is implemented** is the surface that makes the question askable, built to
[ADR 0008](../decisions/0008-agent-plugin-surface.md). One local process owns a learner's graph and serves both
the Learn surface and an MCP endpoint. Agents can only `recall`, `propose` and `reflect`. A proposal is a draft
held outside the graph until the learner decides on it. There is no confirm tool, and Core is unchanged.

**What is not yet established** is the answer itself. The surface is tested against the protocol, in raw
JSON-RPC over a real socket, and not yet against any particular MCP host or model. Being reachable from MCP hosts
is not the same as having an effect: a host that never calls `recall` gets nothing, and how much of the loop a
given host delivers is measured host by host, not assumed (ADR 0008, Consequences).

### Done

| capability                           | where                                                                                                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared application layer             | `@episteme/application`: `LearnSession`, driven by the Learn surfaces and the MCP endpoint                                                                     |
| single-owner graph host and lock     | `@episteme/storage-local`: `<graph>.lock`, `GraphLockedError`, release on close and exit                                                                       |
| pending suggestion draft store       | `<graph>.suggestions.jsonl`, outside the graph and the event log                                                                                               |
| MCP `recall` / `propose` / `reflect` | `@episteme/mcp`, served at `/mcp` by the Learn web host over Streamable HTTP                                                                                   |
| Learn web review queue               | `apps/learn`: accept, modify or dismiss each pending suggestion                                                                                                |
| one human confirmation path          | `LearnSession.decide()`; `confirmedBy` injected by the host, never taken from input                                                                            |
| MCP 2026-07-28 elicitation           | `inputRequired` with an HMAC-sealed `requestState` and schema-validated `inputResponses`; a trusted-host boundary, not proof that a person answered (ADR 0008) |
| provenance                           | every resolved suggestion records the draft, the proposing agent and the channel                                                                               |
| Origin and Host protection           | checked before the SDK sees a request                                                                                                                          |
| end-to-end confirmation tests        | `tests/confirmation-flow.test.ts`, across both channels, the event file and host restarts                                                                      |

### Not done, and deliberately deferred

- **stdio shim.** The endpoint speaks Streamable HTTP only. A host that launches stdio servers cannot connect
  yet; the shim, and with it `@modelcontextprotocol/client`, follows when a target host needs it.
- **Terminal review commands.** Pending suggestions can be decided in the Learn web surface and through an
  agent's host, not in `pnpm learn`.
- **Cognitive Access Control / Scoped Recall.** `recall` is unscoped: any connected client reads all of the
  learner's understanding. See Phase 4.
- **Encryption at rest.** See Phase 4.
- **Authentication and authorization beyond the network boundary.** Any local process can reach the endpoint.
  A client's name is provenance only, and nothing it sends authorizes anything.
- **Host lifecycle and launcher UX.** The host must be started by hand, and the graph cannot be open in two
  surfaces at once.
- **Compatibility with specific MCP hosts.** No real host or model has been run against the endpoint, so
  whether a given host calls the tools at useful moments, and shows the decision form, is unverified.

### Hardening backlog

The Phase 3 self-review found these. None of them blocks merging: each is a known limitation with a
bounded consequence, and each needs its own design before it is built.

- **Atomic batch preview.** Accepting a claim adds the node, then checks its links. If a link is refused, the
  node is revoked, which leaves a revoked node in the history on every failed attempt. A batch that previews
  every mutation before applying any would leave nothing behind. A failed `batch()` (seeding) can also leave
  partial in-memory changes that the next write persists.
- **What "modify" may change.** A modification may change a proposal's target, endpoints or dimension, not
  only its value. The result is still recorded as coming from the suggestion. Whether modify should be limited
  to the value is a decision semantics question.
- **A storage port for drafts.** `SuggestionStore` does its own file I/O inside the application layer. That
  ties drafts to the local JSONL adapter and keeps them outside ADR 0003's storage abstraction.
- **Splitting `LearnSession`.** It carries retrieval, recording, node creation, proposals, decisions,
  recovery, persistence and lifecycle. It needs dividing before a second scene uses it. The MCP surface also
  depends on Learn's recordable dimensions.
- **A stale lock that tells the truth.** The lock records only a pid. After a reboot, a reused pid can make a
  stale lock look held by a running process. Recording the hostname and the process start time would tell
  the two apart.
- **stdio shim**, for hosts that only launch stdio servers.
- **Cognitive Access Control / Scoped Recall**, the follow-up ADR (Phase 4).

Still open, and answered by using it rather than in advance:

- **Vocabulary across agents.** The Learn pack is topic-independent already; whether one pack is enough for
  the questions agents will actually bring, or the tools need a scene parameter, is answered by using it, not
  in advance.
- **A real embedding provider.** The deterministic adapter is a test double. A host-attached server meets
  arbitrary phrasing, so `SEMANTIC_MATCH_THRESHOLD` has to be recalibrated against a real model's similarity
  distribution ([retrieval.md](../architecture/retrieval.md)).

## Distillation — minimal loop: implemented

Built to [ADR 0009](../decisions/0009-distillation.md): learning material or a learning dialogue goes in, is
split into episodes, and is read by a distiller. The result is candidate questions, claims, evidence and terms,
how they relate, and what the learner said about their own understanding. All of it becomes pending
suggestions, each with the words it came from. The learner accepts, modifies or dismisses each through the one
decision path, and only that reaches the graph and the history. Entry points are the application, the Learn
surface (_导入学习材料_) and the MCP `distill` tool, which feeds the review queue only.
`pnpm demo:distill` and `tests/distillation-loop.test.ts` take a real fragment through the whole loop.

Not done, deliberately:

- **A model-backed distiller.** The first is rule-based: deterministic, Chinese and English, and modest in what
  it finds. A model-backed `CognitiveAgent` replaces it behind the same interface.
- **Dismissing what depends on a dismissed suggestion.** Such suggestions stay in the queue, refused as
  `unresolved_candidate` if accepted, until the learner dismisses them too.
- **Thoughts.** Distillation never suggests one. A thought is what the learner organises.
- **Policies for other subjects.** Only the Learn policy exists. Another Domain Pack can add its own.

## Phase 4 — privacy before other people's understanding arrives

Attaching to arbitrary agents means personal understanding is read by tools Episteme does not control. Before
anyone other than the author uses it:

- **encryption at rest** — the JSONL file is plain text, the oldest unfixed debt;
- **Cognitive Access Control / Scoped Recall**, a follow-up ADR to 0008. It decides which agent may recall
  what, so that "private by default" is enforced rather than expressed. `Actor.shareByDefault` and per-actor
  state exist, but nothing checks them at a boundary, and under ADR 0008 `recall` is unscoped. It must be
  accepted before anyone other than the graph's author uses the MCP surface;
- **embeddings treated as personal data**, including what leaves the machine when a remote provider is used.

## Phase 5 — the second scene

`domain-forum`, reusing `concept`, `question`, `claim` and `thought` verbatim. It is the real test of "one
graph, many views", and the first time Core's boundary is pressed by something other than Learn. See
[`packages/domain-forum`](../../packages/domain-forum/README.md).

## Engineering

- **CI** — `.github/workflows/ci.yml` runs `pnpm check` and `pnpm format:check` on the declared Node floor
  and the current LTS.
- **Releases** — not yet: release tooling, a changelog and versioning follow the rules in
  [`AGENTS.md`](../../AGENTS.md#version-management), and are proposed before they are added.

## Explicitly out of scope for now

Scope creep is the main risk to this project:

```text
an agent of our own            multi-agent systems
recommendation engines         automatic curriculum generation
reputation ranking             leaderboards
semantic automatic merge       AI truth oracles
automatic knowledge-graph generation   federation
institutional deployment       payments
complex governance             educational-effect experiments
full Lean integration
```

Formalisation stays a placeholder until something depends on it, starting with Datalog rather than Lean. See
[`packages/logic-bridge`](../../packages/logic-bridge/README.md).

## How to add a slice

Write the ADR first if the change touches Core's boundary, the event model, or any invariant listed in
[`AGENTS.md`](../../AGENTS.md). Otherwise: understand, design, document, implement the minimum slice, test,
refactor, continue.
