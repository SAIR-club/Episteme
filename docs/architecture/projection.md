# Projection and retrieval

How one graph becomes many views, and how a later interaction finds the understanding that should
shape it. Read [data-model.md](data-model.md) first.

## Why projection exists

Learn, Forum and Research must not each maintain their own knowledge store. They share one graph and
differ by **scope, actor, topic, state and projection rule** — never by data model. That is what lets a
thought written while learning be contributed to a discussion without conversion.

```text
                        Episteme Graph

             ┌───────────────┼───────────────┐
             │               │               │
          Learn            Forum          Research
             │               │               │
       Learner View    Discussion View   Research View
```

## `project(graph, filter)`

```ts
const view = project(graph, {
  scene: ['scene:learn'], // scope: which surface
  tags: { topic: ['transformer'] }, // AND-ed namespace/value filters
  actor: humanId, // whose cognitive state the state filter uses
  authoredBy: humanId, // whose authored nodes to include
  nodeTypes: [NODE.claim], // types wanted in the result
  state: { confidence: { level: 'high' } }, // currently-held values
  depth: 1, // hops from a seed
  timeRange: { from: 0, to: 100 },
})
```

Which criteria do what matters, and two of them behave differently on purpose:

- **`scene`, `tags`, `authoredBy` select seeds** — they decide where the view starts.
- **`nodeTypes`, `state`, `timeRange` gate the result** — a node that fails them is not in the view.
- **`depth` expands from the seeds by traversal**, and traversal is _not_ restricted by `nodeTypes`.
  A depth-1 view of claims still walks through the concepts those claims refer to, which is how it
  reaches other claims. The type gate then applies to what is displayed.

## What a projection returns

```ts
interface Projection extends SubGraph {
  readonly nodes: readonly GraphNode[]
  readonly edges: readonly GraphEdge[]
  readonly seeds: readonly NodeId[] // matched the scope directly
  readonly expanded: readonly NodeId[] // arrived by traversal
  readonly filter: ProjectionFilter
}
```

Two invariants:

- **Edges are kept only when both endpoints survive.** A dangling edge would imply knowledge the view
  cannot show.
- **`seeds` and `expanded` are separated** so a view can explain itself. "You asked about this" and
  "this turned out to be connected" are different claims, and a learner view needs to tell them apart.
  A seed excluded by a gate is reported in neither list, because it is not part of this view.

## State filtering uses the present, not the past

`state: { confidence: 'high' }` means _currently_ high, not "was ever high". Matching reads each
dimension's own final value through `graph.state.stateOf`, which reduces the event history — so a
claim that was once held confidently and later doubted does not match. Without an `actor`, state
criteria cannot be evaluated and are ignored rather than guessed at.

This is also where actor isolation becomes visible: the same graph and the same filter return
different sets for two actors, because understanding belongs to the actor and not to the node. A test
asserts exactly that.

## Retrieval: getting previous understanding back

A projection answers "show me this area". Retrieval answers "what is relevant to this question",
which is what a later interaction needs.

```ts
const found = retrieve(graph, {
  text: 'Then why does RoPE work?', // matched against labels, tags and ids
  tags: ['topic:rope'], // a filter is intent, not a hint
  nodeIds: [conceptId], // explicit anchors
  nodeTypes: [NODE.claim],
  depth: 1, // walk out from the matches
  limit: 20,
})
```

`RetrievalResult` reports `matches` and `neighbors` separately, and each match carries `matchedTerms`
— so a result can be justified rather than merely asserted.

**Deterministic and explainable by construction.** No embeddings, no model: terms are lowercased,
split on non-alphanumerics, stop-worded and de-duplicated in first-seen order. The same question over
the same graph returns the same thing in the same order, which is what lets the critical loop be
_asserted_ in a test instead of demonstrated by hand. Scoring is deliberately simple — an anchor
outranks a label match, which outranks a tag match, with recency as a total tie-break.

**Why traversal matters.** Asking about "RoPE" should also surface the claim RoPE was built to
answer, even though the question never names it. That is what `depth` buys, and it is why the
neighbour pass exists at all.

**A tag filter is a statement of intent.** `tags: ['topic:rope']` returns the nodes carrying that tag
rather than scoring them against zero search terms — a filter-only query means "these are the ones I
want". Drafts and revoked nodes never appear as matches, because retrieval goes through the same query
path as every other node lookup.

## Learner context: joining structure to one actor

Core's `retrieve` is structural. `retrieveRelevantContext` (in the Learn pack) is what knows that
relevance has anything to do with what a _learner_ understands:

```ts
const context = retrieveRelevantContext(graph, log, question, { actorId, depth: 1 })

context.nodes // the relevant part of the graph
context.known // what THIS actor understands about those nodes
context.summary // one readable line, '' when nothing is recorded
```

`known` carries per-node state, a `settled` predicate over `confidence`/`articulation`, and any
`openConflicts`: a conflict level of `suspected` or `open` (`isOpenConflict`). A conflict marked `resolved`
has been worked through and is not listed. Two details are deliberate:

- **`summary` is `''` when nothing is recorded**, not a sentence saying so. "Nothing" must be
  distinguishable from "something" _as data_, because a responder branches on it; the display form is
  `contextSummary()`, so a human-readable phrase can never be mistaken for recorded understanding.
- **`toAgentContext` passes the concrete understanding in `detail`**, not only a rendered string, so a
  responder can branch on _which_ understanding exists instead of pattern-matching prose it wrote
  itself a moment earlier.

## The loop this makes possible

```text
question
   ↓  retrieve()            relevant part of the graph
   ↓  stateOf()             what this actor understands about it
   ↓  respond(input, ctx)   an answer conditioned on that
   ↓  commit / fork         the understanding changes
   ↓  next question         a different view, and so a different answer
```

`tests/critical-loop.test.ts` holds the agent and the code fixed and varies only the stored history, so
a different answer is attributable to what was remembered. That is the mechanism proof for v0.

## Known limitations

- Retrieval is lexical. "Order information" will not match a claim that says "sequence order" unless a
  shared term appears. An embedding adapter is the intended fix, behind the same interface.
- Projection is a full scan with in-memory adjacency. Adequate at v0 scale; the storage port is where
  an index would go.
- `history()` returns events chronologically across every open end. That is the right input for
  `reduce`, but a caller wanting one narrative must pass `branchId`.
- There is no relevance feedback: nothing records which retrieved context actually helped.
