# 0022 — `.epi`: the file type of a portable graph export

Status: **proposed** (2026-11-18). Builds on [ADR 0018](0018-sqlite-only.md) (one SQLite file per graph)
and the portable export it made possible.

## Context

The portable export writes a single JSON container whose identity is inside it: `format:
"episteme-graph-export"` and a `version`, both checked before anything is read, and a `sha256` over the
history it carries. The files the tests wrote were named `graph.episteme.json` — a double extension,
which no operating system can associate: a file manager binds a file type to the last extension, so a
`.episteme.json` file opens as JSON text in whatever editor owns `.json`.

A person's understanding deserves its own file type. A name is how an operating system, a file manager
and a person agree on what a file is and what should open it; it is also how a surface can warn that
this file holds private material and drafts, readable only by its owner.

## Decision

**A portable graph export is an `.epi` file. Identity stays in the file's contents; the name is a
convention, never a credential.**

1. **One authoritative name.** `GRAPH_EXPORT_EXTENSION = '.epi'` is defined beside
   `GRAPH_EXPORT_FORMAT` in `@episteme/storage-sqlite` — the module that owns the container — so the
   extension, the format string and the version cannot drift apart.
2. **Content is the only identity.** Import accepts any file name, reads `format` and `version`, and
   refuses a mismatch as `not_an_export`, whatever the file is called. An `.epi` file with wrong
   contents is refused like any other; a `.json` or extensionless file holding a real export is read.
3. **The v1 container stays JSON.** The existing `GraphExport` envelope — header, `sha256`,
   `records`, `companions` — is unchanged. JSON is human-readable, adds no dependency, and keeps the
   round trip byte-stable: history is append-only and nothing derived is stored, so there is no second
   copy of the truth to fall out of step. Evolution goes through `version` and `storedAs`, refused
   rather than misread.
4. **Ownership unchanged.** Written once, never over an existing file, mode `0o600`, exported under an
   exclusive hold, imported only into a new graph. The portable format keeps every decision ADR 0018
   made about a graph file.
5. **A light reader is enough for the envelope.** A third party can read an `.epi` file's header,
   counts and integrity without starting Episteme: it is JSON with a documented schema. Interpreting
   the records' vocabulary needs the domain packs; carrying the vocabulary inside the file is the work
   of a native knowledge format, drafted in
   [`docs/discussions/raw/2026-11-18-epi-native-format.md`](../discussions/raw/2026-11-18-epi-native-format.md).
6. **Association belongs to applications.** The kernel ships the reader, not the registration: binding
   `.epi` to an application, an icon and a warning is each application surface's decision.

## Consequences

Tests name their archives `*.epi`. Applications may present `.epi` as "a file of understanding". A
future native knowledge format keeps the `.epi` type and moves forward by version, so today's exports
keep opening in every later build.
