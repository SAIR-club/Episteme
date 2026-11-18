# 0023 — `.epi` v2: a knowledge file with an archive, an ontology manifest and a verifiable projection

Status: **proposed** (2026-11-18). Builds on [ADR 0022](0022-epi-file-format.md) (the `.epi` file type),
[ADR 0018](0018-sqlite-only.md) (SQLite-only persistence), [ADR 0002](0002-event-sourced-cognitive-state.md)
(history is the authority) and [ADR 0004](0004-domain-extension-boundary.md) (vocabulary lives in packs).

## Context

ADR 0022 gave the portable export a file type, but the v1 container still carries the storage layer's
serialization: record bodies a third party cannot interpret without Episteme's own code and packs. A
tool that only wants to show a person's concepts, claims, relations and understanding state would have
to restore a whole private graph to do it — and a graph export is the wrong thing to share anyway,
because it carries every draft and every private event.

What is missing is a file that says directly: here is the knowledge, here is the vocabulary it uses,
here is who understands what — while the event history stays the only authority and a derived view of
it never becomes a second truth.

## Decision

**`.epi` v2 is one file type with two named capabilities, `archive` and `knowledge`, declared in the
header and never confused.**

1. **One format family, one version gate.** `format: "episteme-knowledge"`, `version: 2`
   (`EPI_FORMAT`, `EPI_VERSION` in `@episteme/epi-format`). A v1 file keeps `format:
   "episteme-graph-export"` and is accepted unchanged; a v2 file is refused by a v1-only reader as
   `unsupported_version`, the same refusal any build gives a newer format.

2. **Two profiles, two capabilities.** `profiles` is a non-empty array over the known values:
   - **`archive`** — the v1 portable export carried byte-for-byte under `archive.history`. Restorable:
     the whole graph comes back through the existing v1 import. Its integrity rule is v1's own, so the
     history section of a v2 file verifies exactly as a v1 file does.
   - **`knowledge`** — an ontology manifest plus a derived knowledge projection. Readable without
     starting Episteme or running any pack's behaviour; restorable it is not, and it never claims to be.

   A file may carry both. A claimed section that is absent (`missing_section`), a checksum that fails
   (`damaged`), or an unknown profile (`invalid_profiles`) is a refusal, never a warning. A knowledge
   file without `archive` is the sharing shape: readable, verifiable against its receipt, and honest
   about not being a backup.

3. **Vocabulary travels as data.** The `ontology` manifest carries each pack's *definitions* — node
   types, edge types, state dimensions, tag namespaces — with a `revision` hash and a `sha256` over the
   canonical manifest. Behaviour never travels (ADR 0004). In the code base the definitions are
   extracted constants consumed by `defineDomainPack`, so the registry a session uses and the manifest
   an export writes cannot drift apart.

4. **The knowledge projection is a cache with a receipt.** It is derived from the very records the
   archive carries, through Core itself: records load via `RecordStorage` (the one records-to-memory
   implementation) into an `EventLog` as `initialState`, and the projection is `project()` over the
   wired view. Fork ancestry, revocation exclusion and per-actor state come from Core unchanged; the
   derivation invents no second semantics. The section carries `derivedFrom` — the history's checksum,
   the ontology's checksum and the projection filter — plus its own `sha256` over the canonical
   serialization. A file whose receipt names a history or ontology it does not carry is refused as
   `projection_mismatch`. A receipt pins inputs; it does not prove a derivation. Replay verification
   (`verifyEpiProjection` in `@episteme/storage-sqlite`) refolds the carried history through Core
   under the file's own manifest and filter, and refuses as `projection_mismatch` unless the refold
   reproduces the carried knowledge section — hash integrity and replay consistency are separate
   claims, and only the archive profile admits the second, because a knowledge-only file has no
   history to replay and is refused rather than verified.

5. **Determinism is by stable keys, and canonical JSON is a pinned JCS subset.** Ids of edges,
   branches and publications are content-independent UUIDs, so sorting by id would make the same
   history produce different bytes across runs. Nodes, branches and publications order by
   `[createdAt, id]`; edges order by `[type, from, to, createdAt, id]`; state orders by target then
   actor with dimensions sorted by name. Canonical serialization follows RFC 8785 (JCS) where JSON
   has one answer: UTF-8 without BOM, no insignificant whitespace, object keys sorted by UTF-16 code
   units, strings escaped per RFC 8785's rules. Array order is not canonicalized away: record order,
   projection order and profile order are part of the contract, because the history's `seq` order is
   what folding depends on. This keeps the history section byte-compatible with v1's
   `JSON.stringify` digest rule.

6. **Reading is validating.** `readEpiFile` checks the envelope, the profiles, every claimed section,
   every checksum and every receipt, and refuses with one of
   `not_an_epi | unsupported_version | invalid_profiles | missing_section | damaged |
   projection_mismatch`. Import never needs the knowledge section: the history alone restores the
   graph, and a knowledge-only file is refused on import rather than faked. The `views` section is
   the one exception to strict refusal, on purpose: it is derived presentation, checksummed by
   nothing and authoritative in nothing, so a broken view entry is dropped and the knowledge reads
   on — a view is never the truth's hostage.

7. **Ownership rules carry over.** Written once, never over an existing file, mode `0o600`, exported
   under an exclusive hold, imported only into a new graph. Scoped export (sharing a publication's
   subgraph without the private rest) is built on the whitelist-first rule: the inclusion set is
   computed from Publication records and visibility rules *before* serialization; material that cannot
   be shown to be safe is refused, never silently redacted. Its own ADR follows when it lands.

## Consequences

- A third party needs only `@episteme/epi-format` (JSON parsing and hashing, no Core, no SQLite) to
  read an `.epi` file's header, ontology, knowledge and integrity — the G3 reader builds on this.
- The knowledge section can go stale against a live graph, by design: it is a claim about a history
  identified by checksum, and `derivedFrom` makes staleness detectable, never silent.
- v1 files keep opening in v2 builds, and v2 archives restore through the v1 path unchanged; the
  version gate is honest in both directions.
- Declaring v2 a stable interchange standard is a separate decision, made by the project owner, not by
  shipping this format.
