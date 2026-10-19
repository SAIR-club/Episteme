# 0016 — Delegated confirmation: a person may let the service confirm for them

Status: **accepted** (2026-10-18). Amends the invariant _AI is a cognitive scaffold_ in AGENTS.md, and
[ADR 0008](0008-agent-plugin-surface.md) and [ADR 0009](0009-distillation.md) where they say only a person
confirms. Depends on [ADR 0012](0012-human-review-security.md) for the human/agent credential split and on
[ADR 0014](0014-publication-and-reuse.md) for what a publication shows. Implemented by #43.

## Context

The product decision (development plan, D5) is: understanding is confirmed by the learner by default, and the
learner may hand confirmation over to AI entirely; that permission is always the learner's to give and take
back. Some learners want an agent to keep their graph up to date while they study and review later, or not at
all.

Today the invariant says everything an agent infers needs human confirmation before it becomes the user's state,
and ADR 0008 and 0009 build the one decision path on that. A learner who wants to delegate has no way to, except
by clicking "accept" on everything, which defeats the purpose of reviewing and does not record that they did not
really look.

## Decision

**A person may grant a delegation for a scope. While it is live, the service decides agent proposals in that
scope on the person's behalf, through the same decision path, and records that it did. The person can see, revoke
and undo every such decision. Nothing an agent does can grant, widen or keep a delegation.**

### 1. The delegation record

```ts
interface Delegation {
  readonly id: string
  readonly actorId: ActorId // the person who granted it; always a human
  readonly scope: string // "*" for everything of theirs, or a scope id (ADR 0015, decision 6)
  readonly grantedAt: EpochMillis
  readonly revokedAt?: EpochMillis
}
```

Granted and revoked only with the person's own credential (ADR 0012): an agent credential gets `403
human_required`. Kept beside the drafts, with them, append-only: revoking writes `revokedAt`, the record stays.

### 2. While a delegation is live

When an agent's proposal for this person lands in a scope with a live delegation, the service decides it at once,
by calling the same `decide` with `accept`, as the person, on channel `delegation`, with the delegation id in the
review record. It does not modify, merge or rank: it accepts exactly what was proposed, and only if `decide`
would accept it from the person. A refusal leaves the draft pending in the review queue, as for anyone.

A state change committed this way is recorded with `authority: 'delegated'` rather than `confirmed`, and names
the person in `confirmedBy`. The person's state is still the person's (state belongs to the actor); its history
says how it got there.

### 3. What a delegation never covers

- **Publishing, adopting, withdrawing** (ADR 0014): contributions to what others see stay the person's act.
- **Conflict**: a proposal that opens, changes or resolves a `conflict` level stays in the queue. Delegation does
  not let a model pick a side (_Conflict is preserved, not resolved_).
- **Granting or revoking delegation itself.**
- **Another person's graph.** A delegation is for its grantor only.

### 4. Seen and undone

- `GET /api/v1/reviews?channel=delegation` lists every decision taken under a delegation, with the delegation
  id; the Workspace shows them as "confirmed for you".
- Undoing one revokes what it committed (a state event, a node, an edge), which is a revocation in the history
  and nothing is erased; the review record stays.
- Revoking a delegation stops it from the next proposal on. It does not undo what it already decided; the person
  undoes those one by one or in bulk from the list.

### 5. Shown when shared

A publication (ADR 0014) shows, for each member and each state the reader can see about it, whether it was
confirmed by its author or under delegation. A reader can then weigh "confirmed by the person" and "confirmed
for them by their agent" differently.

### 6. The invariant, as amended

AGENTS.md's _AI is a cognitive scaffold_ becomes:

> Everything an agent infers is `suggested` and requires the person's confirmation before it becomes their
> state — or, while the person has granted a delegation that they can revoke at any time, the service's
> confirmation on their behalf, recorded as delegated. No agent may write to the graph directly, grant or extend
> a delegation, or decide which side of a conflict is right.

## API (#43)

| route under `/api/v1`             | does                                        | who           |
| --------------------------------- | ------------------------------------------- | ------------- |
| `GET /delegations`                | the caller's delegations, live and revoked  | person, agent |
| `POST /delegations`               | `{ scope }` → a new live delegation         | person only   |
| `POST /delegations/:id/revoke`    | stops it from the next proposal on          | person only   |
| `GET /reviews?channel=delegation` | decisions taken under a delegation          | person, agent |
| `POST /reviews/:suggestion/undo`  | revokes what a delegated decision committed | person only   |

No MCP tool: an agent can see that it is trusted only by the result of its own `propose` (`status: accepted,
by: delegation`).

## Testing (#43)

| test               | proves                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| no delegation      | a proposal waits in the queue                                                                       |
| live, in scope     | a proposal is accepted at once, as the person, on channel `delegation`, with `authority: delegated` |
| live, out of scope | a proposal in another scope waits                                                                   |
| never covered      | a conflict proposal waits; publishing and adopting still need the person                            |
| revoked            | the next proposal waits; earlier decisions stay until undone                                        |
| undo               | revokes the commit; the review stays; the history keeps both                                        |
| agent cannot grant | an agent credential cannot grant or revoke (`human_required`)                                       |
| another person     | a delegation of A never decides a proposal for B                                                    |

## Consequences

- The one decision path stays one: delegation calls it; it does not bypass it.
- A graph may now hold state a person never looked at. Every such value says so (`authority: delegated`) and can
  be listed and undone, so "the graph records what the person accepted" becomes "what the person accepted, or let
  the service accept for them, and which is which".
- Readers of shared understanding can tell the two apart.

## Alternatives considered

- **Let the agent confirm.** Simplest, but then any agent with a credential decides, and nothing records that the
  person delegated at all.
- **Auto-accept in the Workspace.** A page that clicks accept for the person hides the delegation in a client and
  leaves no record of it.
- **Delegation that also resolves conflicts.** Rejected: picking a side is exactly what the project keeps models
  from doing.
