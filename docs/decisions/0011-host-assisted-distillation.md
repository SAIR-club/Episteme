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

- The engine (`@episteme/distillation`) segments material into episodes and asks a `CognitiveAgent` for
  structure, connections and state changes. It checks every candidate against the domain's
  `DistillationPolicy`, its limits and its references, and keeps refused candidates with their reason.
- `Suggestion.quote` exists. The engine locates a quote inside its episode and records the span and an
  excerpt as the candidate's origin.
- `LearnSession.distill(material, { agent, requestedBy })` accepts any `CognitiveAgent`, stores the material
  in `<graph>.sources.jsonl`, applies `propose`'s own checks, and queues what survives as pending suggestions.

One property of the current engine matters here: **a quote that is not found does not fail.** The origin
silently falls back to the whole episode. That is harmless for the rule-based reader, which only quotes the
episode it is reading, but it would let a host's paraphrase pass as a verified quote.

## Decision

**A host may submit its own reading of a stretch of material as candidates. Episteme keeps the material,
verifies every candidate's quote against it, runs the candidates through the same engine, policy and checks
as its own reader, and queues the survivors for review. A verified quote proves only that the words are in the
material the host sent. Only the person's decision makes anything their understanding.**

### 1. One tool, two readers

The MCP `distill` tool gains an optional `candidates` field.

- Without it, nothing changes: Episteme's rule-based reader reads the material (ADR 0009).
- With it, **the host is the reader**. Episteme does not also run its own reader on the same call. Running
  both would produce two overlapping sets of candidates for the person to sort out.

The material path, the source store, the result shape, the review queue and the refusals are shared. A host
skill has one tool to learn, and the agent surface keeps exactly the tools `recall`, `propose`, `reflect` and
`distill` (`tests/cross-agent-loop.test.ts` asserts this list).

REST does not gain the field. A Workspace has no model, and `/api/v1/distill` stays what it is. Both entry
points call the same application command, so there is still one implementation (ADR 0010, decision 4).

### 2. The candidate contract

The host speaks the engine's **domain-neutral roles and relations**, never node or edge types. The domain's
policy maps them to registered vocabulary, as it does for the rule-based reader, so the vocabulary still
comes only from a Domain Pack ([target architecture](../architecture/target.md), constraint 4).

| item     | fields                                                                              | notes                                                                     |
| -------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| node     | `ref`, `role` (`concept`, `question`, `claim`, `evidence`), `label`                 | `thought` is excluded: a thought is what the learner organises (ADR 0009) |
| relation | `from`, `to`, `relation` (`about`, `answers`, `supports`, `contradicts`, `revises`) | an end is `cand:<ref>` of this submission, or an existing node id         |
| state    | `target`, `dimension`, `level`                                                      | what the learner said about their own understanding; the target as above  |

Every item also carries a `quote` and a `rationale`. Both are required.

Existing node ids come from `recall`. An id that is not in the graph is refused (`unknown_endpoint`), as it is
today. A node whose type and label match one the learner already has is refused as `already_known`, with that
node's id, so the host can resubmit it as a relation or a state change instead.

**Misconceptions and corrections** use registered vocabulary only:

- **A misconception** is a claim candidate quoting what the learner said. It may come with `contradicts` from
  the evidence or claim that shows the problem, and with a proposed `conflict` on that claim.
- **A correction** is the learner's revised claim, linked from the earlier claim by `revises`.
- The Learn policy gains two things:
  - `revises` → `evolves_to`, which is already registered as _a later revision of the same idea_;
  - `conflict` with levels `suspected` and `open` only.
- An agent may suggest that a conflict exists. It may never suggest that one is `resolved` or `none`.
  Settling a conflict is the person's act ([AGENTS.md](../../AGENTS.md#project-invariants): _conflict is
  preserved, not resolved_).
- A correction never revokes the earlier claim. History points forward.

### 3. Quote verification

Verification is Episteme's, and it happens before any candidate reaches the engine:

- **Exact.** A quote must occur in the submitted material, character for character, after both are put in
  Unicode NFC and `\r\n` is read as `\n`. There is no case folding, whitespace collapsing or fuzzy matching.
- **Within one episode.** A quote that crosses an episode boundary is refused. Its words would not belong to
  one learning episode.
- **First occurrence.** When the same words occur more than once, the first occurrence is the origin. The
  excerpt the person sees is the same either way.
- **Bounded.** A quote is between a minimum and a maximum length. The initial values are 6 and 1,000
  characters, set in the engine, and they are changed only with evidence.

The new refusals are values with codes:

| code                   | when                                  |
| ---------------------- | ------------------------------------- |
| `missing_quote`        | the item has no quote                 |
| `quote_not_found`      | the quote is not in the material      |
| `quote_spans_episodes` | the quote crosses an episode boundary |
| `quote_too_short`      | the quote is shorter than the minimum |
| `quote_too_long`       | the quote is longer than the maximum  |

A refused item is reported back with its `ref` and code, and is never queued. An item that depends on a
refused one is refused as `depends_on_refused`, as today.

**The engine stops falling back.** A candidate that gives a quote the engine cannot locate is refused as
`quote_not_found`, whichever reader produced it. Only a candidate with no quote keeps the whole episode as
its origin, and only the rule-based reader may produce one. The rule-based reader quotes the episode it
reads, so its results do not change. The existing distillation tests hold it to that.

### 4. Material and provenance

The material is the stretch of the conversation the host chooses to send, verbatim, preferably as
`speaker: utterance` lines so it segments as a dialogue. It is stored as a source in
`<graph>.sources.jsonl`, like any distilled material, outside the graph. The source record gains:

- `reader`: `episteme` or `host`;
- `hostSession`, optional: an opaque identifier the host declares for its conversation, at most 200
  characters.

Both are provenance, not authority. Records written before this change read as `reader: episteme` with no
host session. The sources file's schema version is bumped, and the earlier version is still read.

This is **not a conversation store**. Nothing records turns, parents or branches. A later conversation store
(ADR 0010, _Conversation structure is Episteme data_) may link a source to the conversation it came from
through `hostSession`, and is not constrained by this ADR beyond that.

### 5. One validation path

Host candidates are read into the engine through an adapter that implements `CognitiveAgent`. Each verified
item is handed to the episode its quote lies in. A relation or a state change whose end is found only in a
later episode is evaluated in that later episode, so its end exists when it is checked. After that, nothing is
specific to the host:

- the engine applies the policy's types, the domain properties, duplicates, `already_known`, ends, the
  per-episode and per-run limits, and `policy.validate`;
- the session applies `propose`'s checks and the pending-queue limit;
- what survives becomes pending suggestions that may refer to each other as `cand:`.

The engine's candidate references stay the engine's. The adapter maps the host's `ref`s onto them.

A new check applies to **both** readers. A proposal identical to one already pending, compared after the same
normalisation the engine uses for labels, is refused as `already_pending`. A host that retries a submission
therefore does not fill the queue with copies.

### 6. Who proposed

With host candidates, `proposedBy` is the calling agent's actor (`actor_agent_<client name>`), because its
model did the reading. `requestedBy` is the same actor. With Episteme's reader, both stay as they are today.
The client name is self-declared, so this is provenance, not identity (ADR 0008).

### 7. Never asked in the host

Host candidates go to the review queue and are never put to the person through elicitation, as for `distill`
today (ADR 0009). A host reads its own extraction back as a list of pending ids and refusals.

### 8. Bounds

- The material keeps `MAX_MATERIAL` (20,000 characters).
- A submission carries at most 100 items. The policy's per-episode and per-run limits, and `MAX_PENDING`,
  apply as for any distillation.
- Labels keep the engine's 400-character limit, and a rationale must not be empty.

## What this does not establish

- That the quoted material is a faithful record of the conversation. The host chose and sent it.
- That a candidate follows from its quote. A host can quote real words and draw the wrong conclusion. The
  person sees the excerpt next to the candidate and judges.
- That the person holds the understanding. Only the person's decision on each suggestion establishes that.
- Who the host is. The client name is self-declared.
- Anything about who may decide. That belongs to ADR 0012 ([#17](https://github.com/SAIR-club/Episteme/issues/17)).

## Alternatives

**Have the host call `propose` once per item.** This already works for claims. Rejected because it carries no
material and no quote, it cannot propose a concept, a question or evidence, and it takes one round trip per
item with no way to refer between them.

**A separate tool, such as `extract`, beside `distill`.** This would make the reader visible in the tool name.
Rejected because it would duplicate the material path, the source store, the result shape and the refusals,
and a host would have to learn two tools that differ in one field. The source records which reader produced
each candidate.

**First send the material, then `propose` items with a source id and a quote.** This keeps tools small.
Rejected because a run would span several calls, with partial states between them, and references between
items of one reading would have to outlive a call.

**Fuzzy quote matching**, ignoring whitespace, case or punctuation. This would refuse fewer of a model's
near-quotes. Rejected for the first version because every relaxation weakens what "verified" means, and the
span shown to the person could then differ from what the host claimed. The refusal rate is measured in use,
and matching is relaxed only with that evidence.

**Run Episteme's reader as well as the host's on the same material.** Rejected because the two sets of
candidates would overlap without a principled way to merge them, and the person would review duplicates.

**A model-backed reader inside Episteme.** Rejected: Episteme calls no model. The host supplies the model
(ADR 0008).

**Trust the host's candidates without verification.** Rejected: provenance that cannot be checked is not
provenance. The quote is the one claim of the host that Episteme can verify.

**Store the conversation as a tree now.** Rejected for this decision: ADR 0010 reserves conversation structure
for its own design. A source with an optional host session identifier leaves room for it without
anticipating it.

## Consequences

- A host can turn a stretch of a learning conversation into candidates of every kind the domain allows, each
  pinned to the words it came from. Nothing is recorded until the person decides.
- The domain policy, not the host, still decides what may be suggested. The Learn policy grows by one relation
  (`revises`) and one dimension (`conflict`: `suspected`, `open`).
- The engine refuses an unlocatable quote instead of widening the origin. For the rule-based reader this
  changes no result. For anything else it is the point.
- Six new refusal codes: `missing_quote`, `quote_not_found`, `quote_spans_episodes`, `quote_too_short`,
  `quote_too_long` and `already_pending`.
- The sources file gains `reader` and `hostSession`, with a schema version bump that still reads the earlier
  version.
- The MCP surface keeps the same four tools. `distill`'s description and input schema grow. Its
  `structuredContent` keeps its shape and adds the reader.
- Material sent by a host is personal data in plain text, like the graph. It falls under encryption at rest
  in the privacy work. A host skill should send only the stretch of conversation it read, never a whole
  transcript.
- The implementation replaces the `it.todo` for #16 in `tests/cross-agent-loop.test.ts` with a passing test,
  as set out in #16.
- Documentation to update with the implementation: the distillation package README (_Origin_, _Checks_), the
  MCP package README, and the Learn policy's description.
