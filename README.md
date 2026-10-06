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

## Status

There is now something you can actually use: **`pnpm learn:web`** opens a local interface where a learner
asks a question in their own words, sees which of their own prior understanding was retrieved **and why**,
records what they now understand, and watches the next answer change because of it. Everything is written to
a plain JSONL file and survives closing the process.

![The Learn surface](docs/images/learn-surface.png)

Behind it, three phases of work that each proved one thing:

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
pnpm learn:web          # use it, in a browser at http://127.0.0.1:4321
# or
pnpm learn              # the same loop in a terminal
# and the phase demos:
pnpm demo && pnpm demo:persistent && pnpm demo:semantic
```

`pnpm learn --help` and `pnpm learn:web --help` list the options, including `--file` to choose the graph.
The default is `~/.episteme/learn.jsonl`.

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
│   ├── mcp/                The MCP surface: an agent can recall, propose and reflect, never confirm
│   ├── agent/              CognitiveAgent interface + scripted mock (no real model yet)
│   ├── domain-forum/       [placeholder] Forum domain pack
│   └── logic-bridge/       [placeholder] optional formalisation (Lean, Datalog, SMT)
├── apps/
│   └── learn/              The Learn interaction surface: terminal and local web
├── examples/
│   ├── learn-session/      Phase 0: the cognitive loop
│   ├── persistent-session/ Phase 1: the loop across a process restart
│   └── semantic-session/   Phase 2: a paraphrase reaching stored cognition
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

- [Architecture overview](docs/architecture/overview.md)
- [Data model](docs/architecture/data-model.md)
- [State events](docs/architecture/state-events.md)
- [Projection](docs/architecture/projection.md)
- [Retrieval](docs/architecture/retrieval.md)
- [ADR 0001 — The Core boundary](docs/decisions/0001-core-boundary.md)
- [ADR 0002 — Event-sourced cognitive state](docs/decisions/0002-event-sourced-cognitive-state.md)
- [ADR 0003 — Storage abstraction](docs/decisions/0003-storage-abstraction.md)
- [ADR 0004 — Domain extension boundary](docs/decisions/0004-domain-extension-boundary.md)
- [ADR 0005 — Fork lineage](docs/decisions/0005-fork-lineage.md)
- [ADR 0006 — Persistence format](docs/decisions/0006-persistence-format.md)
- [ADR 0007 — Semantic retrieval](docs/decisions/0007-semantic-retrieval.md)
- [ADR 0008 — Episteme as a plugin for other agents](docs/decisions/0008-agent-plugin-surface.md)
- [ADR 0009 — Distillation](docs/decisions/0009-distillation.md)
- [Phase 1 report](PHASE1_REPORT.md)
- [Phase 2 report](PHASE2_REPORT.md)

## What v0 does not do

Scope creep is the main risk to this project, so the following are explicitly out of scope for
now: multi-agent systems, recommendation engines, automatic curriculum generation, reputation,
leaderboards, semantic auto-merge, AI truth oracles, automatic knowledge-graph generation,
federation, institutional deployment, payments, complex governance, educational-effect
experiments, and full Lean integration.

An agent interface exists in `packages/agent`, but only as a scripted mock. Connecting a real
model is deferred until the Core and Learn loop is stable — an agent that could not be held
constant would make the central claim unverifiable.

## Technical principles

Simple, typed, modular, testable and replaceable — rather than clever, complex or prematurely
distributed. TypeScript, a pnpm workspace monorepo, Vitest, ESLint and Prettier.

The domain model runs and is tested **without a frontend, without an LLM and without a
database**. That is a design constraint, not an accident: it is what allows the ontology to
outlive any particular product surface.
