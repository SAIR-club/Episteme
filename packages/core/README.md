# @episteme/core

Episteme Core — the graph itself, and nothing else.

Core contains no recommendation, voting, ranking, course generation, quiz, reputation, moderation,
agent workflow, teaching strategy or UI state. Those belong to a [Domain
Extension](../domain-learn/README.md) or an Application; putting them here would stop one ontology
from serving Learn, Forum and Research as a single shared substrate. The decision is recorded in
[ADR 0001](../../docs/decisions/0001-core-boundary.md).

Everything below runs with **no frontend, no LLM and no database**. That is a design constraint, not
a convenience.

## Modules

| Path          | Responsibility                                                                             |
| ------------- | ------------------------------------------------------------------------------------------ |
| `ontology/`   | `Node`, `Edge`, `Actor`, `Tag`, `StateEvent`, `SubGraph`; branded ids; time and provenance |
| `graph/`      | Type/dimension/tag registries, domain packs, and the `CoreGraph` façade                    |
| `events/`     | **Engram** — the append-only, branchable event log and `reduce`                            |
| `guards/`     | The single authoritative validation path (`validateMutation`)                              |
| `projection/` | `project()` — one graph, many views                                                        |
| `storage/`    | The `GraphStorageAdapter` port Core depends on                                             |
| `errors.ts`   | Error taxonomy with stable machine-readable codes                                          |

## Usage

```ts
import {
  createGraph,
  createRegistries,
  createEventLog,
  createFixedClock,
} from '@episteme/core'
import { createMemoryStorage } from '@episteme/storage-memory'

const registries = createRegistries()

const clock = createFixedClock(0)
const actorId = asId<ActorId>('actor_learner')
const graph = createGraph({ storage: createMemoryStorage(), registries, clock, actorId })
const log = createEventLog({ registries, clock, graph, defaultActorId: actorId })
```

A complete, runnable example is [`examples/learn-session`](../../examples/learn-session).

## The four things worth knowing

**Nothing is overwritten.** There is no update and no delete on the event log. A change of mind is a
new `StateEvent`; a change of direction is a `fork`. Current state is always `reduce(events)` —
`foldEvents` — and the internal cache is an optimisation that may be discarded at any time. See
[ADR 0002](../../docs/decisions/0002-event-sourced-cognitive-state.md).

**One validation path.** Every mutation goes through `validateMutation`, which runs structural checks
and then registered guards. Adapters store entities and must not enforce rules of their own, because
a second authority would diverge. Refusals are values (`previewNode`/`previewEdge` return a
`MutationRefusal`), so "an agent suggests, a human decides" needs no exception control flow.

**Vocabulary must be registered.** Node types, edge types, state dimensions and tag namespaces go
through their registries before use. Re-registering an id is an error, never an overwrite;
`registerIfAbsent` is the idempotent form that lets two packs share a vocabulary.

**No hidden identity or clock.** Time comes from a `Clock`, ids from an `IdFactory` or from the
caller-supplied draft, so a history is replayable and output is byte-stable. See
[ADR 0003](../../docs/decisions/0003-storage-abstraction.md).

## Fork lineage

Every event records its `parent` — the previous event on the same branch — and, when it opens a fork,
the `forkedFrom` point. `predecessorOf` follows either, so one reduction folds a whole lineage.

A branch is a **line of inquiry** with its own readable state. Reading a named branch stitches its
ancestry: each ancestor contributes the prefix ending where the next branch forked from it, so a
branch that went back to an earlier understanding does **not** inherit changes made afterwards on the
original line. `stateOf(target, actor, { branchId })` is that scoped read; **any** event may be a fork
point. See [ADR 0005](../../docs/decisions/0005-fork-lineage.md).

## Note for contributors

Vitest resolves `@episteme/core` through `dist/`, so run `pnpm typecheck` or `pnpm build` before
`pnpm test` after editing this package, or the tests will run against stale compiled output.
