# 0006 — Persistence format

Status: **accepted**; the choice of JSONL is superseded by [ADR 0018](0018-sqlite-only.md). What is written, the
whole history as records, and the sync/async bridge still hold.

## Context

Phase 0 kept everything in memory: a restart erased the graph. Graph is the whole point of the
project — "a user's understanding must survive process restart and still affect future interaction" —
so this had to be fixed without letting the choice of backend leak into Core's semantics.

Two questions had to be answered together, because the answer to the second depends on the first:

1. **What is written?** Reduced current state is small and convenient, but if only reduced state is
   stored then the trajectory — the thing this system exists to keep — is gone.
2. **What writes it?** `node:sqlite` is available on Node 22+, but it is still experimental, and a
   native driver would put a build step between a learner and their own history.

There was also a structural problem to solve. Core's graph port is **synchronous** (`putNode`,
`getNode`) while a durable store is naturally **asynchronous**. Any design had to bridge that without
making every read a promise or letting an adapter become a second authority on validation.

## Decision

**One append-only JSONL file, behind two ports Core already had or needed.**

### What is persisted

| Record       | Why it is a fact rather than derived data                              |
| ------------ | ---------------------------------------------------------------------- |
| `branch`     | lineage: `parentBranchId` and `forkPoint` cannot be recomputed         |
| `event`      | the history itself, dimensions as an array of pairs                    |
| `node`       | structure, including `revoked` / `revokedAt`                           |
| `edge`       | structure                                                              |
| `revocation` | a retraction is appended data, not a mutation of the event it retracts |

Every record is stamped `{ schemaVersion: 1, kind }`. A reader that does not recognise the version or
the kind **throws** rather than skipping, because silently ignoring a line would present a truncated
history as a complete one — which would look like a learner who never understood something rather
than like a broken file.

**Reduced state is never written.** Current understanding is always `reduce(events)` over the reloaded
log. The branch→events index and the subject index are rebuilt on load. This is not merely tidy: an
index that had to be trusted is indistinguishable from corrupt history when it disagrees with the
facts, and persisting `branchEvents` was in fact the first bug found here — it wrote empty arrays that
shadowed the rebuilt index and made every branch look empty.

### The two ports

- **`GraphStorageAdapter`** — already existed. `storage-local` implements it in memory, loading the
  file on `open()` and writing it on `save()`. Reads stay synchronous.
- **`PersistentEventStore`** — added to Core: `load(): Promise<EventLogState | undefined>` and
  `save(state): Promise<void>`. Core owns the shape of `EventLogState` because it is Core's history;
  the adapter owns how it reaches disk.

Nothing about Core's semantics changed. Guards, reduction, forking and actor isolation are untouched;
the adapter only carries facts.

`load()` returns `undefined` — not an empty state — when there is no history. This is load-bearing: an
empty _state_ is "restored" and fails, whereas `undefined` means "start a new history".

### Atomicity, and ids

Writes go to a temporary file and are then renamed, so a crash mid-write leaves the previous complete
history intact. Losing the last session is survivable; reading a truncated history as complete is not.

The event log **resumes its id counter** past the ids it restored (`IdFactory.resume`). Restarting at
`evt_1` would make two different moments share one identity, and the collision would be silent.

### Why JSONL and not SQLite

- **No dependency.** A native driver or an experimental built-in would gate the project on a Node
  version or a build step. JSONL needs nothing and runs on the Node this project already targets.
- **Inspectable.** The whole claim of the project is that its records can be examined. A line-delimited
  file is readable and diffable by a human without a tool.
- **Human-speed writes.** A personal cognitive graph grows at the rate a person types. Scanning a small
  file is not the constraint; query planning is not yet a problem worth buying complexity for.
- **It is a port.** If the file ever becomes the bottleneck, a SQLite backend replaces this class and
  Core does not change. The cheap choice was available precisely because the seam was drawn first.

## Alternatives

**Persist only reduced state.** Smallest file and the simplest restore: read the dimensions, done. Rejected
because it destroys the trajectory. "I used to understand it this way" would no longer be answerable,
which is the project's first acceptance criterion.

**Persist a snapshot plus a delta log.** The conventional event-sourcing answer, and the right one at a
different scale. Rejected for now as premature: it adds compaction, snapshot invalidation and a
consistency problem between snapshot and delta, to solve a file-size problem that does not exist yet.

**SQLite via `node:sqlite`.** Real queries, real indexes, real transactions, no new dependency. Rejected
because it is experimental and available only on newer Node than the project targets, so it would turn a
version requirement into a runtime failure for some users.

**A native SQLite driver (better-sqlite3).** Mature and fast. Rejected because it requires a
platform-specific build step, which is a poor trade for a local-first tool whose data is human-scale.

**Write through on every mutation.** Strongest durability: a commit is on disk before it returns.
Rejected because Core's graph port is synchronous, so it could only be approximated by blocking or by
fire-and-forget writes whose failures nobody observes. An explicit `persist()` at a session boundary is
honest about when data is durable.

**Make the graph port asynchronous.** Would allow a real async backend throughout. Rejected because it
would change every Core read for a capability the current backend does not need: the file is in memory
after `open()`.

## Consequences

- Understanding survives restart, proven by a test in which the two halves share no memory: session 2
  reads a _second_ adapter object built from the same file.
- Core is unchanged apart from one added port and an optional `resume` on the id factory.
- Durability is an explicit act (`persist()` / `save()`) rather than an invisible one, so a caller can
  see where the boundary is.
- The whole file is rewritten on save. Fine at human scale, and the first thing to revisit if a graph
  ever gets large.
- No compaction, no concurrency control and no encryption at rest. The first two are acceptable for a
  single local user; **encryption is a real gap**, because personal cognitive history is sensitive and
  the file is plain text by design.
