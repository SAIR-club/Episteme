# State events

The most consequential shape in Episteme, and the reason it is not a chat log with a database behind
it. Read [data-model.md](data-model.md) for the surrounding nouns and
ADR 0002 for why this model was chosen.

## The record

```ts
interface StateEvent extends Timestamps {
  readonly id: EventId
  readonly branchId: BranchId
  readonly target: NodeId // whose understanding
  readonly actorId: ActorId // whose understanding (the actor's)
  readonly dimensions: DimensionIndex
  readonly parent?: EventId // previous event on this branch
  readonly forkedFrom?: EventId // the point this branch was cut from
  readonly reason?: string
  readonly source?: string
}
```

Four guarantees, and each is tested:

- **append-only** — nothing is edited and nothing is deleted;
- **immutable** — frozen on construction (`Object.isFrozen`, asserted in the tests);
- **traceable** — it names the actor, the time, a reason and a source;
- **branchable** — it belongs to a branch and knows its predecessor.

An event records **only what moved**. Silent re-statements of unchanged dimensions are not
representable, which is what keeps a history readable as a story of changes rather than a series of
full snapshots.

## Using it

```ts
// Record a change of understanding.
const event = log.commit({
  target: claimId,
  actorId: humanId,
  dimensions: new Map([
    [DIMENSION.confidence, { level: 'high' }],
    [DIMENSION.evidence, { level: 'reproduced' }],
  ]),
  reason: 'worked through the derivation',
  source: 'session:1',
})

// Current state is derived, never stored.
log.stateOf(claimId, humanId).get(DIMENSION.confidence) // { level: 'high' }

// The story of the change.
log.history({ target: claimId, actorId: humanId }) // oldest first by default

// Continue from an earlier understanding.
const { event: forked, branch } = log.fork({
  from: earlierEventId,
  target: claimId,
  actorId: humanId,
  dimensions: new Map([[DIMENSION.conflict, { level: 'open' }]]),
})
log.stateOf(claimId, humanId, { branchId: branch.id }) // the earlier state, plus this change
```

## Understanding is not a scalar

There is no `mastery = 0.73`, and no field where one could be written. Learn registers seven
independent axes:

| Dimension      | Kind        | Levels                                           |
| -------------- | ----------- | ------------------------------------------------ |
| `exposure`     | ordinal     | `none`, `seen`, `studied`, `worked`              |
| `confidence`   | ordinal     | `low`, `medium`, `high`                          |
| `evidence`     | ordinal     | `none`, `anecdotal`, `reproduced`, `proven`      |
| `articulation` | ordinal     | `low`, `medium`, `high`                          |
| `transfer`     | ordinal     | `low`, `medium`, `high`                          |
| `conflict`     | ordinal     | `none`, `suspected`, `open`, `resolved`          |
| `source`       | categorical | `self`, `agent`, `paper`, `discussion`, `course` |

Each moves on its own schedule, and the combinations are the point: confident-but-inarticulate and
fluent-but-conflicted are different situations requiring different responses. One number would make
them identical — which is the loss the project exists to prevent.

A dimension's legal vocabulary is declared by its registered definition, so Core never hard-codes
"low/high" or any other domain word, and an illegal level is refused at commit time.

## State belongs to the actor

`StateEvent.actorId` is a separate axis from a node's authorship. An agent may author a node while a
human's understanding of it changes. Consequences worth knowing:

- two actors' state about one node is fully independent — asserted in the tests, and the reason state
  is not a column on the node;
- `Tips` and reads are per actor;
- a fork is refused when the event belongs to another actor's path, because continuing someone else's
  line would silently adopt their reasoning as yours.

## Per-branch reads

Once an actor has more than one line of inquiry, "what do I currently understand" is only well defined
relative to a branch:

```ts
log.stateOf(claimId, actorId) // reduces every open end
log.stateOf(claimId, actorId, { branchId }) // one line of inquiry
```

A named branch reads by stitching its ancestry: each ancestor contributes the prefix ending where the
next branch forked from it, and the branch contributes everything it recorded. A fork from an earlier
event therefore does **not** inherit changes made afterwards on the original line. See
ADR 0005.

## Retraction without erasure

```ts
const revocation = log.revokeStateEvent(eventId, { reason: 'misrecorded' })
```

The event stays readable through `getEvent`, and `isRevoked`/`revocationOf` report the retraction —
but it is excluded from reduction and hidden from `history` unless `includeRevoked: true` is passed.
The retraction is itself appended data carrying a time and a reason.

This is the honest middle ground: a learner needs to be able to correct the record, and deleting the
event would erase the fact that they once understood something differently — which is exactly what
this system exists to keep.

## The AI-ownership rule

`StateValue` carries three optional fields:

```ts
interface StateValue {
  readonly level?: string
  readonly scalar?: number
  readonly authority?: 'author' | 'suggested' | 'confirmed'
  readonly confirmedBy?: ActorId
  readonly sourceOf?: string
}
```

`assertHumanOwnsTheValue` in Core's structural validation refuses:

- `authority: 'suggested'` — an agent's inference must be confirmed by a human before it becomes
  cognitive state;
- `authority: 'confirmed'` with no `confirmedBy`, or with one that is unregistered or is not a
  `human` actor.

`authority` defaults to `author`, which is the ordinary case of a person recording their own
understanding. The rule deliberately **does not** check who wrote the event: a human accepting an
agent's suggestion commits under their own actor id, and that is the only path by which an inferred
value may exist.

This is structural rather than an opt-in pack guard because it is the project's central principle, and
a pack that forgot to register it would be a back door.

## What the log deliberately does not offer

No `update`, no `delete`, no `clear`, no `merge`. A test asserts those names are absent from the
object. A change of mind is a new event; a change of direction is a fork; a mistake is a retraction.
There is no fourth option, and no way to make history say something it did not say.
