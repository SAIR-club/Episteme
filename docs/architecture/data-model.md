# Data model

The ontology, its identity and lifecycle rules, and why the shapes are what they are. Read
[overview.md](overview.md) first for the layering; this document is about the things being stored.

## Node types the ontology is designed around

| Type         | What it is                                                                                         | Not                           | Default tier     |
| ------------ | -------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------- |
| `Concept`    | A stable element of the shared knowledge skeleton — `Transformer`, `RoPE`                          | Not owned by a learner        | `reference`      |
| `Question`   | A question worth exploring; the main entrance to a path                                            | Not a prompt or a chat turn   | `thought`        |
| `Claim`      | A statement the actor currently holds                                                              | Not a fact, and not a score   | `thought`        |
| `Evidence`   | Something that supports or contradicts: experiment, paper, example, derivation, proof, observation | Not a verdict                 | `thought`        |
| `Artifact`   | External content: markdown, notes, code, video, transcript                                         | Not understanding             | `draft` when raw |
| `Actor`      | A subject that can hold state: `human`, `community`, `agent`                                       | Not a node in the graph       | —                |
| `Thought`    | The actor's deliberately organized understanding                                                   | **Never a raw AI transcript** | `thought`        |
| `Synthesis`  | A combination of several thoughts, claims or branches                                              | Not an automatic merge        | `thought`        |
| `StateEvent` | A recorded change of one actor's understanding                                                     | Not a node                    | —                |

Learn registers the subset it uses (`concept`, `question`, `claim`, `evidence`, `thought`,
`synthesis`). `Artifact` is not registered yet: nothing in v0 stores external content, and registering
a type with no producer would be structure without a consumer.

## Identity

Ids are branded strings, so an `ActorId` cannot be passed where a `NodeId` is expected:

```ts
type ActorId = Brand<string, 'ActorId'>
type NodeId = Brand<string, 'NodeId'>
```

`asId<T>('…')` is the single sanctioned cast and belongs at the boundary. Core never invents an id:
node and edge ids come from the caller's draft, and event and branch ids come from an `IdFactory`, so
a history is reproducible and a test can assert on exact output.

**An id names one node or one edge for good.** Adding a node or an edge whose id is already taken is
refused with `duplicate_id`, even when the record holding it is revoked. Otherwise the addition would
replace the earlier record in place, and the node or edge it named would leave the graph without a
revocation. A caller that supplies ids therefore needs a scheme that cannot repeat. The application layer
uses random edge ids, and short counted ids for the nodes a learner types by hand.

## Time

`EpochMillis`, always supplied by a `Clock`. `systemClock` in production, `createFixedClock` in tests
and the demo. Reading the wall clock inside Core would make a history unreplayable, and in an
event-sourced system "when did this happen" is recorded data rather than an implementation detail.

## The three shapes

**`GraphNode`** — `id`, `type`, `label`, `properties`, `tags`, `meta.tier`, plus provenance
(`actorId`, optional `source`) and lifecycle (`createdAt`, optional `revoked`/`revokedAt`).

`properties` is intentionally open: the registered node type declares which keys are required, and the
graph stays agnostic so a new domain needs no Core change. v0 validates the _presence_ of required
keys and nothing more — a deliberately replaceable choice (see
[ADR 0001](../decisions/0001-core-boundary.md)); a schema library can be plugged in behind
`NodeTypeDefinition` without touching a call site.

**`GraphEdge`** — `id`, `type`, `from`, `to`, optional `confidence`. Directed. `confidence` here is
the graph's confidence _that the relation holds_ ("does this evidence really support that claim?"),
which is a different thing from the actor's state about a claim.

**`StateEvent`** — see [state-events.md](state-events.md), which is its own document because it is the
most consequential shape in the system.

## Edge vocabulary

Fifteen types, each with a `category` so traversal and projection can reason about what a relation
means in aggregate without Core hard-coding names:

| Category     | Types                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------- |
| `epistemic`  | `refers_to`, `answers`, `supports`, `contradicts`, `prerequisite`, `synthesizes`, `exemplifies` |
| `structural` | `contains`, `tagged_with`, `evolves_to`, `forks_from`                                           |
| `provenance` | `derived_from`, `organized_from`, `authored_by`                                                 |
| `identity`   | `same_as`                                                                                       |

Endpoint constraints are declared only where the constraint is part of the meaning — `supports` must
terminate at a claim, `prerequisite` relates concepts — because over-constraining here would block
legitimate reuse by a later domain.

An edge type must be **registered before use**. Business code may not invent a type string, since an
unregistered type is invisible to validation, projection and every migration.

## Tiers: draft → thought → reference

```text
Draft ──organize──▶ Thought ──verify / synthesize──▶ Reference
```

- **Draft** — raw AI transcripts, temporary notes, generated content. Not understanding, and excluded
  from queries by default (`NodeQuery.includeDrafts`).
- **Thought** — what the actor organized deliberately. Must carry a source and, for `thought` and
  `synthesis` node types, at least one anchor.
- **Reference** — public, sourced, verified knowledge. Not "absolute truth": public knowledge with a
  traceable context and verification record.

Two guards in the Learn pack enforce this, and both are _domain_ rules rather than Core rules, because
"anchor" is Learn's word:

- `learn/thought-requires-source` — a `thought` or `synthesis` needs a source and at least one anchor.
  A `claim` deliberately does not: it is a position the actor holds, grounded later by `supports` and
  `contradicts` edges, and requiring an anchor up front would block forming a view before finding
  evidence for it.
- `learn/anchors-must-exist` — every id in `anchors` must exist. A node may anchor itself, because a
  thought written directly is its own source of truth for that exploration.

## Lifecycle: revoke rather than delete

An entity carries `revoked` and `revokedAt`. A revoked entity is **not removed**:

- `getNode(id)` still returns it, so history and audit stay honest;
- `listNodes()` and `findNodes()` exclude it by default; `includeRevoked: true` asks for it;
- edges are unaffected, so a revoked node's relations remain inspectable.

Physical deletion is deliberately not exposed in v0. Removal is a **revoke**; real erasure is reserved
for privacy, legal compliance and account deletion, and must be an explicit act rather than a side
effect of an ordinary edit.

## Actor and authority

An `Actor` has a `kind` (`human`, `community`, `agent`) and a `shareByDefault` flag. Registration is
explicit, so "who believes this" can never be invented by the graph, and an agent is distinguishable
from the human it assists.

Authority is a separate axis from authorship. An agent may author a node while a human's understanding
of it changes. For state, `StateValue.authority` records which it was — see
[state-events.md](state-events.md), where the AI-ownership rule lives.

## Tags

Tag namespaced strings: `scene:learn`, `topic:transformer`, `state:active`. Namespaces must be
registered first, which is what lets unrelated vocabularies coexist on one graph instead of colliding
in a flat string space. The namespaces Core relies on are `scene`, `actor`, `topic`, `state` and
`system`.

## What is deliberately absent

There is nowhere to store a mastery score, a rank, a vote count, a view count or a hotness value. Not
an oversight: understanding is a set of independent axes (see [state-events.md](state-events.md)), and
ranking is an Application concern. The single numeric field on an entity is `priority`, and it means
"ordering hint", not "quality".
