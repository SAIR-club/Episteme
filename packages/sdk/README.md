# @episteme/sdk

The composition surface: one place where storage, registries, graph and event log are wired together
in the correct order.

## Why this exists

Core deliberately exposes its parts separately — storage, registries, graph, event log — because each
has to be replaceable and testable on its own. Every consumer then has to wire the four together, and
**getting the order wrong is not a type error**:

```text
1. read the store            (what history exists?)
2. build the graph           (over that storage)
3. build the event log       (validating against that graph)
4. wire the graph to the log (so state-filtered projections work)
```

A log built before the graph has loaded will reject writes that are perfectly legal, because every
commit is validated against the graph. That mistake is easy to make once, and it was in fact made while
building this package.

By Phase 1 the wiring existed twice — in `tests/fixtures.ts` and again in the persistent demo — which is
the signal the placeholder README predicted for promoting it here.

This is **not** a second way to use Core. It composes Core's public API and adds nothing Core already
does: no mutation path of its own, no validation, no caching.

## Usage

```ts
import { agentActor, compose, humanActor, openEpisteme } from '@episteme/sdk'
import { openSqliteStorage } from '@episteme/storage-sqlite'
import { asId, type ActorId } from '@episteme/core'

// In memory — loses everything on exit.
const ephemeral = compose({
  actors: [humanActor(asId<ActorId>('actor_human'))],
})

// Durable — reads the file first, then composes over it.
const storage = await openSqliteStorage('graph.db')
const episteme = await openEpisteme(storage, {
  actors: [humanActor(asId<ActorId>('actor_human')), agentActor(asId<ActorId>('actor_scaffold'))],
})

episteme.graph.addNode(/* ... */)
episteme.log.commit(/* ... */)
await episteme.persist() // hands the history to the store
await storage.save() // writes the history, in one transaction
```

## API

| Member                                                    | Purpose                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------ |
| `compose(options)`                                        | wires an instance over the storage you give it               |
| `openEpisteme(store, options)`                            | reads the store first, then composes — the durable path      |
| `composeDeterministic(startedAt, options)`                | the same, on a fixed clock, for reproducible demos and tests |
| `humanActor(id, name, now)` / `agentActor(id, name, now)` | the two actor shapes, so callers do not invent them          |
| `Episteme`                                                | `{ graph, log, registries, actorId, persist() }`             |

## What it deliberately does not do

- **No identity model.** A composition is about _knowledge_, not users. The caller registers the actors it
  knows and names the human whose understanding is the subject; there is no authentication here and none
  is implied.
- **No policy.** Access control and the privacy default are expressed in the model
  (`Actor.shareByDefault`, per-actor state) but enforced nowhere yet. This package does not pretend
  otherwise.
- **No mutation helpers.** Adding a node goes through `graph.addNode`, which goes through
  `validateMutation`. A convenience method here that wrote directly would break the
  single-validation-path invariant.

## Note for contributors

Vitest resolves `@episteme/*` through `dist/`, so run `pnpm typecheck` or `pnpm build` before `pnpm test`
after editing this package — or simply use `pnpm test`, whose `pretest` does it for you.
