# Episteme

> **Episteme turns inquiry into persistent, evolving understanding.**
> Episteme 让探索沉淀为可持续演化的理解。

Episteme is open cognitive infrastructure for carrying, organising and evolving _human
understanding_. It is not a chat assistant, a knowledge base, a course generator or a forum.

The problem it addresses is not "how do we let an AI answer faster", but:

> How do we make the understanding produced while exploring a question, learning something,
> discussing it or researching it — structured, kept, branched, corrected, compared and
> reused, so that it keeps shaping how people and AI interact later?

The system's most valuable asset is not a chat log and not course content. It is a
**cognitive graph that keeps evolving**, because a lesson learned, an argument had, a doubt
raised or a position revised can each change that graph.

```text
Question
    ↓
Exploration
    ↓
Understanding
    ↓
State change
    ↓
Persistent cognitive graph
    ↓
Future interaction changes
```

We care less about producing more answers than about making the process of understanding something that can
be recorded, verified, reused and continually corrected.

## What "structured understanding" means

A note, a knowledge base or a RAG index stores **material**: text that may be retrieved later. Episteme stores
what a particular person has come to understand from that material, as structure:

- **units**: concepts, questions, claims and evidence, each with where it came from;
- **relations**: what answers what, what supports or contradicts what, and which claim revises an earlier one;
- **state**: how sure the person is, whether they can explain it, whether it conflicts with something else,
  as separate dimensions rather than one score;
- **history**: every change kept as an event, so "I used to think this, and now I think that" can be read back.

What was submitted to be read, a learning material or an excerpt of a conversation, is kept beside the graph
as a source, never in it. This is not a conversation store: Episteme keeps only the excerpts it was sent, not
whole conversations or their branches. Nothing an agent infers becomes part of
the graph until the person decides on it. The graph records what the person accepted as a description of
their understanding at that time. It does not prove they have mastered anything.

## Status: v0.1.0, a developer preview

v0.1.0, _First Real Learning Loop_, is the first version whose whole loop is built and tested end to end:

```text
Agent A submits candidate understanding, quoting the words it rests on
  → Episteme verifies each quote against the stored source and keeps the source
  → the learner reviews: accepts, modifies or dismisses
  → only what they accept enters the graph
  → Agent B, in another session, recalls it
```

It is a **developer preview**, not a stable release for general users. Automated tests prove the loop with
scripted MCP clients. It has **not yet been tried with a real Claude Code host and a real learner**, and
several protections are still missing; see [Limitations](#limitations-in-v010). The release notes say exactly
what is proven and what is not: [docs/releases/v0.1.0.md](docs/releases/v0.1.0.md).

**`pnpm serve`** starts the Episteme service and a local interface where a learner asks a question in their
own words, sees which of their own prior understanding was retrieved **and why**, records what they now
understand, reviews what agents suggested, and watches what is recalled next change because of it. Agents
reach the same graph over MCP: they can recall, propose and submit readings of material, and never confirm
anything. Everything is written to plain JSONL files and survives closing the process.

![The Learn surface](docs/images/learn-surface.png)

Behind it, three earlier phases of work that each proved one thing:

| phase | claim                                                             | how to see it          |
| ----- | ----------------------------------------------------------------- | ---------------------- |
| 0     | understanding changes and the change affects the next interaction | `pnpm demo`            |
| 1     | understanding survives a process restart                          | `pnpm demo:persistent` |
| 2     | a paraphrased question reaches stored cognition                   | `pnpm demo:semantic`   |

All of it runs with **no database, no model server, no language model and no frontend toolchain**. That is
not an accident of the current state: it is the project's own claim being demonstrated.

## Quick start

```bash
pnpm install
pnpm check              # typecheck + lint + tests
pnpm serve              # use it, in a browser at http://127.0.0.1:4321
# or
pnpm learn              # the same loop in a terminal
# and the phase demos:
pnpm demo && pnpm demo:persistent && pnpm demo:semantic && pnpm demo:distill
```

`pnpm learn --help` and `pnpm serve --help` list the options, including `--file` and `--graph` to choose the
graph.
The default is `~/.episteme/learn.jsonl`, seeded with a demonstration topic. For your own learning, keep a graph
of its own outside the repository and start it empty:

```bash
pnpm serve --graph "$HOME/.episteme/my-topic.jsonl" --blank
```

## Connecting an agent

The service prints its MCP address, by default `http://127.0.0.1:4321/mcp`. Any MCP host that speaks
Streamable HTTP can be pointed at it; there is no stdio shim yet. An agent gets four tools:

| tool      | what it does                                                                                         |
| --------- | ---------------------------------------------------------------------------------------------------- |
| `recall`  | the learner's prior understanding relevant to a question, with why each item was retrieved           |
| `propose` | a claim, a link or a state change, kept as a pending suggestion                                      |
| `reflect` | what the learner has recorded, grouped by what needs attention next                                  |
| `distill` | a stretch of material or dialogue, read by Episteme, or by the host's own model with verified quotes |

None of them confirms anything: MCP offers no confirm tool, and the learner decides in the Workspace the
service serves at `/`. That is a property of the MCP surface only. The REST review API behind the Workspace is
not authenticated, so an agent with shell access could still call it and confirm its own proposal (see
[Limitations](#limitations-in-v010)). For Claude
Code, the command would be the one below, but **it has not been verified against a real Claude Code host yet**:

```bash
claude mcp add --transport http episteme http://127.0.0.1:4321/mcp
```

See [packages/mcp](packages/mcp/README.md) for the tools, the identity an agent is recorded under, and what
verification does and does not show.

## Using it

The loop is:

```text
ask in your own words
  → see which of your own prior understanding was retrieved, and the contribution of each signal
  → record how well you understand one of those things
  → ask again, and see the two answers side by side
```

Before you record anything the answer has to establish the ground. After, it starts from what you said you
understood. The interface shows the change as a comparison rather than asserting it, and shows the scoring
weights so the ranking is checkable rather than authoritative.

You can ask in **Chinese or English**; the seeded topic is bilingual and one graph serves both.

The interface also answers _"what have I understood so far?"_ — grouping everything you have recorded into
what needs attention next (an unresolved conflict, a missing foundation, something you believe but cannot
explain yet) and what is already buildable. See [apps/learn](apps/learn/README.md).

## Layout

```text
episteme/
├── packages/
│   ├── core/               Episteme Core — ontology, graph, state, events, guards, projection, embedding port
│   ├── domain-learn/       Learn domain pack: vocabulary, rules and the retrievers
│   ├── storage-memory/     In-memory GraphStorageAdapter
│   ├── storage-local/      Durable GraphStorageAdapter + event store (append-only JSONL)
│   ├── embeddings-http/    Embedding adapters over HTTP (Ollama, OpenAI-compatible, TEI)
│   ├── sdk/                Composition: the one place the layers are wired in order
│   ├── application/        The use-case layer every surface drives (LearnSession)
│   ├── distillation/       Learning material → episodes → candidate understanding, as suggestions only
│   ├── mcp/                The MCP surface: an agent can recall, propose, reflect and distill, never confirm
│   ├── agent/              CognitiveAgent interface + a scripted mock used as the test double
│   ├── domain-forum/       [placeholder] Forum domain pack
│   └── logic-bridge/       [placeholder] optional formalisation (Lean, Datalog, SMT)
├── apps/
│   ├── service/            The Episteme service: owns the graph, serves MCP, REST and the Workspace
│   └── learn/              The Learn surface: the terminal client and the page served as the Workspace
├── examples/
│   ├── learn-session/      Phase 0: the cognitive loop
│   ├── persistent-session/ Phase 1: the loop across a process restart
│   ├── semantic-session/   Phase 2: a paraphrase reaching stored cognition
│   └── distill-session/    Distillation: a learning dialogue in, only what the learner accepts kept
├── tests/                  Cross-package tests, including the North Star, restart and paraphrase suites
└── docs/                   architecture, concepts, decisions (ADRs), roadmap
```

Only packages that do something exist as code. The rest are documented placeholders rather
than empty shells, so that the intended shape is visible without pretending it is built.

## Architecture in one screen

```text
┌──────────────────────────────────────────────────────────┐
│ Applications        Episteme Learn / Forum / Research     │
│                     UI, interaction, ranking, feeds       │
├──────────────────────────────────────────────────────────┤
│ Domain Extensions   Learn Pack / Forum Pack / Research    │
│                     domain schema, guards, projections    │
├──────────────────────────────────────────────────────────┤
│ Episteme Core       Ontology · Graph · State · Tag        │
│                     Version · Access · Query · Guard      │
│                     Projection                            │
├──────────────────────────────────────────────────────────┤
│ Adapters            Storage · LLM · Embedding · Logic     │
└──────────────────────────────────────────────────────────┘
```

The rule that keeps this honest:

> **Core only does what the graph itself must do.**

Recommendation, voting, hot-ranking, course generation, quizzes, reputation, leaderboards,
moderation, agent workflows, UI state and teaching strategy belong to a Domain Extension or an
Application. Putting any of them in Core would stop one ontology from serving Learn, Forum and
Research at once.

## Core ideas

**One graph, many views.** Learn, Forum and Research do not maintain separate knowledge
systems. They share one graph and project different views of it, differing by scope, actor,
topic, state and projection rule — not by data model.

**Understanding is not a mastery score.** There is no `mastery = 0.73`. State is a small set
of independent axes — `exposure`, `confidence`, `evidence`, `articulation`, `transfer`,
`conflict`, `source` — each moving on its own schedule. A learner can be confident and unable
to articulate, or fluent and full of unresolved conflict, and collapsing that into one number
would destroy exactly the information the system exists to keep.

**History is the truth.** Nothing is overwritten. There is no `claim.status = "understood"`
that buries what came before. Current state is `reduce(events)` over an append-only,
branchable event log, so cognitive history naturally forms a DAG and "I used to understand it
this way" is a first-class, queryable fact.

**Forking is first-class.** `fork(historyNode)` continues from a point in the past without
touching it, which requires interaction history to be a graph rather than an append-only
message list. A conversation is a view; the graph is the substrate.

**Draft → Thought → Reference.** Not all content is understanding. A raw AI transcript is a
draft and stays out of the graph until a human deliberately organises it. A `thought` must
carry a source and at least one anchor. A `reference` is public, sourced and verified — not
"absolute truth", just public knowledge with a traceable context and verification record.

**AI is a cognitive scaffold, not the author of the user's thinking.** An agent may ask
questions, offer counterexamples, suggest claims, concepts, edges, state changes and
syntheses. Everything it infers is `suggested` until the human accepts, modifies or ignores
it. An agent may never write to the graph or decide which side of a conflict is right.

**Conflict does not disappear.** If two claims contradict, Episteme preserves the conflict
with both authors, sources, evidence, times and states. Its job is to keep the structure of
disagreement, not to pretend knowledge is naturally consistent.

**Private by default, contributed deliberately.** Personal state events and claims are
private; concepts and references are public or controlled; contribution is an explicit
opt-in.

## Documentation

- [Target architecture](docs/architecture/target.md)
- [Architecture overview](docs/architecture/overview.md)
- [Data model](docs/architecture/data-model.md)
- [State events](docs/architecture/state-events.md)
- [Projection](docs/architecture/projection.md)
- [Retrieval](docs/architecture/retrieval.md)
- [Validation sessions and diagnosis](docs/testing/diagnosis.md)
- [ADR 0001 — The Core boundary](docs/decisions/0001-core-boundary.md)
- [ADR 0002 — Event-sourced cognitive state](docs/decisions/0002-event-sourced-cognitive-state.md)
- [ADR 0003 — Storage abstraction](docs/decisions/0003-storage-abstraction.md)
- [ADR 0004 — Domain extension boundary](docs/decisions/0004-domain-extension-boundary.md)
- [ADR 0005 — Fork lineage](docs/decisions/0005-fork-lineage.md)
- [ADR 0006 — Persistence format](docs/decisions/0006-persistence-format.md)
- [ADR 0007 — Semantic retrieval](docs/decisions/0007-semantic-retrieval.md)
- [ADR 0008 — Episteme as a plugin for other agents](docs/decisions/0008-agent-plugin-surface.md)
- [ADR 0009 — Distillation](docs/decisions/0009-distillation.md)
- [ADR 0010 — The Episteme service](docs/decisions/0010-episteme-service.md)
- [ADR 0011 — Host-assisted distillation](docs/decisions/0011-host-assisted-distillation.md)
- [Roadmap](docs/roadmap/README.md)
- [v0.1.0 release notes](docs/releases/v0.1.0.md) · [Changelog](CHANGELOG.md) ·
  [Development status](docs/development-status.md)
- [Phase 1 report](PHASE1_REPORT.md)
- [Phase 2 report](PHASE2_REPORT.md)

## Limitations in v0.1.0

- **No real host yet.** Host-assisted distillation works with scripted MCP clients in tests. No real Claude
  Code session and no real learner have used it, and compatibility with any particular agent host is not
  verified.
- **Review is not authenticated.** Any local process can call the REST review API, including an agent with
  shell access, and could accept its own proposal. Run the service only on your own machine, with agents you
  trust. Tracked in [#17](https://github.com/SAIR-club/Episteme/issues/17).
- **The Workspace does not show a suggestion's basis or speaker** yet. The data is in the API
  ([#26](https://github.com/SAIR-club/Episteme/issues/26)).
- **Retrieval uses a deterministic embedding adapter.** A question phrased very differently from what was
  recorded may not reach it.
- **`not_pending` in a retry receipt is not "dismissed".** Dismissals leave no record
  ([#25](https://github.com/SAIR-club/Episteme/issues/25)).
- **Plain-text local storage.** Graphs, drafts and sources are plain JSONL on disk, with no encryption and no
  authentication. Do not expose the service to a network.

Scope creep is the main risk to this project, so the following are explicitly out of scope for
now: multi-agent systems, recommendation engines, automatic curriculum generation, reputation,
leaderboards, semantic auto-merge, AI truth oracles, automatic knowledge-graph generation,
federation, institutional deployment, payments, complex governance, educational-effect
experiments, and full Lean integration.

Episteme ships no model of its own. The host's agent supplies the model, and `packages/agent` keeps a scripted
mock as the deterministic test double the loop's proofs depend on ([ADR 0008](docs/decisions/0008-agent-plugin-surface.md)).

## What comes next

Development is paused after v0.1.0. When it resumes, the first step is not a new feature: it is one end-to-end
learning session with a real Claude Code host and a real learner, and a second session that shows whether what
they confirmed the first time is recalled and used. See [docs/development-status.md](docs/development-status.md).

## Technical principles

Simple, typed, modular, testable and replaceable — rather than clever, complex or prematurely
distributed. TypeScript, a pnpm workspace monorepo, Vitest, ESLint and Prettier.

The domain model runs and is tested **without a frontend, without an LLM and without a
database**. That is a design constraint, not an accident: it is what allows the ontology to
outlive any particular product surface.
