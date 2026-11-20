# `.epi` quick start

An `.epi` file (Episteme Knowledge File) carries one graph's understanding in a single JSON
document: what the knowledge is, what vocabulary it uses, how one or more people understand it, how
that understanding evolved, and what has been deliberately shared. The format's contract is
[ADR 0023](../decisions/0023-epi-knowledge-format.md); this page shows how to use it.

## The two capabilities

Every file declares what it carries in `profiles`:

| profile | carries | can restore a graph? | typical use |
| --- | --- | --- | --- |
| `archive` | the v1 portable export, byte-for-byte, under `archive.history` | yes | backup, moving a graph between machines |
| `knowledge` | an ontology manifest + a derived knowledge projection | no, and it never claims to | reading, sharing, publishing |

A file may carry both (Episteme's own exports do). A knowledge-only file is the sharing shape: it is
verifiable against its receipt and honest about not being a backup.

## Write: export from a live graph

```ts
import { exportEpiFile } from '@episteme/storage-sqlite'
import { applicationPackDefinitions } from '@episteme/application'
import { defineDomainPack, type DomainPackDefinitions } from '@episteme/core'

// Keep a scene's vocabulary as data beside its pack, so the manifest cannot drift from what the
// session registers. The application's own pack already exports its definitions.
const sceneDefinitions: DomainPackDefinitions = { /* the scene's vocabulary */ }
const scenePack = defineDomainPack('my-scene', sceneDefinitions)

const packs = [
  { name: 'episteme-application', definitions: applicationPackDefinitions },
  { name: scenePack.name, definitions: sceneDefinitions },
]
// Refuses while another connection holds the graph, and refuses to replace an existing file.
await exportEpiFile('graph.db', 'graph.epi', {
  build: 'my-app-1.0',
  packs, // the vocabulary the file declares, as data
})
```

The knowledge projection is derived through Core itself from the very records the archive carries,
and names its inputs (`derivedFrom`: history checksum, ontology checksum, filter). Changing the
history, the manifest or the filter makes the receipt detectably wrong — `readEpiFile` refuses such
a file as `projection_mismatch`.

## Read: without starting Episteme

`@episteme/epi-reader` depends only on `@episteme/epi-format` — no Core, no service, no Domain Pack
code. A minimal consumer:

```ts
import { readFile } from 'node:fs/promises'
import { openEpi, outlineView, timelineView } from '@episteme/epi-reader'

const epi = openEpi(await readFile('graph.epi', 'utf8'))
// Hash integrity only: the bytes are the ones that were written. This does not re-derive the
// projection — see "Two different verifications" below.
epi.verifyIntegrity() // re-checks the checksums; throws EpiFileError on mismatch

epi.format                 // 'episteme-knowledge'
epi.restorable             // true when an archive section is carried
epi.nodesByType('claim')   // [{ id: 'k_position', text: 'Attention needs …' }, …]
epi.edges()                // typed relations: answers, supports, contradicts, …
epi.stateOf('k_position')  // per-actor understanding: { confidence: { level: 'low' }, … }
epi.historyOf('k_position') // visible revision clues from the archive, revocations marked
epi.publications()         // what another reader may reuse
outlineView(epi)           // one organization: nodes hung beneath what they answer or support
timelineView(epi)          // another: the revision thread, in the archive's commit order
```

Views are derived presentation: they reference the file's own stable ids, copy no knowledge, and
rebuild identically from the knowledge section alone.

## Two different verifications

Checksums and replay prove different things, and neither stands in for the other:

- `readEpiFile` and `epi.verifyIntegrity()` check **hash integrity**: the bytes are the ones that
  were written, and the receipt names inputs the file actually carries. A tamperer who edits the
  knowledge section and recomputes its checksum passes every hash.
- `verifyEpiProjection(epi)` in `@episteme/storage-sqlite` checks **replay consistency**: it refolds
  the carried archive history through Core, under the manifest and filter the file itself declares,
  and refuses as `projection_mismatch` unless the result is exactly the knowledge section the file
  carries.

```ts
import { verifyEpiProjection } from '@episteme/storage-sqlite'

verifyEpiProjection(epi) // throws EpiFileError('projection_mismatch') on a forged projection
```

A knowledge-only file carries no history, so there is nothing to replay: it is refused rather than
waved through with an unverified claim.

## Publish: share one publication, not the whole graph

```ts
import { exportPublishedEpi } from '@episteme/storage-sqlite'

// Whitelist-first: the inclusion set comes from the persisted Publication record, re-verified
// against the graph's records before anything is serialized. The file ships the knowledge-only
// profile — no history, no state, no branches — so private material never enters the bytes.
await exportPublishedEpi('graph.db', 'shared.epi', {
  build: 'my-app-1.0',
  packs,
  actorId: 'actor_human',
  root: 'k_position',
})
```

Refusals are named (`no_publication`, `ambiguous_publication`, `withdrawn_publication`,
`unsafe_publication`); a member that cannot be proven safe refuses the whole export rather than
being silently omitted.

## Refusals

Reading a file that claims more than it proves is a refusal, never a warning
(`EpiFileError.code`):

| code | meaning |
| --- | --- |
| `not_an_epi` | the text is not JSON, or the format string is not `episteme-knowledge` |
| `unsupported_version` | a newer (or older) version than this build reads |
| `invalid_profiles` | `profiles` is empty, or names an unknown profile twice |
| `missing_section` | a claimed profile's section is absent |
| `damaged` | a checksum failed, a section is unreadable, a time is not ISO 8601 UTC |
| `projection_mismatch` | the receipt names a history or ontology this file does not carry, or a refold of the carried history does not reproduce the knowledge section |

Storage-level refusals (`GraphExportError`): `target_exists`, `no_graph`, `no_publication`,
`ambiguous_publication`, `withdrawn_publication`, `unsafe_publication`, and the v1 codes.

## Compatibility

- A v2 build reads v1 files (`.epi` with `format: "episteme-graph-export"`), which restore exactly
  as before; a v2 archive restores through the same path.
- A v1 build refuses v2 files as `unsupported_version` — the same refusal any build gives a newer
  format, so no file is ever silently misread.
- A worked example lives at [`docs/epi/example.epi`](example.epi) — the positional-encoding case:
  material, initial understanding, the NoPE conflict, a fork, a retraction and a publication. The
  JSON Schema is [`docs/epi/epi-v2.schema.json`](epi-v2.schema.json).
