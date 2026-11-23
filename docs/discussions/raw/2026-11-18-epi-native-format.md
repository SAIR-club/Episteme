# .epi native knowledge format (v2) — design draft

Date: 2026-11-18. Status: **first cut implemented**; see ADR 0023
for the contract that landed (`packages/epi-format`, `buildEpiFile` in `@episteme/storage-sqlite`).
This draft stays as the discussion record; where it and ADR 0023 differ, the ADR is the contract.
Related: ADR 0022 (proposed), ADR 0018,
ADR 0013, ADR 0014.

## Goal

`.epi` v1 makes a graph portable, but what it carries is the storage layer's serialization: record
bodies a reader cannot interpret without Episteme's own code and packs. The goal of v2 is a native,
open, portable **knowledge file**: one `.epi` file that a third-party tool can read well enough to
show nodes, relations, sources and a person's state — without starting a service — while Episteme
itself still treats the event history inside it as the only authority.

Non-goals:

- Not a second data model. Everything in the file is derived from or declared to `CoreGraph`,
  the registries, `StateEvent`, `Actor`, `Source`, `Branch` and the companion logs.
- Not a learning-scene format. No dimension, node type or policy of any one application is baked in;
  scene vocabulary travels as data (see [Ontology manifest](#ontology-manifest)).
- Not a replacement for the SQLite graph. The file is a snapshot exchange format; the live graph
  stays one SQLite file under one owner.

## What the audit found

| v2 need | Status in the current code |
| --- | --- |
| Whole-graph records (node, edge, branch, event, revocation, publication, withdrawal), one schema version tag per record | Done — `PersistedRecord` in `packages/storage-sqlite/src/records.ts`; reusable as-is |
| Append-only history as the authority, nothing derived stored | Done — `serialization.ts` stores facts only; `foldEvents` rebuilds state |
| Fork lineage (branch, parent branch, fork point, `forkedFrom`) | Done — `Branch` and event fields; survives export verbatim |
| Deterministic projection (`project`, `selectSeeds`) | Done in memory; **canonical ordering for files is not yet specified** |
| Ontology registries and packs (`registerIfAbsent`, `defineDomainPack`) | Done — but **vocabulary lives in code**, so a portable file cannot name what its type ids mean |
| Companion logs (suggestions, sources, threads, scene records) inside the graph file | Done (ADR 0018); exported verbatim by v1 |
| Sources with digests and origins (ADR 0009/0011) | Done as a companion log; **no in-file addressing scheme for external references yet** |
| Lightweight third-party reader | **Missing** — the envelope is JSON, but record bodies are internal serialization |
| Scoped export (share a publication, keep the rest private) | **Missing** — v1 export is the whole graph, private material included |
| Projection snapshots cached beside the history | **Missing** — and must stay derived, never authoritative |

## Container layout

v2 keeps the `.epi` type and the v1 object intact, nested. One format family, one version gate:

```jsonc
{
  "format": "episteme-knowledge",   // new format string from v2 on; v1 files keep "episteme-graph-export"
  "version": 2,
  "exportedAt": "…",
  "source": { "file": "graph.db", "build": "…" },
  // Two capabilities, named, never confused. A knowledge-only file (sharing shape) omits "archive"
  // and stays honest about not being restorable.
  "profiles": ["archive", "knowledge"],

  // The v1 export object, byte-for-byte, under its own key with its own sha256. A v2 reader reuses
  // the v1 checks on it; a v1 reader refuses the whole file as unsupported_version, which is the
  // established behaviour — no file is ever silently misread.
  "archive": { "history": { "…exactly the v1 GraphExport…": "…" } },

  // What the writer had registered, so type ids can be interpreted without Episteme's packs.
  "ontology": { "…": "…" },

  // Derived, verifiable, never authoritative: the graph as nodes, edges, folded state.
  "knowledge": { "…": "…" },

  // Named, derived presentation over the knowledge section: outline, map — never a second truth.
  "views": [ "…" ]
}
```

Sections other than `archive` are optional and gated by the `profiles` list in the header. A claimed
profile whose section is missing, a failing checksum, or an unknown profile is a refusal
(`missing_section`, `damaged`, `invalid_profiles`) — never a warning.

## Schema example (abridged)

```jsonc
{
  "format": "episteme-knowledge",
  "version": 2,
  "profiles": ["archive", "knowledge"],

  "archive": {
    "history": {
      "format": "episteme-graph-export",
      "version": 1,
      "sha256": "…over the records and companions below…",
      "storedAs": { "sqliteFormat": 2, "recordSchema": 1 },
      "records": [ "…every persisted record, exact string…" ],
      "companions": [ { "name": "threads", "seq": 1, "body": "…" } ]
    }
  },

  "ontology": {
    "packs": [
      {
        "name": "default-session-pack",
        "revision": "…hash of the definitions…",
        "definitions": {
          "nodeTypes": [ { "id": "concept", "label": "Concept" } ],
          "edgeTypes": [ { "id": "supports", "label": "supports", "category": "epistemic",
                           "from": ["evidence", "claim"], "to": ["claim"] } ],
          "stateDimensions": [ { "id": "confidence", "kind": "ordinal", "ordered": true,
                                 "levels": ["low", "medium", "high"] } ],
          "tagNamespaces": [ { "namespace": "topic", "label": "Topic" } ]
        }
      }
    ],
    "sha256": "…over the canonical JSON of packs…"
  },

  "knowledge": {
    "derivedFrom": { "historySha256": "…", "ontologySha256": "…", "filter": { "…": "…" } },
    "derivedAt": "…",
    "nodes": [ { "id": "…", "type": "claim", "text": "…", "tags": ["topic:transformer"], "…": "…" } ],
    "edges": [ { "id": "…", "from": "…", "to": "…", "type": "supports" } ],
    "branches": [ { "id": "…", "parentBranchId": "…", "forkPoint": "…" } ],
    "state": [ { "target": "…", "actor": "…",
                 "dimensions": { "confidence": { "level": "high" } } } ],
    "publications": [ { "…": "…" } ],
    "sources": [],
    "sha256": "…over the canonical JSON of the section without this field…"
  },

  "views": [
    { "name": "outline", "kind": "outline", "over": { "scene": ["base"] },
      "layout": { "groupBy": "contains", "order": "…" } }
  ]
}
```

Expressiveness check against the current base vocabulary (`default-session-pack`): concepts,
claims, questions, evidence, thoughts and syntheses as node types; `supports` / `contradicts` /
`refers_to` / `answers` for reasoning and evidence; `derived_from` / `organized_from` /
`authored_by` for provenance; `evolves_to` for revision; `forks_from` and the branch records for
lines of inquiry; per-actor state for cross-subject understanding; publications for deliberate
sharing. **Nothing in the v2 container needs a change to Core's data structures** — the manifest
carries whatever a scene's packs register, and a scene that needs finer vocabulary extends its pack
(ADR 0004), which the file then simply records.

## Read and write flows

**Write (v2):** export the graph exactly as v1 does (exclusive hold, whole history) → nest the v1
object under `archive.history` → derive the knowledge section by loading the records, applying the
packs' *definitions* (not their guards' behaviour), folding and projecting → canonicalize (below) →
checksum each section → write once, `0o600`, never over an existing file.

**Full read (Episteme):** check the envelope, check `archive.history` with the v1 rules, import into
a new graph; the knowledge section is ignored for correctness — it is a claim about the history,
verified on demand.

**Light read (third party):** read header → `ontology` → `knowledge`. No service, no SQLite, no
packs. A reader that also wants to trust what it read refolds: deserialize `history.records`, apply
`ontology.packs`, fold, and compare against `knowledge` (and its `sha256`). Refusal on mismatch is
the reader's choice; the file says `derivedFrom`, so the reader can always tell derived from
authoritative.

## Determinism and verifiability

The event log gives this almost for free, and the remaining requirements are explicit:

- **Order is total.** Records commit in order and export reads them `ORDER BY seq`; `foldEvents` is a
  pure reduce. Refolding the same records in the same order yields the same state — this is already
  pinned by the byte-stable round-trip test.
- **Canonical serialization is specified and implemented** (ADR 0023). Canonical JSON follows RFC 8785
  (JCS) where JSON has one answer: UTF-8 without BOM, no insignificant whitespace, object keys sorted
  by UTF-16 code units, strings escaped per RFC 8785's rules. Array order is part of the contract,
  because the history's `seq` order is what folding depends on and the history section must stay
  byte-compatible with v1's `JSON.stringify` digest rule. Projection ordering uses stable fields:
  nodes, branches and publications by `[createdAt, id]`, edges by `[type, from, to, createdAt, id]`,
  state by target then actor with dimensions sorted by name. Sorting by id alone was tried and
  rejected: edge, branch and publication ids are content-independent UUIDs, so id-first order makes
  the same history produce different bytes across runs — caught by cross-run testing, fixed in
  `knowledge.ts`.
- **The projection names its inputs.** `derivedFrom` pins the history checksum, the ontology checksum
  and the filter; a projection is verifiable exactly when its inputs match, and a file whose receipt
  names inputs it does not carry is refused as `projection_mismatch` by `readEpiFile`. A fork does not
  weaken this: branches are records, and folding is per branch with `forkedFrom` linking lines of
  inquiry.
- **Revocations apply in order**, like every event; nothing is ever removed from the file.

## Consistency between events and projection

The knowledge section is a cache with a receipt. Three rules keep it honest:

1. It is never required for import; the history alone restores the graph.
2. It carries `derivedFrom`, so staleness is detectable, never silent.
3. A writer may omit it (archive-only profile); a reader may refuse to trust it; nothing may write
   into it that contradicts a refold and still claim to be verified.

## External references

Sources keep their bodies out of the graph (ADR 0009), and a `.epi` file keeps that boundary:

- A source entry carries its digest, origin, title and, where it exists, a URI.
- Material itself travels only in an optional `attachments` section with explicit size caps;
  default is reference-only, so an export stays small and stays inside the owner's rights.
- Publications reference nodes by id; a shared export that includes a publication includes the
  published subgraph's nodes and edges in `knowledge`, with the rest of the graph still in
  `history` — which is why **scoped export** (below) is a v2 deliverable, not an afterthought.

## Scoped export is whitelist-first, and refuses rather than redacts

The privacy failure mode of an export-then-hide design is structural: the private material is already
in the bytes, and every section is another place it can leak — raw history, companion logs, source
metadata, identifiers. The scoped export therefore computes its inclusion set **before**
serialization, from Publication records and the visibility rules, and never writes what was not
included:

- The inclusion set is a whitelist: a node is in only if it is reachable from the publication root
  through the author's own edges, is the author's own non-draft work, and every dependency it needs
  to be intelligible is itself published. A private or draft dependency that cannot be shown to be
  safe is a **refusal** with a named reason, never a silent omission.
- A scoped export ships the **knowledge-only profile** — ontology + knowledge, no `archive` — because
  a cropped history is not a restorable archive and must not pretend to be one. Restorable archives
  and knowledge publications stay two different behaviours.
- Every section the file does carry is leak-scanned in tests: the private fixture's strings must be
  absent from `ontology`, `knowledge` (nodes, edges, state, publications, sources) and the header.
- State is per actor; a scoped export carries only the actors whose understanding is deliberately
  included, never a second actor's private state by adjacency.

## Size, permissions, versions

- Growth is additive: append-only history grows monotonically, so v2 adds section-level `profiles`
  and (later) a compressed or binary envelope behind the same `.epi` type, decided by `version`, as
  its size answer. JSON stays the reference form.
- Permissions stay as v1: owner-only (`0o600`), one owner, write-once. Encryption is out of scope
  for v2's first cut and would be a version bump with its own ADR.
- Backward compatibility: a v2 build reads v1 (v1 nests as a v2 file's `archive.history`, and a v1
  file is its own format string that v2 builds accept unchanged); a v1 build refuses v2 files as
  `unsupported_version` — the same refusal any build gives a newer format, so no file is ever
  silently misread. The migration tool is the same one that carries older graphs forward today.

## Application boundary

The manifest carries pack *definitions*, never pack *behaviour*, and never a name of any one
application. MindLink's Learn scene, a forum, or any future scene appears in a `.epi` file only as
registered vocabulary and scene records; what the vocabulary means is the pack's business (ADR 0004,
0013). Core learns nothing new from v2.

## Implement first vs defer

**First (v2 cut):** envelope + `history` nesting; `ontology` manifest; `knowledge` with canonical
ordering and `derivedFrom`; a small `@episteme/epi-reader` package for light reads; scoped export of
one publication's visible subgraph.

**Defer:** `views` beyond a minimal outline (apps can derive their own from `knowledge`);
`attachments`; compressed/binary envelopes; encryption; writer-side caching of `knowledge` in the
live graph.

## Open questions

1. Does `knowledge` include per-dimension **event pointers** (which events set each value), so a
   reader can show "why this level" without refolding? Cost: size; benefit: explainability. —
   Still open; the archive's raw history already carries the evidence for a full reader.
2. Canonical JSON (sorted keys, fixed separators) for section checksums — worth adopting a formal
   canonicalization (e.g. JCS) or pinning our own ordering rules? — **Resolved:** a pinned JCS
   subset, as ADR 0023 records; full RFC 8785 number handling was evaluated and the subset covers
   everything the format writes while keeping the history section byte-compatible with v1.
3. Should scoped export refuse rather than redact when a published node's neighbourhood reaches
   private material? — **Resolved: refuse.** Whitelist-first with named refusals; see the section
   above.
4. One `.epi` per actor or one per graph? State is per actor; a shared export carries whose state? —
   Still open for scoped export: the draft's working answer is "only the actors deliberately included
   in the whitelist", decided when G4 lands.
