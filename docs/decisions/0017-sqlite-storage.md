# 0017 — SQLite storage: the same history, a lock the operating system holds

Status: **proposed** (2026-10-28). Amends [ADR 0006](0006-persistence-format.md) where it says _why JSONL and not
SQLite_. Discussed in #72; replaces the stale-lock reclaim of #84.

## Context

The JSONL backend marks its single owner with a `graph.jsonl.lock` file. A process that exits normally or on an
uncaught error removes it; a process killed outright (`kill -9`, Task Manager, a crashed terminal) cannot, and
the next start fails with `GraphLockedError` until a person deletes the file. Reclaiming such a lock from user
space (#84) is possible but has edges no file lock can close: a recorded pid may be reused by an unrelated
process, and a process killed mid-reclaim leaves a file of its own behind.

ADR 0006 chose JSONL over SQLite because `node:sqlite` was experimental and a native driver would put a build
step between a learner and their history. `better-sqlite3` now ships prebuilt binaries for every platform and
Node release the project supports (Node 20 to 26, Windows x64 included), so installing it needs no compiler.

## Decision

**Add a SQLite backend, `@episteme/storage-sqlite`, beside JSONL. Change nothing above the storage port.**

1. **Same records, same semantics.** The SQLite file holds the JSONL records one row each, in the order they are
   written. The whole history is read into memory on open and written on save, exactly as with JSONL, so the
   in-memory graph (`foldEvents`) and every interface above the adapter are unchanged. The in-memory part both
   backends share is one base class, `RecordStorage`, in `@episteme/storage-local`.
2. **One owner, held by the kernel.** The file is opened with `locking_mode=EXCLUSIVE` and locked at once, so a
   second opener, in the same process or another, is refused with `GraphLockedError`. One graph keeps exactly
   one owner, as before. The lock is a file lock the operating system holds (`LockFileEx` on Windows, `fcntl`
   elsewhere): any exit, a kill included, releases it, so no lock is ever left behind. A second opener is
   refused at once rather than waited for.
3. **Crash safety.** A save is one transaction in WAL mode with `synchronous=FULL`. A crash mid-save leaves the
   previous save, recovered from the write-ahead log on the next open.
4. **Chosen by the path.** A graph path ending in `.db`, `.sqlite` or `.sqlite3` is SQLite; any other path is
   JSONL, so the default graph and every existing one are untouched. The driver is loaded only for a SQLite
   graph.
5. **Moving between them.** `copyGraph(from, to)` copies a graph into the backend the target path names, with its
   companion files (drafts, sources, threads, scene records). The service exposes it as `graph import` (JSONL to
   SQLite) and `graph export` (SQLite to JSONL), so a graph stays readable as plain text whenever someone wants to
   inspect it.
   - It never writes over anything: no file the copy would write may exist yet, so every file it writes is its own.
   - One copy into a target at a time. The copy holds a record beside the target (`<target>.copying`, a small
     SQLite file) with the same operating-system lock as a graph, for its whole run. A second copy into the target,
     from any source, is refused and touches nothing; so is opening the target. SQLite's transaction covers the
     graph only, not the companion files, which is why this record exists.
   - Only its own files are removed. Before writing a file the copy adds it to the record, and clears the record
     when it finishes. A copy that fails removes the files on its record. A copy whose process is gone leaves the
     record unheld but not empty: the target is refused as unfinished, and the next copy into it takes the record,
     checks that it names this target and only this target's files, removes exactly those and starts over. A
     record that cannot be checked is refused with nothing removed.
   - A killed import also leaves its JSONL source locked, as any killed JSONL owner does; that lock is removed by
     hand as before.

## Not in this decision

Querying the database instead of loading it whole, vector search (`sqlite-vec`), full-text search (FTS5) and
moving the companion files into the database are each a separate step, decided when one is needed. They are why
SQLite was chosen over keeping JSONL, but none of them is required to fix the lock.

## Consequences

- A killed process no longer blocks the next start of a SQLite graph. A JSONL graph behaves as before.
- Installing Episteme downloads a native driver. `better-sqlite3` is allowed to run its install script
  (`pnpm-workspace.yaml`), which fetches the prebuilt binary.
- A SQLite graph is not a text file. `graph export` turns it back into one.
- Which backend is the default is left for later, once SQLite has been used on real graphs.
