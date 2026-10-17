# 0014 — Publication and reuse: the smallest shared loop

Status: **proposed** (2026-10-12). Depends on [ADR 0012](https://github.com/SAIR-club/Episteme/issues/17)
(an authenticated actor on every request) and on the repository boundary of
[ADR 0013](0013-repository-boundary.md).

## Context

The near-term product is a network in which people can browse and reuse good cognitive work (the product direction of 2026-10-12, recorded in
`docs/planning/vision.md` by [#30](https://github.com/SAIR-club/Episteme/pull/30)). Today everything is built for one person:

- the application acts as a single hard-coded `HUMAN` (`packages/application/src/session.ts`);
- `recall`, `listNodes`, `/api/v1/state` and the MCP tools read every node in the graph, so a second person
  in the same graph would read the first person's private claims;
- nothing marks a node as shared. AGENTS.md says "private by default, contributed deliberately", but no code
  enforces it.

Core already has what sharing needs underneath it. Nodes are immutable and can only be revoked. A
`StateEvent` belongs to an actor, not to a node. Every entity carries `actorId` and `source`. Projection can
filter by `authoredBy` and `actor`. What is missing is a deliberate act of contribution, and one place that
decides what a given person may see.

## The story this ADR must make work

1. **A publishes.** A has a claim ("self-attention alone does not encode order") that answers a question,
   supported by evidence quoting a source, and derived from an earlier claim of A's. A chooses *Publish* on
   the claim. A preview shows exactly what will become public: the claim, its evidence, the relations between
   them, and the sources and quotes they carry. It also shows what stays private: A's confidence and every
   other state of A's, A's unrelated nodes, pending suggestions and drafts. A confirms.
2. **B browses.** B lists publications by topic or author and opens A's. B sees the argument as a structure,
   not as text: claim, evidence, what supports what, which question it answers, where each piece came from,
   and the earlier published versions.
3. **B reuses.** B chooses *Adopt as my understanding* and sets B's own levels. B's graph gains no copy. B
   gains state events on A's nodes, each naming the publication it came from. From then on, B's recall
   includes the claim, labelled as A's.
4. **A revises.** A writes a revised claim, links it to the old one with the pack's revision edge (Learn:
   `evolves_to`), and publishes again, superseding the first publication.
5. **B sees the update.** B is told that a source B adopted has a newer version, sees what changed, and
   decides: adopt the new version, keep B's current understanding, or record a change to it. Nothing changes
   for B without B's decision, and B's history keeps every step.

## Decision

### 1. A publication is a new kind of record, not a node

```ts
interface Publication {
  readonly id: PublicationId // branded, minted by the IdFactory like every other id
  readonly actorId: ActorId // the author; always a human (see rules)
  readonly createdAt: EpochMillis // from the Clock
  readonly root: NodeId // what the author chose to publish
  readonly members: readonly NodeId[] // the nodes made public, root included
  readonly edges: readonly EdgeId[] // the relations made public between them
  readonly supersedes?: PublicationId // the author's earlier publication this replaces
  readonly note?: string // the author's own words about this version
}
```

- **Immutable and append-only.** Nodes are immutable already, so a publication pins exactly what was
  published. Withdrawing one is a `revocation` of the publication, the same record ADR 0006 uses for
  everything else. Nothing is deleted.
- **Why not a node.** A publication is a fact about access and authorship, not a unit of understanding. As a
  node it would appear in every node query, every retrieval and every agent's recall unless each of those
  paths learned to skip it, which would put one invariant in many places.
- **What it never contains:** the author's `StateEvent`s. A's confidence in the claim is A's, and stays
  private. Publishing a stance is out of scope (see below).

### 2. Visibility has one authority, in Core

Core gains a single function, used by every read path, that answers "may this viewer see this node":

> A node is **visible to viewer V** iff V authored it, **or** it is a member of a live (unrevoked)
> publication, **or** its tier is `reference`, **or** V holds state on it.

An edge is visible iff both its endpoints are and it is the viewer's own or is in a live publication. A state
event is visible only to its own actor, which is the existing rule (ADR 0002).

The last clause of the node rule exists so that withdrawing a publication cannot make an adopter's own
history unreadable: B's events point at A's node, and B must still be able to read what B adopted.
Withdrawal stops new browsing and adoption, but it does not reach into B's history. Physical deletion is
still reserved for privacy and legal requests (AGENTS.md).

`recall`, the node and state listings, history, projection and the MCP tools all go through this function.
Retrieval for V runs over V's visible nodes, and over V's own state.

### 3. Rules, checked in one validation path

Publishing is validated the way mutations are (`validateMutation` style): a preview returns the publication
it would create or a `MutationRefusal`, and only a confirmed preview is written.

| rule                                                                                         | refusal code              |
| -------------------------------------------------------------------------------------------- | ------------------------- |
| the publisher is a human actor; agents can never publish (it is a contribution decision)     | `agent_cannot_publish`    |
| every member is authored by the publisher, is not a draft and is not revoked                 | `not_publishable`         |
| every member is reachable from the root through included edges, so nothing unrelated slips in | `outside_closure`         |
| an included edge is the publisher's own, and both its ends are members or already visible to everyone | `edge_not_publishable`    |
| a node by someone else may be *referenced* (an edge to a public concept), never made a member | `not_publishable`         |
| `supersedes` names a live publication by the same author                                     | `invalid_supersedes`      |

Adopting is a state commit, so it already goes through the existing guards, plus one new guard: **a state event's
target must be visible to its actor.** Today nothing stops a commit on a node the actor cannot see.

### 4. Reuse is a state event, not a copy

Adopting writes B's own `StateEvent` on A's node, with `source: publication:<id>`, authored by B, using B's
levels. No node is created. If B wants to say something different, B writes B's own claim and links it with
the existing `derived_from` edge. That is a cross-person fork, built from mechanisms that already exist.

### 5. Updates follow `supersedes`

B's adopted sources are the publications named by B's events. A source is **updated** when a live
publication supersedes it, directly or through a chain. The change between versions is computed from the two
member sets, and the pack's revision edge, included in the newer publication, says which new node replaces
which old one.

## API (additive, under `/api/v1`, actor from ADR 0012, never from the body)

| method and path                        | does                                                                                                    | who           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------- |
| `POST /publications/preview`           | `{ root, include?: NodeId[], supersedes?, note? }` → the closure that would be published and what stays private, or a refusal | author        |
| `POST /publications`                   | same body; writes the publication                                                                       | author        |
| `POST /publications/:id/withdraw`      | revokes it                                                                                              | author        |
| `GET /publications?topic=&author=&q=`  | browse: live publications with root label, author, date, member count and version                       | any signed-in |
| `GET /publications/:id`                | members, edges, each member's `source` and origin quotes, author, and the `supersedes` chain both ways | any signed-in |
| `POST /publications/:id/adopt`         | `{ node, dimensions, reason? }` → B's state event with `source: publication:<id>`                       | any signed-in, not the author |
| `GET /updates`                         | adopted publications that have been superseded, with the member diff                                  | the adopter   |

Existing endpoints keep their shape; their *contents* become scoped to the caller. On a graph with one actor
that changes nothing. MCP gains no tool in the MVP: agents may recall what the person can see, including
what they adopted, but never publish or adopt.

## Workspace (Learner, `apps/learn`)

The API above is Episteme's; these views are Learner's (ADR 0013). A second scene would build its own views
on the same API.

- **Publish** on a claim: preview with "becomes public" and "stays private" lists, the refusal explained in
  words when there is one, then confirm. "My publications", with withdraw.
- **Browse:** list by topic, and search by text.
- **Publication page:** the claim; its evidence with quotes and sources; the relations drawn as a small graph
  or an indented outline; the version chain; the author.
- **Adopt:** the existing record form, with levels from `/api/v1/vocabulary`, prefilled with nothing:
  adopting does not inherit A's state.
- **Updates:** a list of adopted sources with newer versions, showing what changed, with *adopt new
  version*, *keep mine* and *record a change*.
- **Recall results** mark adopted items with their author and publication.

## Out of scope for the MVP

Comments, votes, reputation, ranking and recommendation; following people; notifications other than
`/updates`; cross-person conflict detection or resolution; merging forks; publishing one's own state or
stance; federation across services; per-audience sharing (publications are visible to every signed-in
actor of the service); deleting a publication's content.

## Testing

| test                         | proves                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| visibility matrix (Core)     | for authored, published, withdrawn, reference and adopted nodes × author, other and adopter: exactly the rule above |
| isolation through every read | with two actors, A's private node never appears in B's recall, nodes, state, history, projection or MCP      |
| publication guards           | each refusal in the table, including an agent trying to publish                                              |
| closure                      | an unrelated node in `include` is refused; the preview equals what is written                               |
| adopt                        | creates exactly one state event for B, no node, `source` names the publication; refused for invisible nodes |
| story end to end             | the five steps of the story above, over HTTP against one service with two signed-in actors: in Episteme with the test scene pack, and in Learner through the launcher |
| withdrawal                   | B's adopted history stays readable; browse and adopt stop                                                   |
| persistence                  | publications and withdrawals survive a restart; a graph written before this ADR opens unchanged              |

## Delivery

Each step is built after ADR 0013's M2–M5, so it lands in the scene-agnostic application and the rebuilt
Workspace. A step marked *(E)* is an Episteme PR, *(L)* a Learner PR that bumps `episteme.ref` to it.

| #   | PR                                                       | contents                                                                                     | gate                                                    |
| --- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| S1  | *(E)* ADR 0012 and its implementation                    | an actor on every request (local tokens); only humans decide; `confirmedBy` and authorship from the token | an agent token cannot decide; no token, no write        |
| S2  | *(E)* `feat(core): visibility`                             | the visibility function and the adoption guard; projection and node queries take a viewer     | visibility matrix                                       |
| S3  | *(E)* `refactor(application): one session per actor`           | one service, one graph, a session per signed-in actor; every read path is scoped               | isolation through every read, REST and MCP              |
| S4  | *(E)* `feat(core): publications`                             | the record, its persistence kind, preview and the rules; withdrawal                           | publication guards, closure, persistence                |
| S5  | *(E)* `feat(service): publish`, *(L)* `feat(learn): publish` | the publish API (E) and the Workspace's publish and "my publications" views; `--sharing` flag and pre-write backup | story steps 1–2 end to end                              |
| S6  | *(E)* `feat(service): browse and adopt`, *(L)* `feat(learn): browse and adopt` | browse, publication page, adopt (E: API; L: views)                                                           | story step 3; adopt tests                               |
| S7  | *(E)* `feat(service): updates`, *(L)* `feat(learn): updates` | `supersedes` chains, `/updates`, the updates view                                            | story steps 4–5; withdrawal                             |

Rollback: S1–S3 change no data and revert cleanly. From S4 on, revert the code and restore the copy the
service took before its first publication. A graph with publications stays readable by S4 and every later
build.

## Consequences

- **The persistence format gains a record kind,** `publication`. Older builds refuse unknown kinds
  (`storage-local`, `isKnownKind`), so **a graph that contains a publication cannot be opened by a build from
  before this ADR. This is a breaking change for downgrades.** Mitigation: sharing is off unless the service
  is started with `--sharing`, and the service copies the graph file aside before writing its first
  publication.
- Every read path in the application changes from "the graph" to "what this actor may see". This is the
  largest change, and the isolation test is the guard against a path being missed.
- Core stays scene-free: `Publication`, visibility and the adoption guard name no Learn concept. The revision
  edge used to pair versions is the pack's, not Core's.

## Alternatives considered

- **Publish by copying text into a shared node.** This loses structure, provenance and history, and every
  update would become a new copy. Rejected by the product direction.
- **Use `tier: reference` as "public".** A reference is verified, and publishing does not verify anything.
  Conflating them would make "public" sound like "true".
- **A publication as a node with `includes` edges.** This needs no format change, but it leaks into every
  query (section 1).
- **One graph per person, synchronised.** That is federation, which is out of scope, and it contradicts "one
  graph, many views".
