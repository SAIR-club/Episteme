# @episteme/storage-local

Durable local storage: one append-only JSONL file that implements both the graph port and the
event-log port.

This is what makes a user's understanding outlive the process. See
[ADR 0006](../../docs/decisions/0006-persistence-format.md) for why the format is JSONL rather than
SQLite, and [state-events.md](../../docs/architecture/state-events.md) for what is being stored.

## Usage

```ts
import { openLocalStorage } from '@episteme/storage-local'

// Session 1
const storage = await openLocalStorage('graph.jsonl')
const episteme = await composeOver(storage)

episteme.graph.addNode(/* ... */)
episteme.log.commit(/* ... */)

await episteme.log.persist() // hands the event history to the store
await storage.save() // writes the file, atomically
await storage.close() // gives up the graph, so the next session can open it

// Session 2 — a new process, the same file
const reopened = await openLocalStorage('graph.jsonl')
const restored = await composeOver(reopened)
restored.log.stateOf(claimId, actorId) // understanding is back, derived from the reloaded events
```

## What it stores

| Record kind  | Contents                                               |
| ------------ | ------------------------------------------------------ |
| `branch`     | id, actor, `parentBranchId`, `forkPoint`, `createdAt`  |
| `event`      | the full `StateEvent`, dimensions as an array of pairs |
| `node`       | the full graph node, including `revoked` / `revokedAt` |
| `edge`       | the full graph edge                                    |
| `revocation` | which event was retracted, when, and why               |

Every record carries `schemaVersion: 1` and a `kind`, so a reader can tell what it is holding and a
future format change can be migrated rather than misread.

**Event history is the source of truth; reduced state is never written.** Current understanding is
always recomputed by folding the reloaded events. An index that had to be trusted would be
indistinguishable from corrupt history when it disagreed with the facts — so the branch→events index
and the subject index are rebuilt on load, never persisted.

## API

| Member                                                        | Purpose                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `open()`                                                      | takes ownership, then reads the file; a missing file is an empty history |
| `close()`                                                     | releases ownership; does not save                                        |
| `save(state?)`                                                | absorbs event-log state if given, then writes the whole file atomically  |
| `load()`                                                      | the persisted history, or `undefined` when there is none                 |
| `getNode` / `getEdge` / `listNodes` / `listEdges` / `edgesOf` | the graph read port                                                      |
| `putNode` / `putEdge` / `revokeNode` / `revokeEdge`           | the graph write port                                                     |

`load()` returning `undefined` rather than an empty state is load-bearing: an empty _state_ would be
"restored" and fail, whereas `undefined` correctly means "start a new history".

## Properties worth knowing

- **One owner per file.** `open()` creates `<file>.lock` atomically and refuses with `GraphLockedError`
  while another adapter holds it, in this process or another. Two owners would each resume their own id
  counter and rewrite the whole file, so they would collide on ids and overwrite each other without any
  error ([ADR 0008](../../docs/decisions/0008-agent-plugin-surface.md)). The lock is released by `close()`,
  or at process exit. Only a process killed outright leaves it behind. Such a lock is never reclaimed
  automatically, because two processes could both decide it was stale; the error names the file to delete.
- **Atomic writes.** A temporary file plus a rename, so a crash mid-write leaves the previous complete
  history intact. Losing the last session is survivable; reading a truncated history as if it were
  complete is not.
- **Truncation fails loudly.** A half-written final line raises an error naming the line number,
  rather than being silently skipped and reported as a shorter history.
- **Ids never restart.** The event log resumes its counter past the ids it restored, because reusing
  `evt_1` would make two different moments share one identity.
- **Retraction is appended, not rewritten.** A revoked entity is written as a new record, so the
  record of the retraction survives alongside what it retracted.
- **No physical deletion.** `deleteNode`/`deleteEdge` exist on the port but nothing calls them;
  removal is a revoke, and erasure is reserved for privacy and legal compliance.

## Known limitations

- The whole file is scanned on open and rewritten on save. A personal cognitive graph is written at
  human speed, so this is not the constraint yet; the port is where a chunked or SQLite backend would
  go if it ever becomes one.
- No compaction: retracted records and superseded nodes accumulate. Forgiving for now, and bounded by
  human-scale writing.
- One owner at a time. A second surface over the same graph is refused rather than coordinated.
- No encryption at rest. Personal cognitive history is sensitive, so this matters before any real use.
