# 0015 — Conversation threads and scene records

Status: **accepted** (2026-10-18). Builds on [ADR 0005](0005-fork-lineage.md) (forks),
[ADR 0010](0010-episteme-service.md) (_Conversation structure is Episteme data_),
[ADR 0011](0011-host-assisted-distillation.md) (the host reads, Episteme verifies),
[ADR 0013](0013-repository-boundary.md) (who owns what) and [ADR 0014](0014-publication-and-reuse.md)
(publications). Implemented by #41.

## Context

The product now needs conversations of its own (development plan, D4 and D10):

- a learner's dialogue with their agent is kept, raw, as an archive;
- each turn can carry a summary that says the same thing in fewer words, and the summaries are what a person
  later reads, recalls from, and shares;
- a conversation can split into several lines, so a learner can follow two questions without one muddying the
  other;
- MindLink has records of its own that are not understanding: a learning project's goal, its chosen workflow,
  which step a learner is on, how often they took a suggested question.

Today none of this has a home. The README says Episteme "is not a conversation store: it keeps only the excerpts
it was sent". Raw AI transcripts are drafts and stay out of the graph (AGENTS.md, _Draft → Thought →
Reference_). And MindLink cannot keep its own files, because only the service opens storage (ADR 0010, 0013).

ADR 0010 already decided where conversation structure belongs: _turns, their parent-child relationships,
branches and source references belong to Episteme's data model, held authoritatively by the service, beside
the understanding graph and not in it_. Discussion, the second scene, needs threads too, so by ADR 0013's rule
they are Episteme's, not MindLink's. This ADR says what those records are.

## Decision

**A conversation is a thread of turns, kept beside the graph and never in it. Its raw text is an archive only
its owner reads. Its summaries are what can be recalled from and published. A scene keeps its own records in
a namespaced store that never holds understanding.**

### 1. Threads and turns are records, not nodes

```ts
interface Thread {
  readonly id: ThreadId
  readonly owner: ActorId // the person whose conversation it is
  readonly title: string
  readonly scope?: string // the application-defined scope it belongs to (decision 6)
  readonly parent?: { readonly thread: ThreadId; readonly turn: TurnId } // set on a fork
  readonly hostSession?: string // the host's own id for the conversation, provenance only
  readonly createdAt: EpochMillis
}

interface Turn {
  readonly id: TurnId
  readonly thread: ThreadId
  readonly seq: number // 1, 2, 3 … within its thread
  readonly speaker: 'learner' | 'agent'
  readonly text: string // the raw words, canonical (canonicalText), the archive
  readonly by: ActorId // who sent it: the agent that relayed the turn, or the person
  readonly at: EpochMillis
}

interface TurnSummary {
  readonly turn: TurnId
  readonly text: string
  readonly quotes: readonly string[] // words of the turn it rests on, verbatim (decision 2)
  readonly by: ActorId // the agent whose model wrote it
  readonly at: EpochMillis
}
```

- **Not nodes**, for the reason a publication is not one (ADR 0014): a node appears in every query, every
  retrieval and every projection unless each learns to skip it. A turn is material, not understanding.
- **Append-only.** A turn is never edited. A summary can be replaced by a newer one for the same turn; the
  latest is current and the earlier ones stay. A thread is never deleted; physical deletion is reserved for
  privacy and legal requests (AGENTS.md), and is out of scope here.
- **Ids** come from the caller or an id factory, times from the clock, as for everything else.

### 2. Summaries: the host writes, Episteme checks the anchor

The host's model writes each summary and submits it (`thread_summarize`), as it already reads material for
distillation (ADR 0011). A summary may compress the words; it must not change what was asked or said.

- A summary of a **learner** turn must carry at least one quote, and every quote is checked verbatim against
  the turn's canonical text with the same normalization and search as distillation's quotes. A summary whose
  quote is not found is refused (`quote_not_found`) and nothing is kept. The anchor does not prove the summary is
  faithful; it ties it to words the learner actually wrote, so a reader can check it.
- A summary of an **agent** turn needs no quote: what the agent said is not the learner's, and it is never
  recorded as theirs.
- An unsummarized turn is shown raw to its owner and as "not summarized" to anyone else who could otherwise see
  the thread.

### 3. Many lines: a fork is a thread with a parent

`thread_fork(thread, turn)` opens a new thread whose `parent` is that turn, in the sense of ADR 0005: reading the
fork shows the parent's turns up to and including `turn`, then the fork's own. Nothing later on the parent leaks
into the fork, and the parent is untouched. A thread may be forked from any turn, any number of times, which is
what "multi-line" conversations are.

A conversation imported from a host keeps its `hostSession` and is stored as the host sent it: if the host did
not send its branches, Episteme does not invent them (ADR 0010).

### 4. Raw is never shared; summaries can be

- A thread and its turns are visible to their owner only, and to the owner's agents through the owner's
  session (ADR 0012, 0014).
- ADR 0014's `Publication` gains the optional `threads` member: thread ids whose **summaries** become visible
  to everyone while the publication is live. Raw turn text is never part of a publication, a browse result or
  anything another person can read; the data model makes this structural, because what a publication exposes
  is read from summaries only.
- Publishing a thread requires that every listed thread is the author's own. Unsummarized turns are left out of
  what is published, and the preview lists them, so the author can summarize them first or publish without them.
- The preview of a publication with threads carries a reminder to check the summaries for personal information.
  Episteme does not detect it.

### 5. From a thread to understanding

`distill` takes an optional `{ thread, turns? }` instead of free text. Episteme builds the material from those
turns as a dialogue (`学习者: …`, `助手: …`), keeps it as a source that names the thread and turns, and every
candidate's origin names the turn its quote is in. Nothing enters the graph except through the one decision
path, exactly as for any other distillation (ADR 0009, 0011).

### 6. Scope: which project a node belongs to

A node may carry a tag in the `scope` namespace, `scope:<application-defined scope id>`, registered by the application
itself so that every scene has it. `addNode`, `record` and the decision path accept an optional scope and tag
what they create. Recall may prefer a scope (#44); a scope is a preference, not a wall, because a person's
subjects are linked.

A scope also travels with a suggestion: `propose` and `distill` take an optional `scope`, kept on every draft they
make, and the node a draft becomes when it is accepted carries `scope:<scope>`, whether the person accepted it, put
it in their own words first, or a delegation (ADR 0016) accepted it for them. A state change or a link is not a
node and gets no tag. `POST /nodes` takes a scope too, for a node a person adds by hand. A scope id is a non-blank
string of at most 100 characters without control characters, and not `*`; anything else is refused with
`invalid_scope`.

### 7. Scene records: a scene's own data, never understanding

```ts
interface SceneRecord {
  readonly namespace: string // the scene's profile name, such as "mindlink"
  readonly owner: ActorId // whose record it is
  readonly key: string // such as "project/prj_1"
  readonly version: number // 1, 2, 3 … per (namespace, owner, key)
  readonly value: unknown // JSON, at most 64 KiB
  readonly by: ActorId
  readonly at: EpochMillis
}
```

- **Append-only versions.** A write appends version n + 1; a read returns the latest. A record is removed by
  writing a `null` value, which keeps its history.
- **Scoped twice.** A scene reads and writes only its own namespace, and a caller only their own records.
  Scene extensions (ADR 0013, _Scene extensions_) get this through `SceneView`, bound to the profile's name and
  the caller.
- **The boundary.** Scene records hold what a scene needs to work (a project's goal, a workflow choice, a step
  counter, a metric), **never** what a person understands. Anything that says "this person understands X to
  this degree" is a state event and goes through the decision path. A review of a scene that keeps such values in
  its records is a bug in the scene. Episteme cannot tell a goal from a level, so this is a rule for scenes, stated
  here and in the scene extension contract, not a check.

### 8. Storage and compatibility

Two new files beside the graph, owned with it like the drafts and sources: `<graph>.threads.jsonl` (threads,
turns and summaries) and `<graph>.scene.jsonl` (scene records), each with its own `schemaVersion: 1` and the
same write discipline as the drafts (whole-file write through a temporary file, memory follows the disk). The
graph file's format does not change, so an older build still opens the graph; it simply does not see threads or
scene records.

## API (#41)

Every route and tool acts for the caller's person (ADR 0012). Threads and scene records are not decisions, so
an agent credential may use them, like `propose` (ADR 0012, decision 3).

| REST under `/api/v1`                    | does                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `GET /threads?scope=`                   | the caller's threads, newest first                                       |
| `POST /threads`                         | `{ title, scope?, hostSession? }` → a new thread                         |
| `GET /threads/:id`                      | the thread, its turns (raw for the owner) and their current summaries    |
| `POST /threads/:id/turns`               | `{ speaker, text }` → the appended turn                                  |
| `POST /threads/:id/turns/:turn/summary` | `{ text, quotes }` → the summary, or a refusal such as `quote_not_found` |
| `POST /threads/:id/fork`                | `{ turn, title? }` → the new thread                                      |
| `GET /scene-records/:namespace?prefix=` | the caller's latest records in a namespace                               |
| `GET /scene-records/:namespace/:key`    | the latest version, or 404                                               |
| `PUT /scene-records/:namespace/:key`    | `{ value }` → the new version                                            |

| MCP tool           | arguments                         | does                                                   |
| ------------------ | --------------------------------- | ------------------------------------------------------ |
| `thread_open`      | `{ title, scope?, hostSession? }` | opens a thread for the conversation the host is having |
| `thread_append`    | `{ thread, speaker, text }`       | records one turn, raw                                  |
| `thread_summarize` | `{ thread, turn, text, quotes }`  | the host's summary of a turn, checked as in decision 2 |
| `thread_fork`      | `{ thread, turn, title? }`        | a new line from that turn                              |

`distill` gains the optional `thread` and `turns` arguments (decision 5); `propose` and `distill` gain `scope`
(decision 6). The publication routes of ADR 0014 (#42) accept `threads` (decision 4).

## Testing (#41)

| test                  | proves                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| thread lifecycle      | open, append, summarize, fork; turns numbered in order; a fork reads its parent up to the fork turn    |
| summary anchor        | a learner turn's summary without a found quote is refused and nothing is kept; an agent turn's is not  |
| summary versions      | a newer summary replaces the current one; the earlier one stays readable                               |
| restart               | threads, turns, summaries and scene records survive; a graph without the new files opens unchanged     |
| isolation             | another person sees none of a thread, raw or summarized, until a live publication names it             |
| raw never published   | a publication with threads exposes summaries only, through every read; unsummarized turns are left out |
| distill from a thread | candidates' origins name their turns; nothing reaches the graph without a decision                     |
| scene record scoping  | versions append; a scene reads only its namespace, a caller only their records; `null` removes         |
| agent credential      | an agent can open, append and summarize, and still cannot decide                                       |

## Consequences

- The README's "not a conversation store" becomes "keeps conversations as an archive beside the graph, never in
  it". The invariant it protected, that a transcript is not understanding, is unchanged.
- The service holds raw conversations, which are personal data. They are plain text on disk like everything
  else (roadmap, Phase 4), and nobody but their owner can read them through the service.
- Recall can later use summaries as context without reading raw text, which is what the layered context of #44
  builds on.
- Discussion can reuse threads for many people's turns in one conversation; that needs a thread with several
  owners, which is a later ADR, not this one.

## Alternatives considered

- **Turns as graph nodes.** One store for everything, but every read path would have to skip them, and raw
  dialogue would sit among understanding in the one place the invariants keep it out of.
- **Raw text in the SourceStore**, as the issue suggested. A source is material read once for distillation:
  immutable, with a digest and verified spans into fixed text. A transcript that keeps growing would change its
  digest and the meaning of its spans with every turn. Instead, distilling a stretch of a thread creates a source
  that names the thread and turns (decision 5).
- **Summaries without anchors.** Simpler for hosts, but then a summary of a learner's question could say anything
  and still be shared as theirs.
- **Scene records as nodes with a scene tier.** It would put workflow state in the graph that the invariants keep
  for understanding, and make "this is not understanding" a convention every read path must honour.
- **MindLink keeps its own files.** It would open storage beside the service, the second authority ADR 0010 and
  ADR 0013 exist to prevent.
