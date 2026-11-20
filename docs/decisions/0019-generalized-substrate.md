# 0019 — Generalized substrate: canonical records, registries, derived indexes

Status: **proposed** (2026-11-17). Discussed in #72. Builds on [ADR 0004](0004-domain-extension-boundary.md),
[ADR 0013](0013-repository-boundary.md) and [ADR 0018](0018-sqlite-only.md).

## Context

One graph must serve several scenes without converting its contents. Learn-like, Forum-like and Research-like
views differ by scope, actor, topic, state and projection rule. The current physical container, one SQLite file
per graph, is ready for that. The remaining pressure is conceptual: if a scene's vocabulary, view rule or
ranking choice leaks into Core, the second scene can only be built by changing Core.

ADR 0004 already makes domain packs the only way to add vocabulary. Its final list also names projections and
query operators, but `Registries` exposed only node types, edge types, state dimensions, tag namespaces and
guards. ADR 0013 finishes with milestone M6, removing the built-in Learn profile, so the application can prove
that it holds no scene of its own.

## Decision

1. **One canonical record stream.** The `records` table in a graph's SQLite file is the source of truth.
   Streams are registered vocabulary: `understanding` holds `StateEvent`s; `review`, `conversation` and
   `system` name the other record families in the same file. Only a stream registered with
   `reducesUnderstanding: true` may change current understanding. The registry establishes that contract in
   Phase 0; Phase 1 maps persisted records to streams and moves graph and companion writes into one durable
   transaction. Until then, `StateEvent` remains the sole input to `foldEvents`, and the session's existing
   recovery of half-done decisions remains in force.

2. **Everything scene-specific is registered.** A domain pack is still the only way to add vocabulary or
   behaviour to Core. The registries now cover node types, edge types, state dimensions, tag namespaces,
   guards, streams, named projection rules and named retrieval weights. Registration is idempotent through
   `registerIfAbsent`, so two packs can share a term without either overwriting the other.

3. **Indexes and views are derived.** Adjacency, embedding caches, full-text indexes, latest summaries and
   live publication sets can be deleted and rebuilt from the canonical records. Each derived index declares
   its format version, the record stream it comes from, the actor / namespace / tier filters it applies, and
   one rebuild entry point. A reader never treats a derived index as evidence of what the person understands.

4. **The application holds no scene.** M6 removes `learn-scene.ts`, `defaultProfile` and `learnProfile`.
   A caller supplies a `SceneProfile`; the development CLI loads one from `--scene <path>`. Adding a scene
   changes pack data and a launcher, while Core's records table, `foldEvents`, `validateMutation`, and the MCP
   and REST operation sets stay unchanged.

5. **Retrieval stays behind the existing seam.** Named weight sets make a scene's ranking choices explicit,
   but `Retriever` and `RetrievalResult` do not change. Hybrid retrieval in #72 Phase 3 is the first derived
   index to use these registrations.

## Alternatives

**Store each stream in its own file.** Clearer physical separation, but it recreates the multi-file ownership
and recovery problem ADR 0018 removed. A stream column or record kind gives the same logical separation inside
one transaction.

**Let each scene own a projection function in code.** Smaller registry, but the rule disappears from
inspection and cannot be shared or versioned with a pack. A named filter keeps the same shape Core already
uses for `project`.

**Keep a built-in default scene in the application.** Convenient for tests and the CLI, but Core or the
application would keep learning one product's vocabulary, which is precisely the boundary ADR 0013 draws.

## Consequences

- A scene can add a term, a view rule and a weight set without a Core change. This is the acceptance test for
  the split: a second scene must not alter `records`, `foldEvents`, `validateMutation` or the operation sets.
- Callers that opened a session without a scene now fail at compile time and must pass one. This is the M6
  break; no compatibility alias is kept.
- Storage format version 2 stays as it is in this decision. A stream column, if added later, is a format
  change decided when it is needed.
- Registry entries are data, not behaviour. A pack cannot weaken a guard or make an unregistered type legal.
