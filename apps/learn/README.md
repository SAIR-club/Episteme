# @episteme/app-learn

The Learn interaction surface: a place where a learner actually uses the cognitive graph instead of
reading about it.

```bash
pnpm learn        # terminal
pnpm learn:web    # local web surface at http://127.0.0.1:4321
```

Both run the same loop, over the same graph file, through the same `LearnSession`. They cannot have it open
at the same time: a graph has one owner, and the second surface refuses to start and names the process that
holds it. Ctrl+C and `quit` release the graph; only a process killed outright leaves its lock behind, and the
message then says which file to delete.

The web surface is also the graph's **MCP host**: it serves the endpoint at `/mcp`, so an agent can recall
the learner's understanding and propose changes to it while the learner works here. See
[`@episteme/mcp`](../../packages/mcp/README.md).

```bash
pnpm learn --help
pnpm learn:web --file /tmp/chemistry.jsonl --port 4400
```

`--file` (or `EPISTEME_FILE`) chooses the graph; the default is `~/.episteme/learn.jsonl`. Both the
separated and the joined spelling (`--file x` and `--file=x`) work, because a learner who guesses wrong
would otherwise silently record their understanding in a file they did not intend — there is a test for
that, and for the case where a flag's value is missing.

## Bringing your own topic

The seeded transformer topic is a demonstration. A learner working on chemistry should not have to read about
attention heads to understand the interface:

```bash
pnpm learn:web --topic ./my-topic.json
pnpm learn:web --blank          # start from an empty graph and write the first node yourself
```

```json
{
  "title": "有机化学：亲核取代",
  "about": "从电子推动看取代反应为什么这样发生。",
  "source": "textbook:clayden",
  "nodes": [
    { "label": "亲核取代（SN2）" },
    { "label": "离去基团" },
    { "label": "为什么 SN2 会发生构型翻转？", "kind": "question" },
    { "label": "SN2 是一步完成的", "kind": "claim" }
  ]
}
```

Three properties matter here:

- **A claim from a topic file is seeded at `reference` tier, not `thought`.** The tier decides whether a node
  counts as the learner's own understanding, and seeding an authored claim as `thought` would put words in
  their mouth before they had said anything. A test asserts it, along with the fact that **no topic file can
  carry cognitive state** — nothing in a file may claim what a learner understands.
- **Validation is strict and loud.** A missing label, an unknown `kind`, invalid JSON: each names the
  offending entry and fails before the socket opens, rather than serving a graph that silently disagrees with
  the file the learner wrote.
- **The interface has no idea what your topic is, and must not pretend to.** Pointing it at chemistry exposed
  a real leak: the answer template said it would first establish "what self-attention can and cannot
  represent" — true for the built-in topic, nonsense for anyone else's. The templates are now domain-neutral,
  the suggestion prompts are derived from the questions actually in the graph rather than hardcoded, and a
  test asserts that no demo-topic word can appear in an answer about someone else's material.

## The loop

```text
1. ask a question in your own words
2. see which of your own prior understanding was retrieved — and WHY, signal by signal
3. record how well you understand one of those things
4. ask again
```

The fourth step is the point. Before anything is recorded the answer has to establish the ground; after,
it starts from what you said you understood. The interface shows the two answers side by side, so the
change is a comparison rather than a claim.

`pnpm learn` runs the same loop, and has a `progress` command that prints what the web panel's
"到目前为止" section shows.

## Language

**The interface is Simplified Chinese with the English term alongside.** `AGENTS.md` requires Simplified
Chinese for user-facing prose and English for code, and both are carried in the payload rather than
translated in a view — a dimension whose Chinese name disagreed with its English one would be a correctness
problem, not a cosmetic one.

You can ask in Chinese or in English. The seeded labels are bilingual (`自注意力（Self-Attention）`), and the
deterministic embedding adapter has a Chinese lexicon that maps Chinese terms onto the same vocabulary as the
English one, so **one graph serves a bilingual learner rather than two parallel stores**.

That last part was a real defect, and it is worth knowing about because of how it presented: with a Chinese
question, **every result sat at exactly the recency floor and no semantic signal fired at all**. The tokenizer
split on characters that are not letters, Chinese has no spaces, so the whole question arrived as one token
and matched nothing. A bilingual interface over a monolingual retriever is worse than either alone — it looks
like it works and quietly returns nothing. See `tests/chinese-retrieval.test.ts`.

## Why this exists

Phases 0–2 proved the machinery: append-only history, actor isolation, fork lineage, persistence, restart
recovery, and paraphrased retrieval. Every one of those was demonstrated by a test or a printed narrative.
None of them was ever _used_.

That gap matters because the remaining unknowns are not architectural. Whether retrieval helps when the
questions are real, whether `RelevantContext` is the right shape for a real model, and whether the
cognitive signals reflect anything a learner recognises — none of those can be answered by more backend
work. They need a surface.

## What it deliberately is not

- **No account, no login.** There is no identity layer, and this app does not pretend otherwise. It is a
  single-user local tool.
- **No LLM.** The responder is the deterministic stand-in from `@episteme/domain-learn`. It branches in
  three structurally different ways depending on what the learner has recorded, which is enough to show the
  loop working and to keep the test suite reproducible. Swapping in a real model means implementing
  `CognitiveAgent`; nothing here would change.
- **No framework, no bundler.** The web surface is `node:http` plus one HTML file with plain DOM. The
  project's own claim is that it runs with no database, no model and no frontend toolchain, and adding a
  build step to demonstrate that would undercut it.
- **No teaching.** It retrieves, records and answers. It does not decide what you should learn next — that
  would be an application's job, and probably a different one.

## The agent cannot write

Recording understanding goes through `LearnSession.record()`, which commits a `StateEvent` authored by the
human. The method takes no actor parameter, so there is no way to name a different author — a surface that
accepted one would be one refactor away from letting the agent write the learner's understanding. Core's
`core/ai-cannot-author-state` guard rejects a non-human author independently, and a test asserts both.

## What the interface shows, and why

**Every reason is a contribution that actually produced the ranking**, not a reconstruction. The ranked
entries carry their `SignalContribution`s through `RelevantContext.ranked`, computed by the same retrieval
call that produced the order displayed. A view that fetched reasons separately could show an explanation
that disagrees with the list next to it.

**The weights are displayed.** A learner can see that `semantic=0.5` and `recency=0.05`, which makes the
ranking checkable instead of authoritative. Showing the model is the honest version of "we used AI to rank
this".

**Nothing-recorded is shown as nothing-recorded.** `summary` is `''` when the learner has recorded nothing,
and the badge says so, because "the system found nothing relevant" and "the system found nothing" are
different problems with different fixes.

**"What have I understood?" is answered separately from "what is relevant here?"** The retrieval panel
answers the second and the graph listing answers "what exists". Neither answers _what did I get out of this_,
which is the question a learner has after using the loop a while — so `progress()` exists, and it is the only
thing on the surface that says whether a session changed anything.

It classifies each item the learner has touched into four groups, ordered by what to do next:

| group         | meaning                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------- |
| `conflict`    | the learner holds something contradicting this — the system will not build on it, so it goes first |
| `shaky`       | recorded, but with no ground under it yet                                                          |
| `unexplained` | believed but not sayable — the situation a scaffold is for                                         |
| `settled`     | firmly held and explainable; nothing to add by resurfacing it                                      |

`shaky` before `unexplained` is deliberate: an item with no ground at all is more urgent than one that is
merely hard to put into words. And `unexplained` requires confidence to have been _recorded_ — an unrecorded
confidence is not evidence of believing, so without that condition every node with a low articulation alone
would land there and the label would stop distinguishing anything.

**It reuses the ranking's own reading of state** (`SETTLED_DIMENSIONS`, open conflicts) rather than defining
"understood" a second time. Two definitions would drift, and the panel would end up telling a learner their
understanding is ready while the cognitive signal was treating it as shaky. A test asserts the agreement.

The classification is coarse on purpose — four groups, not a score. The question is "what should I look at?",
and a ranked number would imply a precision that a reading of four settable dimensions does not have.

## Layout

| File                   | Contents                                                      |
| ---------------------- | ------------------------------------------------------------- |
| `src/cli.ts`           | the terminal surface, including the command table             |
| `src/server.ts`        | the HTTP surface and its JSON API                             |
| `src/serve.ts`         | starts the web surface and prints where it is                 |
| `src/seed.ts`          | the starting topic, so a learner does not face an empty graph |
| `public/index.html`    | the web interface: one file, no build step                    |
| `scripts/drive-ui.mjs` | drives the page over the DevTools protocol (see below)        |

`LearnSession` — open, ask, record, add a node, list, flush — is shared by both surfaces and lives in
[`@episteme/application`](../../packages/application/README.md), so that no surface depends on another.

## Two defects the surface found

Both were invisible to every existing test, because both are about _using_ the thing rather than about its
semantics.

**The evidence command was named `why`.** So `why is order hard for attention` — the most natural way
anyone would phrase that question — was parsed as the command plus an argument, and the question was
silently discarded. The command is now `explain`, and `RESERVED_WORDS` names the words that must never
become commands, with a test that asks every one of them as a question.

**Generated node ids were label slugs truncated mid-word**, producing
`node_0_self_attention_cannot_tell_which_word_ca`, which the learner was then asked to type to record their
understanding. Ids are now `claim_1`, `concept_3`, and references resolve by unambiguous prefix.

A third came from the Chinese work: **a Chinese question produced no semantic signal at all** (see
[Language](#language)), and Chinese particles like `的` and `是` initially became match terms — the same
failure as `"the"` and `"in"`, which surfaced as a hard negative outranking the expected node in four of six
evaluation cases.

## Why the answer text is Chinese and the code is not

`learnerResponder` in `@episteme/domain-learn` stays English, because that package's demos, tests and docs are
English. `packages/application/src/responder.ts` is the Chinese counterpart, and it reproduces the same **three
structural branches** rather than rewording the English ones:

| situation                           | what the answer does                                           |
| ----------------------------------- | -------------------------------------------------------------- |
| nothing recorded                    | establishes the ground — it cannot build on what is not there  |
| something recorded, nothing settled | asks the learner to commit to part of it                       |
| an unresolved conflict              | refuses to build on a position the learner marked as contested |
| settled understanding               | starts from it and skips the groundwork                        |

Keeping the structure identical is what makes the swap safe: a change that altered the branches would change
what the system is _willing to do_, not just what it says. A test asserts each branch.

## Verifying the interface

```bash
pnpm learn:web                                   # in one terminal
node apps/learn/scripts/drive-ui.mjs             # in another
```

The script drives the real page over the Chrome DevTools protocol — ask, record, ask again — and writes a
screenshot after each step. A screenshot of a static page proves it renders; it does not prove a learner can
use it. This does.

It is **re-runnable against the same graph**: it picks a level that is not already recorded, so each run
changes something and the before/after comparison always appears. That was a real defect — the first version
clicked a fixed level, so a second run recorded the same value, nothing changed, and step 06 reported zero
rows. That reads as a broken interface and is actually a no-op record.

It also selects buttons **structurally rather than by their text**, because the visible text is Simplified
Chinese; matching `'low'` against buttons labelled `低` found nothing and threw. A driver that asserts on
display strings tests the translation, not the interaction.

It does need a browser it can find: the script looks for Edge or Chrome in their standard Windows locations.

Otherwise the second `low` is not a change, and the comparison correctly does not appear — which looks like
a failure and is not.

## Deleting and recomputing

Nothing here is load-bearing except the JSONL file. Deleting it starts a fresh graph; the seeded topic is
re-added on the next open, and no understanding you recorded is recoverable — which is the correct
consequence of deleting the source of truth.
