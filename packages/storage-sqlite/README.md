# @episteme/storage-sqlite

Episteme's durable storage: one SQLite file per graph, behind the graph and event-log ports. See
[ADR 0017](../../docs/decisions/0017-sqlite-storage.md) and [ADR 0018](../../docs/decisions/0018-sqlite-only.md).

What one file holds:

- **The graph's history**, one record per row of `records`, in the order they are written. The whole history is
  read into memory on open and written back on save, in one transaction.
- **The stores kept with the graph**: drafts, distilled material, conversations and scene records, each a named log
  in `companions` (`storage.companion(name)`). They share the graph's connection, so they have its one owner.

And how it is held:

- **One owner, no lock left behind.** The file is held with `locking_mode=EXCLUSIVE`, a lock the operating system
  releases when the process exits in any way, killed outright included. A second opener, in this process or
  another, is refused with `GraphLockedError`.
- **Crash safety.** WAL with `synchronous=FULL`: a crash mid-save leaves the previous save.
- **Format version** in `user_version`, currently 2. A file in another format is refused, not guessed at.

## Usage

```sh
pnpm serve --graph ~/.episteme/learn.db
```

Directly:

```ts
import { openSqliteStorage } from '@episteme/storage-sqlite'

const storage = await openSqliteStorage('graph.db')
// ... compose Episteme over it (`openEpisteme` in @episteme/sdk)
const drafts = storage.companion('suggestions')
await drafts.append(JSON.stringify({ kind: 'example' }))
await storage.save()
await storage.close()
```

While a graph is open nothing else can read its file, so inspect it with a SQLite client (`sqlite3 graph.db`) after
its owner has closed it.
