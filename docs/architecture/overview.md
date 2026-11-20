# Architecture overview

This document describes what Episteme is made of, which layer owns which decision, and why the
seams are where they are. It is the durable companion to [ADR 0001](../decisions/0001-core-boundary.md),
which records the boundary decision itself.

## The problem the layering solves

Episteme intends to support learning, discussion, research, skill acquisition and collaborative
inquiry without each of them growing its own knowledge store. If `Learn` and `Forum` each had
their own model of a claim, then a thought written while learning could not be contributed to a
discussion without lossy conversion, and a correction made in one place could not reach the
other.

So there is exactly one graph, and the products are views over it:

```text
                        Episteme Graph

             ┌───────────────┼───────────────┐
             │               │               │
          Learn            Forum          Research
             │               │               │
       Learner View    Discussion View   Research View
```

What differs between views is `scope`, `actor`, `topic`, `state` and the projection rule —
never the underlying data model.

## Layers

### Adapters

Replaceable infrastructure: storage, and later embedding, search, logic and model providers.
Adapters implement interfaces declared by the layer above them and are the only place allowed
to know about a concrete technology. v0 ships one: `@episteme/storage-memory`.

### Episteme Core

The graph itself, and nothing else. Core knows about nodes, edges, state, tags, versioning,
access, queries, guards and projections. It knows nothing about courses, quizzes, forums,
ranking or teaching. It runs and is tested with no frontend, no model and no database.

```text
packages/core/src/
├── ontology/      ids, primitives (time, provenance), actor, resources, state, tags
├── graph/         definitions, registries, the graph facade
├── events/        the append-only, branchable event log (Engram)
├── guards/        the single authoritative validation path
├── projection/    project(): one graph, many views
├── retrieval/     retrieve(): finding the part of the graph relevant right now
├── storage/       the storage port Core depends on
└── errors.ts      the error taxonomy
```

Further reading: [data-model.md](data-model.md), [state-events.md](state-events.md),
[projection.md](projection.md) (which also covers retrieval).

### Domain Extensions

Vocabulary and rules for one scene: `Learn Pack`, `Forum Pack`, `Research Pack`. A pack
registers node types, edge types, state dimensions, tag namespaces, guards and projection
rules. `@episteme/domain-learn` is the reference implementation.

### Applications

Product surfaces: `Episteme Learn`, `Episteme Forum`, `Episteme Research`. UI, interaction
flows, ranking, feeds, notifications, quizzes — anything whose value depends on a particular
product. No application exists yet; `apps/` is documented as a placeholder.

## The decision rule

Before adding a feature, ask in order:

1. **Is this a graph primitive?** → Core. (`Node`, `Edge`, `StateEvent`, `Fork`, `Projection`, `Access`)
2. **Is this a cross-application domain rule?** → Domain Extension. (`mastery`, discussion
   synthesis rules, learning guards)
3. **Otherwise** → Application. (`ranking`, `recommendation`, `quiz`, `feed`, `notification`)

## Core's parts

### Ontology

`Node`, `Edge`, `Actor`, `Tag`, `StateEvent`, `SubGraph`. Ids are branded strings, so an id that
could be silently swapped for another kind is a compile error rather than a runtime bug. Time is
always an explicit value supplied by a `Clock`, because a history that reads the wall clock
cannot be replayed.

The v0 node types the ontology is designed around are `Concept`, `Question`, `Claim`,
`Evidence`, `Artifact`, `Actor`, `Thought`, `Synthesis` and `StateEvent`. `Learn` registers the
subset it uses; the rest are registered by the packs that need them.

### Registries

Node types, edge types, state dimensions and tag namespaces must be **registered before use**.
Business code may not invent a type string: an unregistered type would be invisible to
validation, projection and every future migration. Re-registering an existing id is an error
rather than an overwrite, because silently swapping a definition would invalidate everything
already stored under it. `registerIfAbsent` is the idempotent form that lets two packs share a
vocabulary.

`defineDomainPack` turns declarative definitions into a pack, so the common case — a pack that
only adds vocabulary — needs no imperative code.

### Graph

`createGraph` returns the façade every mutation flows through: `addNode`, `addEdge`, `getNode`,
`getEdge`, `neighbors`, plus `previewNode` and `previewEdge`. Every write is validated before it
is stored, so the graph is always a legal instance of the registered vocabulary. The graph holds
structure only; it stores no understanding, and it has no ranking, feed or recommendation
surface. Physical deletion is deliberately not exposed — removed history is a **revoke**, and
real erasure is reserved for privacy and legal compliance.

### Engram (events)

The event-sourced record of changing understanding, and the only place two invariants hold:

1. **History is the truth.** Current state is always `reduce(events)`. The cache Engram keeps is
   an optimisation and can be discarded and rebuilt at any time.
2. **Nothing is overwritten.** There is no update and no delete. A change of mind is a new
   event; a change of direction is a new branch.

`commit`, `fork`, `history`, `reduce`, `stateOf`, `revokeStateEvent`, `tips` and `branchAncestry` are
the whole surface. See [ADR 0002](../decisions/0002-event-sourced-cognitive-state.md) and
[ADR 0005](../decisions/0005-fork-lineage.md) for the model's details, and
[state-events.md](state-events.md) for how to work with it.

### Guards

The single authoritative validation path for mutation. Structural integrity — registered types,
existing endpoints, declared properties, legal dimension values — is checked first, then
registered domain guards run. Because the graph layer calls `validateMutation` for every change,
no code path can write an unregistered type or skip a domain rule.

Guards are registered data, not hard-coded branches, which is what lets a domain enforce a real
constraint without Core learning its vocabulary. The `learn` pack's rule that a `thought` must
carry a source and at least one existing anchor is the reference example; anchoring is Learn's
vocabulary, so it is a guard rather than a Core rule.

A refusal is a first-class outcome. `previewNode`/`previewEdge` return a `MutationRefusal`
instead of throwing, so "the agent suggests a change, the human decides" needs no exception
control flow, and a refused suggestion leaves no trace.

### Projection

`project(graph, filter)` derives a view from one graph, with filters for `scene`, `tags`,
`actor`, `authoredBy`, `nodeTypes`, `state`, `depth` and `timeRange`. It returns a `Projection`
that also records `seeds` (matched the scope directly) and `expanded` (arrived by traversal), so
a view can explain itself.

Two details matter. **State matching uses each dimension's current value**, never a historical
one, so "confidently held" means now. And **edges are kept only when both endpoints survive**,
because a dangling edge would imply knowledge the view cannot show.

`nodeTypes`, `state` and `timeRange` gate the result, while `scene`, `tags` and `authoredBy`
select seed nodes; `depth` expands by traversal, which is deliberately _not_ restricted by
`nodeTypes` so a claim-only view can still walk through the concepts it refers to. Full detail in
[projection.md](projection.md).

### Retrieval

`retrieve(graph, query)` finds the part of the graph relevant to a piece of text, by terms, tags,
explicit anchors and neighbourhood, with no embeddings and no model. `matches` and `neighbors` are
reported separately and each match carries the `matchedTerms` that caused it, so a result can be
justified rather than merely asserted.

It is deterministic on purpose: the same question over the same graph returns the same thing in the
same order, which is what lets the critical loop be _asserted_ in a test. `depth` is what lets a
question about RoPE surface the claim RoPE was built to answer even though the question never names
it. The Learn pack wraps this as `retrieveRelevantContext`, which joins the structural result to one
actor's understanding — see [projection.md](projection.md).

## Data flow of one interaction

```text
human asks a question
        │
        ▼
retrieve(graph, { text, actor })          ──▶  the relevant part of the graph
        │
        ▼
stateOf(target, actor[, branchId])        ──▶  what this actor currently understands
        │
        ▼
CognitiveAgent.respond(input, context)    ──▶  an answer conditioned on that
        │
        ▼
human accepts / modifies / ignores
        │
        ▼
graph.addNode / addEdge  ──▶  validateMutation  ──▶  guards
        │
        ▼
EventLog.commit(...)                      ──▶  a new immutable StateEvent
        │
        ▼
the next interaction reads a different view
```

## Testing strategy

Three questions decide whether the project is working, and they are the acceptance criteria for
v0 (`tests/northstar.test.ts`):

- **Test A** — Can the system express "I used to understand it this way, and now I understand it
  differently"?
- **Test B** — Can it express "from that same earlier understanding, I later took two different
  paths"?
- **Test C** — Can it make today's answer different _because_ of how I understood before?

If any of these is not a clear yes, the answer is to stop adding features rather than add more
of them. Around them sit focused suites for append-only history, fork lineage, state reduction,
retraction and query, projection isolation, guard rejection, retrieval, and actor-state isolation.

The mock agent exists for Test C: it answers from the context it is handed, so the test can hold the
agent and the code fixed and vary only the history. A real model would make "the response changed
because of the stored understanding" impossible to verify, since it might have given the same answer
anyway. `tests/critical-loop.test.ts` is that proof; it is the test to keep green above all others.

## Known limitations

- No access-control enforcement yet: the privacy default is expressed in the model (`Actor.shareByDefault`,
  per-actor state) but not enforced by a policy layer.
- No identity/authentication layer; actor ids are supplied by the caller.
- **Retrieval is lexical.** A question phrased with different words will miss the understanding that
  answers it. An embedding adapter is the intended fix, behind the same interface.
- Reads are per line of inquiry once an actor has forked, so "what do I currently understand" is only
  well defined relative to a branch. An application must name the actor's current branch.
- `history()` returns events chronologically by commit time. That is the right input for `reduce` and
  for a view, but it is not a single linear narrative; a caller that needs one path must pass
  `branchId`.
- Projection and retrieval are full scans with in-memory adjacency. Adequate for v0 graphs, and the
  storage port is where an index would go.
- Nothing records which retrieved context actually helped, so there is no relevance feedback yet.
- `packages/sdk`, `packages/domain-forum`, `packages/logic-bridge` and
  `apps/` are placeholders, not implementations.
