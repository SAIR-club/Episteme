# 0018 — SQLite only: one database file per graph

Status: **proposed** (2026-10-29). Supersedes [ADR 0017](0017-sqlite-storage.md) decisions 4 and 5, and
[ADR 0006](0006-persistence-format.md) where it chooses JSONL. Discussed in #72.

## Context

ADR 0017 added SQLite beside JSONL and chose between them by the graph's file extension, keeping JSONL as the
default. That left two backends to maintain and test, a rule hidden in a file name, and the JSONL lock file that a
killed process leaves behind. It also left a graph's companion stores (drafts, sources, threads and scene
records) as four JSONL files beside the graph, outside the database's transactions. Copying a graph had to coordinate
five files, which is what the `.copying` record, its file journal and its recovery existed for.

Episteme has no deployed graphs to carry over, so keeping JSONL for compatibility buys nothing.

## Decision

**A graph is one SQLite file. JSONL is removed, with no compatibility path and no importer.**

1. **One backend.** `@episteme/storage-sqlite` is the only durable storage. `@episteme/storage-local` is
   removed. What ADR 0017 says about ownership (`locking_mode=EXCLUSIVE`, refused at once with
   `GraphLockedError`) and crash safety (WAL, `synchronous=FULL`) is unchanged. Any path opens as SQLite. The
   default graph is `~/.episteme/learn.db`.
2. **The companion stores live in the same file.** Each store writes to a named log in the graph's database (the
   `companions` table: name, sequence, body) instead of a file beside it. The bodies are the same JSON records the
   files held. They share the graph's connection, so they have the graph's single owner by construction, and an
   append or a replacement is one durable transaction.
3. **No copying machinery.** `copyGraph`, `graph import`, `graph export` and the `.copying` record are removed:
   there is no second format to move between. A copy of a graph, everything in it, is SQLite's online backup
   (`backUp`), which the session already takes before the first publication.
4. **A new file format.** The format version (`user_version`) is 2. A file in any other format is refused, not
   migrated: the only format-1 files were written by ADR 0017's backend, which nothing has used.
5. **Node 22 or later.** Node 20 left maintenance in April 2026. Dropping it lets the project use `better-sqlite3`
   13, which requires Node 22.

## Not in this decision

- **One transaction across the graph and its companion stores.** Each store still writes on its own, as it did to
  its own file, so a decision still relies on the session's recovery of half-done decisions. Sharing a connection
  makes a single transaction possible later; it is a change to how a decision writes, not to storage.
- Querying the database instead of loading it whole, `sqlite-vec` and FTS5 remain separate steps, each decided
  when it is needed.

## Consequences

- A killed process never leaves a lock. There is one storage code path to test.
- Backing up, moving or deleting a graph is one file (with its `-wal` while open).
- A graph is no longer a text file. Inspecting one takes a SQLite client, such as the `sqlite3` shell.
- Installing Episteme needs Node 22 or later. `better-sqlite3` 13 carries its prebuilt driver in the package, so
  nothing is downloaded or compiled at install: its build from source is refused in `pnpm-workspace.yaml`.
