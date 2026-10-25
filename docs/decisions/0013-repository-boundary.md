# 0013 — Two repositories, one owner per capability

Status: **accepted** (2026-10-17; proposed 2026-10-15). Keeps the repository split of PR #5 and ends the duplication it left
behind. Depends on [ADR 0012](https://github.com/SAIR-club/Episteme/issues/17) for anything that needs an
authenticated actor.

## Context

PR #5 moved `apps/learn`, `packages/domain-learn` and the examples into a separate repository,
SAIR-club/learner. That split stays: Episteme is the platform, and Learner is one application built on it.

An audit of both repositories on 2026-10-12 found that the split left two independent implementations of the
same product, and lost the v0.1.0 surface:

| capability                       | Episteme (`main` @ be590d6)                                                                  | Learner (`main` @ 175c59c)                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| session                          | `packages/application/src/session.ts`, `LearnSession`, 2461 lines: recall, record, propose, decide, distill, recovery | `apps/learn/src/session.ts`, `LearnSession`, 844 lines: ask, record, claim |
| vocabulary                       | `defaultSessionPack` in the application, a union of two level sets (`evidence`: `weak, derived, anecdotal, proven`; `transfer`: `low … far`) | `learnDomainPack` in `packages/domain-learn`                             |
| recordable levels shown to people | `RECORDABLE_DIMENSIONS` in the application, still offering `weak` and `derived`              | derived from the pack (learner#2)                                        |
| hybrid retrieval and context     | `packages/core/src/retrieval/`                                                               | `packages/domain-learn/src/retriever.ts`, `context.ts` (copies)          |
| distillation policy              | `defaultDistillationPolicy` in the application                                               | `packages/domain-learn/src/distillation.ts`                              |
| Chinese signal labels            | `SIGNAL_LABELS_ZH` in the application                                                        | `SIGNAL_LABELS_ZH` in `apps/learn`                                       |
| who writes the graph             | the service, one owner (ADR 0010)                                                            | `apps/learn/src/server.ts` opens the graph file itself                   |
| Workspace                        | none; `pnpm serve --workspace` has nothing to serve                                          | a pre-Phase-3 page on `/api/ask`, `/api/record`, `/api/claim`, `/api/state`, with no review queue |

The split also left two structural problems:

- **The dependency is an unpinned sibling checkout.** Learner resolves `@episteme/*` through `pnpm`
  overrides to `../Episteme/packages/*`, and its CI checks out Episteme `main` at whatever commit is
  current. A Learner build is reproducible only by accident, and an Episteme change can break Learner without
  either CI noticing.
- **ADR 0010 is no longer true in practice.** A surface that opens the graph file itself is a second
  authority, and it bypasses the one human-decision path.

The v0.1.0 Workspace (`apps/learn/public/index.html` at 07e1c76, 1819 lines, on `/api/v1`) exists only in
Episteme's history. What Learner carries is an older version of that page, not the one released.

## Decision

**Two repositories with a single, explicit contract between them. Every capability has exactly one owner,
and neither repository keeps a copy of the other's code.** Episteme provides scene-free platform
capabilities. Learner provides everything that is about learning, and builds on Episteme's published
surface only.

### Ownership

**Episteme** (SAIR-club/Episteme):

| package / app           | owns                                                                                                                                                       | must not contain                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `packages/core`         | ontology, registries, guards, the event log, projection, the retrieval engine and its explanation, embedding ports; and (ADR 0014) publication and visibility | any scene vocabulary: no `concept`, `claim`, `confidence` … |
| `packages/sdk`          | composing Core with packs and storage                                                                                                                      | business flow                                               |
| `packages/storage-*`    | adapters behind the storage port                                                                                                                           | rules of their own                                          |
| `packages/agent`        | the agent interface and the scripted test double                                                                                                           | a model provider                                            |
| `packages/distillation` | segmentation, the engine, quote verification and host reading                                                                                              | a scene's policy                                            |
| `packages/application`  | the use cases over one graph: recall, record, add and link, propose, decide, distill, and later publish and adopt. **Scene-agnostic:** the pack, distillation policy and recordable dimensions come from a scene profile | a built-in pack or policy; UI text                          |
| `packages/mcp`          | the MCP surface over the application                                                                                                                       | use cases of its own                                        |
| `apps/service`          | the only code that opens a graph. Usable as a library (`startService({ profile, workspace })`) and as a CLI for development. Serves REST `/api/v1`, MCP `/mcp`, identity (ADR 0012) and a built Workspace | use cases of its own; a scene profile                       |
| `tests/fixtures`        | a minimal **test scene pack**, so Episteme is tested with no dependency on Learner                                                                         | anything product code imports                               |

**Learner** (SAIR-club/learner):

| package / app            | owns                                                                                                                                       | must not contain                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `packages/domain-learn`  | the Learn pack: vocabulary, dimensions (including the legacy levels below), the Learn distillation policy, retrieval *weights* if Learn needs non-default ones, and the **learn profile** that the service is started with | a retriever, a context builder, a session              |
| `apps/learn`             | the **launcher**, which starts Episteme's service with the learn profile and the Workspace in one process. And the **Workspace**, a static client of `/api/v1` that holds all presentation, including Chinese labels for levels and signals | any access to the graph, storage or a session of its own |
| `examples/`              | runnable learning demos over Episteme's application                                                                                       | code other packages import                             |

The rule for a new piece of code extends ADR 0001 by one step: graph primitive → Core; use case →
application; transport → service or MCP. **Anything about learning → Learner**: vocabulary and policy go in
`domain-learn`, presentation in the Workspace. A capability that a second scene (research, discussion) would
also need belongs in Episteme, even if Learner asks for it first.

Running Learner keeps the ADR 0010 guarantee: the launcher process runs Episteme's service code, which is
still the only code that opens the graph.

### The contract between the repositories

Learner may depend on exactly this, and nothing else:

- the exported API of `@episteme/core`, `@episteme/sdk`, `@episteme/application` and `@episteme/service`;
- REST `/api/v1` and its documented payloads, including the new `GET /api/v1/vocabulary`;
- the MCP tools.

**Pinning.** Learner records the Episteme commit it builds against in one file, `episteme.ref`. CI and the
local setup script check that commit out as the sibling, so the existing overrides keep working.
Moving to a newer Episteme is a normal Learner PR that changes that one line, and its CI is the
compatibility check. Once Episteme has release tooling, `@episteme/*` are published at each release and
Learner switches to version ranges. That step is a follow-up, not part of this ADR.

**Cross-repository changes** land Episteme first: an Episteme PR merges green, then a Learner PR bumps
`episteme.ref` and uses it. A Learner PR never depends on an unmerged Episteme branch.

**Breaking the contract** (removing an export, changing a `/api/v1` payload) needs its own Episteme PR,
labelled breaking, merged only after the Learner PR that adapts to it is ready.

### Resolving each duplicate

| duplicate                                   | keeper                                                                                         | the other copy                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| two `LearnSession`s                         | Episteme's application, renamed to a scene-agnostic name; `LearnSession` stays as a deprecated alias for one release | Learner's is deleted, with its legacy server and CLI   |
| `defaultSessionPack` / `learnDomainPack`    | Learner's `domain-learn`                                                                       | removed from the application; Episteme's tests use the test scene pack |
| hybrid retriever and context                | Episteme `packages/core/src/retrieval`                                                         | Learner's copies are deleted after a parity test       |
| distillation policy                         | Learner's `domain-learn`                                                                       | `defaultDistillationPolicy` is removed from the application |
| `RECORDABLE_DIMENSIONS`, `SIGNAL_LABELS_ZH` | levels from the registry, served by `GET /api/v1/vocabulary`; Chinese labels in Learner's Workspace | both server-side copies are removed                     |
| topic seeds                                 | one seed format, owned by the service's `--topic`; Learner's seeds are data files in that format | Learner's `seed.ts` / `topic-file.ts` code is removed   |

### Data compatibility: legacy levels

Graphs written through the v0.1.0 service may hold `evidence: weak | derived` and `transfer: none | near | far`,
because `defaultSessionPack` registered them. History is append-only, so these events are never rewritten.
`domain-learn` therefore registers the legacy levels too, so old events stay valid and reduce as before, but
marks them **legacy**: they are read and displayed, never offered for new input. Mapping a legacy level to a
current one (`weak` → `anecdotal`?) is a question of meaning, not a migration, and is left to a later ADR if it
is ever needed. A v0.1.0 graph is opened by Learner's launcher, not by Episteme's development CLI.

### Scene extensions

Added while implementing step M3 (#37). A scene needs tools and routes of its own: MindLink, for example,
offers `workflow_next` to agents and project settings to its Workspace. It cannot open a second process (ADR
0010), so the service mounts them from the profile it is started with.

- **`SceneProfile.scene`** is a `SessionScene`: the packs the graph is composed with, the distillation policy
  `distill` uses when none is named, and the dimensions a person may record by hand. The application has no
  scene of its own; until step M6 a session opened without one uses the deprecated built-in Learn scene.
- **`SceneProfile.mcpTools`** are registered beside `recall`, `propose`, `distill` and `reflect`. A name that
  repeats one of them, or another scene tool, stops the service at start.
- **`SceneProfile.routes`** are served under `/api/v1/scene/<profile name><path>`, behind the same boundary and
  with the same error format as every other route. A path without a leading `/`, or a method and path declared
  twice, stops the service at start.
- **Both receive a `SceneView`, never the session.** The view reads, proposes and distills; it has no `decide`,
  `record`, `addNode`, `link`, `graph` or `log`, at run time as well as in its type. A scene extension is
  reachable by an agent, so handing it the session would give an agent a way around the one human-decision
  path. Anything a scene wants to change is proposed and waits for the person.
- **The view also reads the caller's own threads and browses publications** (`threads`, `threadView`,
  `browsePublications`), added for MindLink (SAIR-club/MindLink#11, gaps G1 and G2): a scene's tools need the
  person's own conversations and the work others have published. Both are the session's reads unchanged: a
  thread that is not the caller's cannot be read, and browsing returns only live publications (ADR 0014).
  Browsing carries no adoption or conflict counts, because those would be computed from other people's state
  events, which only their own actor may read (ADR 0014, decision 2).
- A refusal a handler throws is answered as a refusal: `isError` with its code over MCP, 422 over REST.

What a scene extension may not do is the same as what an agent may not do. When a scene needs a capability
the view does not offer, the capability is added to Episteme's application first, under the same rules.

## Migration

Each step is one PR, keeps both repositories' CI green, and can be reverted on its own. No step changes the
persistence format. API changes are additive unless marked **breaking**.

| #   | PR (repository)                                                     | change                                                                                                                                                      | tests that gate it                                                                                                            | rollback                                                    |
| --- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| M0  | (both) review and merge learner#2, learner#3, Episteme#29, #30      | finish the cleanup; freeze feature work on Learner's legacy surface                                                                                        | their own CI                                                                                                                  | revert the merge                                            |
| M1  | `ci: pin the Episteme commit` (learner)                             | `episteme.ref`, used by CI and the setup script                                                                                                             | Learner CI against the pinned commit                                                                                          | revert                                                      |
| M2  | `fix(application): offer only registered levels` (Episteme)         | `RECORDABLE_DIMENSIONS` derived from the registry; add `GET /api/v1/vocabulary` (dimensions, levels, legacy flags)                                          | every offered level is accepted through REST on a seeded service; vocabulary contract test                                  | revert; no data touched                                     |
| M3  | `refactor(application): take the scene from a profile` (Episteme)   | the application gets its pack, policy and recordable dimensions from the `SceneProfile`; the built-in pack moves to `tests/fixtures` as the test scene pack, and a deprecated `learnProfile` export keeps the old behaviour for one release; the session gets a scene-agnostic name with a `LearnSession` alias | a golden v0.1.0 graph file (legacy levels, suggestions, sources) opens, reduces and recalls exactly as before; the full suite | revert; the file format is unchanged                        |
| M4  | `refactor(domain-learn): build on Episteme's retrieval` (learner)   | bump `episteme.ref`; delete the copied retriever and context, after a parity test on the evaluation fixtures; add the legacy levels; export the learn profile | ported retrieval tests pass against `@episteme/core`; the parity test compares rankings before the copies are dropped        | revert to the previous ref                                  |
| M5  | `feat(learn): launcher and Workspace on /api/v1` (learner)          | `apps/learn` becomes the launcher (`startService` with the learn profile) plus a Workspace rewritten from the inventory below; the legacy server, session and CLI are deleted | an end-to-end test drives the launcher over HTTP: recall → distill → review (accept, modify, dismiss) → recall uses what was accepted; no server text reaches `innerHTML` | revert; the previous Learner release still runs             |
| M6  | `refactor(application)!: remove the built-in learn profile` (Episteme) | drop the deprecated `learnProfile`; the development CLI starts with the test scene pack; README, AGENTS.md and current-plan point to Learner for the learning product | the full suite on the test scene pack; Learner CI on the bumped ref                                                           | revert                                                      |

**Breaking changes**, each called out in its PR and the changelog:

- **M5:** Learner's legacy endpoints `/api/ask`, `/api/record`, `/api/claim` and `/api/state` are gone. The
  only known consumer is the old Learner page.
- **M6:** `pnpm serve` in Episteme no longer carries the Learn vocabulary. People who use it for learning
  start Learner's launcher instead, on the same graph file. `LearnSession` is removed one release after M3.
- **M1:** a Learner build no longer follows Episteme `main` automatically. This is deliberate.

### Workspace: what comes back, and how

The v0.1.0 page is used as a specification, not as code to copy back. It is one 1819-line file with inline
script and hard-coded levels, and it has no way to show what a suggestion is based on. It is rebuilt in
Learner's `apps/learn`.

| feature in v0.1.0 (function in 07e1c76)                                                     | verdict     | why / how                                                                                             |
| ------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------- |
| review queue: accept, modify, dismiss (`renderReview`, `renderDecision`, `renderEditor`, `decide`) | **restore** | the one human-decision path; behaviour and copy kept                                                   |
| "accept this first" for dependent suggestions (`waitingFor`)                                | **restore** | prevents refusals the learner cannot understand                                                       |
| the quoted origin of a suggestion (`quoteOf`)                                               | **restore**, extended | also show `basis` and the speaker (#26), so an agent's inference is not mistaken for the learner's words |
| queue polling while visible and not editing                                                 | **restore** | already correct: the page is idle when hidden                                                         |
| recall with ranked reasons and signals (`runAsk`, `renderResult`, `renderRanked`)           | **restore** | the explanation of why something was recalled is the product                                          |
| before/after comparison after a record (`keepBefore`)                                       | **restore** | it is gate C made visible                                                                             |
| record understanding, quick record (`renderRecord`, `renderQuickRecord`, `record`)          | **rewrite** | levels and labels come from `/api/v1/vocabulary`, never from the page                                 |
| node history                                                                                | **new**     | the API has it (`GET /api/v1/nodes/:id/history`) but the page never showed it; it is gate A made visible, and ADR 0014 needs it for lineage |
| import learning material (`distilMaterial`)                                                 | **restore** |                                                                                                       |
| add a claim or question (`addNode`)                                                         | **restore** |                                                                                                       |
| "what you have understood", open lines of inquiry (`renderProgress`, `renderOpenEnds`)      | **restore** |                                                                                                       |
| page structure: one file, inline script, `innerHTML = ''` resets                            | **rewrite** | a few plain ES modules, no build step and no framework; DOM built with `textContent` only             |
| single-learner assumptions (`state.nodes` is "everything")                                  | **rewrite** | every view reads what the API returns for the signed-in actor (ADR 0012, ADR 0014)                     |
| the "try:" prompts from seeded questions (`renderHints`)                                    | **retire**  | only useful with the demo seed                                                                        |
| the legend (`<details class="legend">`)                                                     | **retire**  | moves to documentation                                                                                |
| the counts banner (`renderStats`)                                                           | **retire**  | not needed for the MVP                                                                                |
| the Transformers topic as the default graph                                                 | **retire**  | the launcher starts blank unless a topic is given                                                     |

## Consequences

- One session, one pack, one retriever: a fix like learner#2 is made once, in the repository that owns it.
- Work on Learner's legacy surface stops until M5 lands. Two implementations cannot both move forward.
- The application loses its built-in vocabulary. Callers that constructed `LearnSession` without a profile
  keep working through the alias until M6.
- Episteme becomes testable and runnable without any learning code, which keeps it open to research and
  discussion scenes.
- Every cross-repository feature costs two PRs and a ref bump. This is the price of the split, and pinning
  is what keeps it safe.

## Alternatives considered

- **Merge Learner back into Episteme.** This removes the cross-repository cost, but it undoes a deliberate
  split and puts learning code next to the platform. Rejected by the maintainer.
- **Keep Learner's own session and share code with Episteme's.** This keeps two use-case layers and two
  human-decision paths, which ADR 0008 and 0010 exist to prevent.
- **Keep following Episteme `main` without a pin.** This is cheaper per change, but any Episteme merge can
  break Learner silently, and no Learner build can be reproduced.
- **Copy the v0.1.0 page back as it was.** This is fast, but it would bring back its hard-coded levels and
  missing basis, and it cannot express more than one actor.
