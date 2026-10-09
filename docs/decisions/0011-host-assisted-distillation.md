# 0011 — Host-assisted distillation: the host reads, Episteme verifies

Status: **proposed** (2026-10-08). Amends [ADR 0009](0009-distillation.md).

## Context

The first step of the learning loop is _an agent submits sourced candidate understanding_. Today nothing on
the agent surface can do that:

- `propose` ([ADR 0008](0008-agent-plugin-surface.md)) takes a claim, a link or a state change, one at a time.
  It carries no material and no quote, and it cannot propose a concept, a question or a piece of evidence.
- `distill` ([ADR 0009](0009-distillation.md)) takes material and hands it to **Episteme's own** reader,
  the rule-based distiller. The host's model, which has just followed the whole conversation, contributes
  nothing to what is found.

ADR 0009 rejected _letting the host's agent extract and `propose` the results_ as a **replacement** for
distillation inside Episteme. Its reasons were that the result would depend on each host, and that the
extraction policy would belong to no Domain Pack. This ADR keeps both reasons, and adds host extraction
**alongside** Episteme's reader, through the same engine and the same policy.

What already exists and is reused:

- **Segmentation and episodes.** `segment` splits material into episodes. Each episode records its span in
  the source, and in a dialogue each turn records its speaker.
- **The engine.** It asks a `CognitiveAgent` for structure, connections and state changes, episode by
  episode. It checks every candidate against the domain's `DistillationPolicy`, its limits and its
  references, and keeps refused candidates with their reason.
- **Candidates of earlier episodes.** The engine passes every kept node candidate to the reader in
  `workspace.candidates`, so a later suggestion can refer to it as `cand:<engine ref>`.
- **Quotes.** `Suggestion.quote` exists. The engine records the span of the quote, an excerpt and the episode
  as the candidate's origin.
- **The session.** `LearnSession.distill(material, { agent, requestedBy })` accepts any `CognitiveAgent` and
  stores the material in `<graph>.sources.jsonl`. It applies `propose`'s checks and queues what survives as
  pending suggestions. A suggestion that names another as `cand:` can be accepted only after it
  (`depends_on_pending`), and never once it is dismissed (`unresolved_candidate`).

Four properties of the current code matter here:

1. **A quote that is not found does not fail.** The origin silently falls back to the whole episode. That is
   harmless for the rule-based reader, which only quotes the episode it reads. It would let a host's
   paraphrase pass as a verified quote.
2. **A quote is searched only in the episode being read**, and its first occurrence wins.
3. **`cand:` names are resolved inside one episode only.** The engine rewrites a reader's local name to the
   engine reference (`e<n>.<name>`) only for nodes of the current episode. A reference to an earlier episode
   must already use the engine reference, which a host cannot know.
4. **Duplicates are judged by label.** A node with the same type and normalised label as one the learner has
   is refused as `already_known`, and the refusal is returned, not stored.

## Decision

**A host may submit its own reading of a stretch of material as candidates. Episteme keeps the material,
verifies every candidate's quote against it, runs the candidates through the same engine, policy and checks
as its own reader, and queues the survivors for review. A verified quote proves only that the words are in the
material the host sent. Only the person's decision makes anything their understanding.**

### 1. One tool, two readers

The MCP `distill` tool gains an optional `candidates` field.

- Without it, nothing changes: Episteme's rule-based reader reads the material (ADR 0009).
- With it, **the host is the reader**. Episteme does not also run its own reader on the same call, which would
  produce two overlapping sets of candidates for the person to sort out.

The material path, the source store, the result shape, the review queue and the refusals are shared. A host
skill has one tool to learn, and the agent surface keeps exactly `recall`, `propose`, `reflect` and `distill`
(`tests/cross-agent-loop.test.ts` asserts this list).

REST does not gain the field. A Workspace has no model, and `/api/v1/distill` stays what it is. Both entry
points call the same application command, so there is one implementation (ADR 0010, decision 4).

The host reader is one new class in `@episteme/distillation`, beside `RuleBasedDistiller`: an implementation of
`CognitiveAgent` built from the submitted candidates. No other module is added.

### 2. The candidate contract

The host speaks the engine's **domain-neutral roles and relations**, never node or edge types. The domain's
policy maps them to registered vocabulary, as it does for the rule-based reader, so the vocabulary comes only
from a Domain Pack ([target architecture](../architecture/target.md), constraint 4).

A submission carries the material and, optionally:

- `learner`, the speaker label the learner has in the material, such as `用户` or `User`;
- `hostSession`, an opaque identifier for the host's conversation;
- `submissionId`, an idempotency key (section 5).

| item     | fields                                                                              | notes                                                                     |
| -------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| node     | `ref`, `role` (`concept`, `question`, `claim`, `evidence`), `label`                 | `thought` is excluded: a thought is what the learner organises (ADR 0009) |
| relation | `from`, `to`, `relation` (`about`, `answers`, `supports`, `contradicts`, `revises`) | an end is `cand:<ref>` of this submission, or an existing node id         |
| state    | `target`, `dimension`, `level`                                                      | the target is `cand:<ref>` or an existing node id                         |

Every item also carries:

- `quote`: the words it rests on, verbatim from the material;
- `occurrence` (optional): which occurrence of the quote is meant, counted 1-based over the whole canonical
  source text (section 3);
- `basis`: `stated` or `inferred` (section 6);
- `rationale`: why the host proposes it.

Existing node ids come from `recall`. An id that is not in the graph is refused (`unknown_endpoint`), as today.

**Misconceptions and corrections** use registered vocabulary only:

- **A misconception** is a claim candidate quoting what the learner said. It may come with `contradicts` from
  the evidence or claim that shows the problem, and with a proposed `conflict` on that claim.
- **A correction** is the learner's revised claim, linked from the earlier claim by `revises`. The earlier claim
  may be a candidate of the same submission or a node already in the graph (section 4).
- The Learn policy gains two things:
  - `revises` → `evolves_to`, which is already registered as _a later revision of the same idea_;
  - `conflict` with levels `suspected` and `open` only.
- An agent may suggest that a conflict exists. It may never suggest that one is `resolved` or `none`.
  Settling a conflict is the person's act ([AGENTS.md](../../AGENTS.md#project-invariants): _conflict is
  preserved, not resolved_).
- A correction never revokes the earlier claim. History points forward.

### 3. The source text and quote verification

**One canonical text.** At ingestion, before segmentation, the material is put in Unicode NFC and every `\r\n`
or lone `\r` becomes `\n`. **That canonical text is what the source stores.** Episodes, spans, excerpts and
the review's highlight are all computed on it, so a span never needs mapping back to another form of the
text. Episteme does not keep the bytes as the host sent them. They differ from the stored text only by
canonical equivalence and line endings, which carry nothing a reviewer judges. This applies to both readers.
Spans are UTF-16 code unit offsets into the stored text, the unit `String.prototype.slice` uses, so a
Workspace highlights `source.text.slice(span.start, span.end)`.

Quotes are put in the same canonical form, then matched **exactly**: no case folding, whitespace collapsing
or fuzzy matching.

**Where a quote is.** Verification belongs to the engine, which is the one authority on origins, for every
reader:

There are two ways of saying where a quote is, and they are kept apart:

- **Outside, for the host: the whole source.** The host's `occurrence` counts, 1-based, the occurrences of
  the canonical quote in the **whole canonical source text**, in order. Overlapping occurrences count
  separately. The host never sees episodes, and nothing it sends refers to one.
- **Inside, for the engine: an episode.** A suggestion handed to the engine may name the episode its quote is
  in and the occurrence within that episode. Without one, the quote is looked for in the episode being read,
  as today. This is the engine's own field and never reaches the agent surface.

The host reader converts the first into the second. It finds the named occurrence in the whole text, takes the
episode that contains it, and counts which occurrence it is within that episode. The engine then locates the
quote again from the episode and the occurrence, so a mistake in the reader cannot produce a span the engine
did not check.

**The engine stops falling back.** A suggestion that gives a quote the engine cannot locate is refused as
`quote_not_found`. Only a suggestion with no quote keeps the whole episode as its origin, and only the
rule-based reader may produce one.

**Ambiguity.** For a host item, ambiguity is judged on the whole source:

- If the quote occurs once in the whole text, `occurrence` may be omitted. If one is given, it must be `1`.
- If the quote occurs more than once in the whole text, `occurrence` is required. This holds even when each
  episode contains it only once. Without it, the item is refused as `quote_ambiguous`, and no occurrence is
  chosen for it. The host lengthens the quote or names the occurrence. A learner who says "我不懂" before an
  explanation and again after it has said two different things.
- An `occurrence` greater than the number of occurrences is refused as `quote_not_found`.
- The rule-based reader quotes inside its own episode and names the occurrence within that episode when the
  words recur there. That is the engine's internal form, and the same no-guessing rule applies to it.

**Length.** What a quote must contain is counted in letters and digits (`\p{L}` and `\p{N}`), not characters.
A quote needs at least 2 of them, so "懂了" and "OK" pass, and "了", "？" or "..." do not. A quote may be at
most 1,000 characters long. However short the quote, the review shows it highlighted inside its episode,
because the origin carries the episode. A short quote is therefore read in context, not alone.

**Within one episode.** A quote that crosses an episode boundary is refused. Its words would not belong to
one learning episode.

New refusals, returned as values with codes:

| code                   | when                                                                           |
| ---------------------- | ------------------------------------------------------------------------------ |
| `missing_quote`        | a host item has no quote                                                       |
| `quote_not_found`      | the quote is not in the material, or the named occurrence does not exist       |
| `quote_ambiguous`      | the quote occurs more than once in the whole source and no occurrence is named |
| `quote_spans_episodes` | the quote crosses an episode boundary                                          |
| `quote_too_short`      | the quote has fewer than 2 letters or digits                                   |
| `quote_too_long`       | the quote is longer than 1,000 characters                                      |
| `basis_mismatch`       | a `stated` item's quote is not in a turn of the learner (section 6)            |

A refused item is reported with its `ref` and code and is never queued. An item that depends on a refused one
is refused as `depends_on_refused`, as today.

### 4. References across episodes

A host's `ref` names a node candidate for the whole submission. The reader turns it into the engine reference
through what the engine already provides:

- `CandidateNode`, the shape of each entry in `workspace.candidates`, gains the reader's own name for the
  node (`localRef`). The reader finds the entry with its `ref` and uses that entry's engine reference. It
  never constructs one.
- A node candidate is handed to the engine in the episode its quote lies in.
- A relation or a state change is handed to the engine in the latest of three episodes: its quote's, and
  each candidate end's. By then the engine has kept or refused every end. The quote is still located in its
  own episode (section 3), so the origin is where the words are.
- An end that names a refused candidate is refused as `depends_on_refused`. An end that names no candidate of
  the submission is refused as `unknown_endpoint`.

In the queue, the engine references become `cand:<suggestion id>`, as for any distillation. The person
accepts in order: a `revises` between two candidates can be accepted only after both claims
(`depends_on_pending`), and never once either is dismissed (`unresolved_candidate`).

**Revising understanding from an earlier session** needs no candidate on the old side. `from` is the existing
claim's id, found through `recall`. `to` is the new claim, a candidate of this submission.

### 5. Retries, repetitions and evolution

Three cases that look alike are kept apart:

- **The same request, retried.** A submission may carry a `submissionId`.
  - **Scope.** It is unique per submitting agent within one graph: the pair of the calling agent's actor and
    the `submissionId`. Two agents that happen to use the same id never meet. A submission without an id is
    never matched by id.
  - **What is compared.** The source records the scope and a **payload digest**. The digest is taken over the
    whole canonical payload: the canonical material, the title, `learner`, `hostSession`, and every candidate
    with all its fields, in the order sent.
  - **Same scope, same digest:** the submission is a retry. It writes nothing. It returns the original source
    id and the suggestions from that source that are still pending, with the status `duplicate_submission`.
  - **Same scope, different digest:** it is refused as `submission_conflict` and writes nothing, even if only
    the order of the candidates or one field changed. A request is never treated as a retry because it merely
    resembles one.
  - Only a submission that stored its source is remembered. One refused as a whole, for example as too long,
    left nothing behind, so the same id may be used again.
- **The same words, sent again without a key.** The source records a digest of its canonical text. When an
  identical text arrives with the same `hostSession`, the existing source is reused rather than stored twice.
  A candidate whose proposal and origin (source and span) both match a pending suggestion is refused as
  `already_pending`. That is a retry by content, and nothing is lost by refusing it.
- **The same idea, said again at another time.** This is not a duplicate. It is evidence of how
  understanding stands, and it must reach the person:
  - `already_known` refuses **only the creation of a second node** for an idea the learner already has, matched
    by type and normalised label, because one idea is one node. It says nothing against the observation. The
    refusal carries the `existingNodeId` and the candidate's verified origin (source id, span, excerpt). The
    source itself is stored, so the words stay traceable whatever the host does next.
  - With that id, the host may resubmit what the new words actually show: a state change, a relation, or a
    `revises` from the existing claim to a new one, each quoting its own words. It resubmits only what the
    words support. **Saying something again is not by itself a change of state.** The host must not turn a
    repetition into a higher `confidence` or `articulation` to keep the observation. If nothing changed, the
    stored source is the record, and nothing else is proposed.
  - State changes and relations are never refused for matching what is already recorded or pending from
    another source. Two observations at two times are two suggestions, each with its own origin.

Nothing is deduplicated by label alone across sources, and every refusal is returned with the reason and, where
there is one, the existing id.

### 6. What the learner said and what the agent inferred

Every host item states its `basis`:

- **`stated`**: the learner said it. The quote must lie inside a turn whose speaker is the submission's
  `learner`, and Episteme checks this against the segmented turns. When the material is not a dialogue, or no
  `learner` is given, nothing can be `stated`, and a `stated` item is refused as `basis_mismatch`.
- **`inferred`**: the host's interpretation of the conversation. The quote is the evidence it rests on, from
  any speaker. The rationale must say what was inferred from it.

For state changes this is the line between a self-report and a judgement:

- "我能讲给别人听了" in the learner's turn is a `stated` articulation.
- The learner explaining a mechanism correctly, as judged by the agent, is an `inferred` articulation.
- A `conflict` suggestion is usually `inferred`. It is `stated` only when the learner said they see a clash.

The basis is part of what the person decides on, and it is never rewritten:

- The review shows an `inferred` item as the agent's reading, never as the learner's words. The excerpt is
  labelled with its speaker.
- An accepted node keeps `basis` in its properties, next to `suggestion` and `origin`.
- An accepted state change records its basis in the event's `source`, next to the suggestion, the proposing
  agent and the channel. A structured field on the state value would change Core's `StateValue`. That is left
  to its own ADR, if the timeline needs to filter by it.
- Accepting an `inferred` state commits it as `confirmed` by the person, as any accepted suggestion is. What
  the person confirms is the agent's reading, and the record keeps that it was a reading.

**Neither the basis nor the decision proves ability.**

- `stated` means the learner said these words.
- A person's acceptance means they endorse the record as describing their understanding at that time.
- Neither demonstrates that the learner has mastered anything, or can explain, apply or transfer it.

Each dimension keeps its own meaning. `confidence` is how sure the learner is, not how right. `articulation`
is how well they can put it into words, not whether they can use it. A confirmed state is recorded as exactly
that dimension at that level, and nothing is derived from it. No surface (`recall`, `reflect`, the review)
may present a `stated` or confirmed state as proof of ability, and there is still no single mastery score
([AGENTS.md](../../AGENTS.md#project-invariants)).

The rule-based reader marks a state change `stated` only when the material is a dialogue and the quote is in a
turn of the given `learner`. Otherwise it marks it `inferred`. The Workspace's distillation has no `learner`
today, so its state suggestions are `inferred` until it asks for one.

### 7. What is written before a decision

Before the person decides, a distillation may write exactly two files beside the graph:

- the **source**, in `<graph>.sources.jsonl`;
- the **drafts**, in `<graph>.suggestions.jsonl`.

Nothing reaches the graph or the event log: no node, edge or state event, and no change to the graph file. A
retry that creates nothing writes nothing. Refused items are returned, not stored. Only the decision path
(ADR 0008) writes the graph.

### 8. Who proposed, and where it is asked

- With host candidates, `proposedBy` is the calling agent's actor (`actor_agent_<client name>`), because its
  model did the reading. `requestedBy` is the same actor. With Episteme's reader, both stay as they are today.
  The client name is self-declared: provenance, not identity (ADR 0008).
- Host candidates go to the review queue. They are never put to the person through elicitation, as for
  `distill` today (ADR 0009).

### 9. Bounds

- The material keeps `MAX_MATERIAL` (20,000 characters, counted on the canonical text).
- A submission carries at most 100 items. The policy's per-episode and per-run limits, and `MAX_PENDING`,
  apply as for any distillation.
- Labels keep the engine's 400-character limit, and a rationale must not be empty.
- `hostSession` and `submissionId` are at most 200 characters each.

## What this does not establish

- That the quoted material is a faithful record of the conversation. The host chose and sent it.
- That a speaker label is who it says. `stated` means the quote is in a turn the host labelled as the learner's.
- That a candidate follows from its quote. A host can quote real words and draw the wrong conclusion. The
  person sees the excerpt, its speaker and the basis, and judges.
- That the person holds the understanding. Only the person's decision on each suggestion establishes that.
- That the learner has mastered anything. Neither `stated` nor the person's acceptance demonstrates ability
  (section 6).
- Who the host is. The client name is self-declared.
- Anything about who may decide. That belongs to ADR 0012 ([#17](https://github.com/SAIR-club/Episteme/issues/17)).

## Alternatives

**Have the host call `propose` once per item.** This already works for claims. Rejected because it carries no
material and no quote, it cannot propose a concept, a question or evidence, and it takes one round trip per
item with no way to refer between them.

**A separate tool, such as `extract`, beside `distill`.** It would make the reader visible in the tool name.
Rejected because it would duplicate the material path, the source store, the result shape and the refusals,
and a host would have to learn two tools that differ in one field. The source records which reader produced
each candidate.

**First send the material, then `propose` items with a source id and a quote.** This keeps tools small.
Rejected because a run would span several calls with partial states between them, and references between
items of one reading would have to outlive a call.

**Keep the text as sent and map normalised offsets back to it.** This keeps the host's exact bytes. Rejected
because it needs an offset map maintained beside every span, for differences (canonical equivalence and line
endings) that change nothing a reviewer reads. Storing the canonical text makes every span correct by
construction.

**Fuzzy quote matching**, ignoring whitespace, case or punctuation. This would refuse fewer of a model's
near-quotes. Rejected for the first version because every relaxation weakens what "verified" means, and the
span shown to the person could then differ from what the host claimed. The refusal rate is measured in use,
and matching is relaxed only with that evidence.

**Take the first occurrence of an ambiguous quote.** Simpler for the host. Rejected because it would silently
pin a statement to the wrong moment, which is exactly what a timeline of understanding must not do.

**A minimum quote length in characters.** Rejected because characters measure Chinese and English
differently: six characters is a sentence in Chinese and a word in English.

**Deduplicate by normalised label across all sources.** Rejected because a learner saying the same thing at
two times is evidence, not noise.

**Let the host construct the engine's references.** Rejected because they encode the engine's episode
numbering, which the host does not see and which may change.

**Run Episteme's reader as well as the host's on the same material.** Rejected because the two sets would
overlap with no principled way to merge them.

**A model-backed reader inside Episteme.** Rejected: Episteme calls no model. The host supplies it (ADR 0008).

**Trust the host's candidates without verification.** Rejected: the quote is the one claim of the host that
Episteme can check.

**Store the conversation as a tree now.** Rejected for this decision: ADR 0010 reserves conversation
structure for its own design. A source with an optional `hostSession` leaves room for it.

## Consequences

- A host can turn a stretch of a learning conversation into candidates of every kind the domain allows. Each
  is pinned to the words it came from, says whether the learner said it or the agent inferred it, and records
  nothing until the person decides.
- The domain policy, not the host, still decides what may be suggested. The Learn policy grows by one relation
  (`revises`) and one dimension (`conflict`: `suspected`, `open`).
- The engine becomes stricter for every reader:
  - it refuses an unlocatable quote instead of widening the origin;
  - it refuses an ambiguous quote unless an occurrence is named;
  - it counts quote length in letters and digits.

  The rule-based reader quotes its own episode and names occurrences, so its results do not change. The
  existing distillation tests hold it to that.

- Sources store canonical text, for both readers. Sources written earlier keep the text they were stored with,
  and their spans stay valid against it.
- The engine's types grow by two optional fields: where a quote is on `Suggestion`, and `localRef` on
  `CandidateNode`. `Suggestion` and the stored suggestion also carry `basis`.
- New refusal codes: `missing_quote`, `quote_not_found`, `quote_ambiguous`, `quote_spans_episodes`,
  `quote_too_short`, `quote_too_long`, `basis_mismatch`, `submission_conflict` and `already_pending`, plus the
  status `duplicate_submission`.
- The sources file gains `reader`, `hostSession`, a digest of the text, and for a keyed submission its scope
  (agent actor and `submissionId`) and payload digest. The schema version is bumped, and the earlier version is
  still read. The drafts file gains `basis`, also read compatibly.
- An `already_known` refusal carries `existingNodeId` beside the origin that refusals already return.
- The MCP surface keeps the same four tools. `distill`'s description and input schema grow. Its
  `structuredContent` keeps its shape and adds the reader.
- Material sent by a host is personal data in plain text, like the graph. It falls under encryption at rest in
  the privacy work. A host skill should send only the stretch of conversation it read, never a whole
  transcript.
- The implementation replaces the `it.todo` for #16 in `tests/cross-agent-loop.test.ts` with a passing test,
  as set out in #16.
- Documentation to update with the implementation: the distillation package README (_Origin_, _Checks_), the
  MCP package README, and the Learn policy's description.

## Tests the implementation must include

Each design point above is held by at least one test in the implementation PR:

| design                        | scenario                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| canonical text and spans      | material with `\r\n` line endings, a decomposed `é` (`e` + U+0301) and Chinese text; a quote in NFC after the `é`. The stored source text is canonical, and `source.text.slice(span.start, span.end)` equals the quote exactly, also after a restart                                                                                                                                                                                                                        |
| no fallback                   | a host claim quoting words that are not in the material is refused `quote_not_found`, and no suggestion or source span is created for it; a rule-based distillation of the existing fixtures produces exactly the same suggestions and origins as before                                                                                                                                                                                                                    |
| ambiguity and occurrence      | the learner says "我还是不懂" once in episode 1 and once in episode 3, so each episode holds it once but the source holds it twice. Without `occurrence` the state item is refused `quote_ambiguous` and no origin is recorded; with `occurrence: 2` its origin is the second occurrence, in episode 3; with `occurrence: 3` it is refused `quote_not_found`; a quote that occurs once is accepted without `occurrence`, and refused `quote_not_found` with `occurrence: 2` |
| length                        | quotes "懂了" and "OK" pass; "了", "？" and "..." are refused `quote_too_short`; a 1,001-character quote is refused `quote_too_long`                                                                                                                                                                                                                                                                                                                                        |
| within one episode            | a quote that runs from the end of one episode into the next is refused `quote_spans_episodes`                                                                                                                                                                                                                                                                                                                                                                               |
| references across episodes    | claim A quoted in episode 1, claim B in episode 3, and `revises` A → B quoted in episode 3. Accepting the `revises` first is refused `depends_on_pending`; after A and B are accepted it commits an `evolves_to` edge A → B; when A is dismissed it is refused `unresolved_candidate`. The host never sends an engine reference                                                                                                                                             |
| revising an earlier session   | an existing claim id from `recall` as `from`, a new candidate as `to`: accepted in order, it links the old node to the new one, and the old node is not revoked                                                                                                                                                                                                                                                                                                             |
| retry with a key              | agent A sends the same submission twice with one `submissionId`: the second writes nothing (sources and drafts files byte-for-byte unchanged) and returns `duplicate_submission` with the same source id. The same agent and id with the same material but one candidate changed, or the candidates reordered, is refused `submission_conflict` and writes nothing. Agent B using the same `submissionId` for its own submission is processed normally                      |
| retry without a key           | the same material and candidates twice with the same `hostSession`: one source, and each repeated candidate refused `already_pending`                                                                                                                                                                                                                                                                                                                                       |
| the same idea, another time   | a claim the learner already has, said again in new material. The node is refused `already_known` with `existingNodeId` and the new origin, nothing else is proposed, the new source is stored and the graph is unchanged. In a second material the learner also says "这次我很确定": a `confidence` change on `existingNodeId` quoting those words is kept as its own suggestion, and after acceptance the node's history shows both state events with their own sources    |
| stated and inferred           | a `stated` state whose quote is in the tutor's turn is refused `basis_mismatch`; a `stated` item without `learner` is refused; an accepted `inferred` articulation leaves `inferred` in the event's source and in the response, and the review data labels it as the agent's reading. An accepted `stated` `articulation: medium` changes only `articulation`: no other dimension of that node is set, and no new field claims mastery                                      |
| conflict levels               | a host `conflict: open` is kept; `conflict: resolved` and `conflict: none` are refused `not_allowed`                                                                                                                                                                                                                                                                                                                                                                        |
| nothing written before review | after a host distillation with kept and refused items, and after a retry, the graph file is byte-for-byte unchanged and the event count is the same; only the sources and drafts files changed                                                                                                                                                                                                                                                                              |
| provenance and readers        | a kept host suggestion has `proposedBy` and `requestedBy` equal to the calling agent's actor and its source has `reader: host`; a distillation without `candidates` still uses the rule-based reader                                                                                                                                                                                                                                                                        |
| the loop                      | the #16 `it.todo` in `tests/cross-agent-loop.test.ts` is replaced as #16 specifies, and every existing assertion there still passes                                                                                                                                                                                                                                                                                                                                         |
