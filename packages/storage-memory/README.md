# @episteme/storage-memory

The in-memory `GraphStorageAdapter`. The v0 backend: no infrastructure, fully replaceable.

v0 starts here rather than with a graph database because the project's question is how understanding
evolves, not how to operate infrastructure. It is a single small class, and swapping it for SQLite or
a graph database should mean implementing one interface and changing one constructor argument.

## Usage

```ts
import { createMemoryStorage } from '@episteme/storage-memory'

const storage = createMemoryStorage()
```

## What it does

- Stores nodes and edges in `Map`s, keyed by id.
- Keeps adjacency **indexed in both directions**, because traversal is the hot path for projection.
- On `putEdge`, releases the previous adjacency entries before writing, since an edge id is immutable
  in its endpoints and a stale neighbour would otherwise survive the write.

## What it deliberately does not do

- **Validate.** `validateMutation` is the single authority and lives in the graph layer. A backend
  that also enforced rules would be a second, divergent authority.
- **Generate ids or timestamps.** Those arrive on the entities from the caller.
- **Persist.** Everything is lost when the process exits. Durable storage is
  [`storage-sqlite`](../storage-sqlite/README.md).

## Known limitation

`deleteNode` removes only the node, not its incident edges, and Core does not expose physical deletion
in v0 — removed history is a **revoke**. If deletion is exposed later, cascade behaviour has to be
decided and routed through the guards, not added quietly here.
