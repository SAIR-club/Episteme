# @episteme/storage-sqlite

Durable storage in one SQLite file: the same records as `@episteme/storage-local`'s JSONL file, behind the same
graph and event-log ports. See [ADR 0017](../../docs/decisions/0017-sqlite-storage.md).

What it adds over JSONL:

- **No lock left behind.** The file is held with `locking_mode=EXCLUSIVE`, a lock the operating system releases
  when the process exits in any way, killed outright included. A second opener is refused with
  `GraphLockedError`, as with JSONL.
- **Crash safety.** Each save is one WAL transaction (`synchronous=FULL`); a crash mid-save leaves the previous one.

Nothing else changes: the whole history is still read into memory on open and written on save.

## Usage

A session or service picks it from the path: a graph ending in `.db`, `.sqlite` or `.sqlite3` is SQLite.

```sh
pnpm serve --graph ~/.episteme/learn.db
pnpm serve graph import ~/.episteme/learn.jsonl ~/.episteme/learn.db   # copy an existing graph in
pnpm serve graph export ~/.episteme/learn.db ~/.episteme/learn.jsonl   # and back out, as plain text
```

Directly:

```ts
import { openSqliteStorage } from '@episteme/storage-sqlite'

const storage = await openSqliteStorage('graph.db')
// ... compose Episteme over it, as with openLocalStorage
await storage.save()
await storage.close()
```
