# Roadmap

The plan from here. What is _built_ is described by [`README.md`](../../README.md) and proven by the tests;
this file records what comes next and why, and is rewritten when the direction changes rather than appended
to.

## Where things stand

Each phase proved one claim, and each claim is held by tests rather than by narrative:

| phase | claim                                                           | proven by                                                                      |
| ----- | --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 0     | understanding changes, and the change affects the next answer   | `tests/northstar.test.ts`, `tests/critical-loop.test.ts`                       |
| 1     | understanding survives a process restart                        | `tests/restart-recovery.test.ts`, `tests/persistence-integrity.test.ts`        |
| 2     | a paraphrased question reaches stored cognition                 | `tests/paraphrase-critical-loop.test.ts`, `tests/retrieval-evaluation.test.ts` |
| —     | a learner can use the loop, in Chinese or English, on any topic | `apps/learn`, `tests/learn-*.test.ts`                                          |
| —     | retrieval stays correct among hundreds of unrelated nodes       | `tests/retrieval-at-scale.test.ts`                                             |

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

## Phase 3 — Episteme as an MCP server

The question this phase answers:

> Does the loop still hold when the agent is someone else's real model, asking real questions?

The design is [ADR 0008](../decisions/0008-agent-plugin-surface.md). In short: one local process owns a
learner's graph and serves both the Learn surface and an MCP endpoint. Agents can only `recall`, `propose` and
`reflect`, and nothing they send changes cognitive state. A proposal is a draft held outside the
graph until the human accepts it, either through MCP elicitation or through the review queue on the Learn
surface. There is no confirm tool. It adds no Core behaviour.

Still open:

- **Vocabulary across agents.** The Learn pack is topic-independent already; whether one pack is enough for
  the questions agents will actually bring, or the tools need a scene parameter, is answered by using it, not
  in advance.
- **A real embedding provider.** The deterministic adapter is a test double. A host-attached server meets
  arbitrary phrasing, so `SEMANTIC_MATCH_THRESHOLD` has to be recalibrated against a real model's similarity
  distribution ([retrieval.md](../architecture/retrieval.md)).

The first slice adds one dependency, `@modelcontextprotocol/server`, in its own commit. The stdio shim, and
with it `@modelcontextprotocol/client`, follows only when a target host needs stdio. The details are in
ADR 0008's Consequences.

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
