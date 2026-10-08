# Running a validation session, and diagnosing what it shows

A real learner uses Episteme on a real topic, through the Episteme service, a Workspace and one or more
agents. This is how to turn what they report into a cause, and how to decide whether to change anything. It
exists so that diagnosis is a procedure rather than a guess, and so that the next architecture decision comes
from observed use.

What happened in each session is recorded in [human-validation-log.md](human-validation-log.md).

## Principles

These hold for every validation session, whatever phase the project is in.

- **Observe, diagnose, and fix only what the evidence shows.** A session is not a reason to add a feature or
  infrastructure. A fix starts from an observation, not from a prediction.
- **Keep the evidence from the moment it happened.** Re-running a question later runs it against a different
  graph, a different recency and possibly a different build. A result kept at the time is evidence; one
  reconstructed afterwards is not.
- **Attribute before tuning.** Never change the global retrieval weights before reading the signals behind a
  result. `recency` winning and `semantic` winning are different problems.
- **The semantic signal is gated per query, not per node.** When the question's strongest similarity is
  under `SEMANTIC_MATCH_THRESHOLD`, semantic is suppressed for every candidate. A missing semantic reason on
  one node therefore says something about the question, not only about that node.
- **A false positive in learner modelling is high severity.** Recording that a learner understands
  something they do not is worse than recording too little. Prefer conservative suggestions; the learner
  stays authoritative.
- **Record what was observed, not what was expected.** An entry in the log needs an observation from a real
  session. Anything noticed while reading code belongs in an issue.

## Before the session

Start the service on a graph of its own, so the session is not mixed into another graph or into the
demonstration topic. Keep it **outside the repository**: the graph and the files beside it hold the learner's
own words and understanding, and must never be committed.

```bash
pnpm serve --graph "$HOME/.episteme/validation/session-1.jsonl" --blank
```

Use `--topic ./their-material.json` instead of `--blank` when the learner brings a topic file. The root
`pnpm serve` serves the Learn page as the Workspace. The service prints where everything is:

```text
Workspace：http://127.0.0.1:4321/
MCP：      http://127.0.0.1:4321/mcp
REST API： http://127.0.0.1:4321/api/v1
图谱：     <home>/.episteme/validation/session-1.jsonl
```

Agents connect to the MCP address; the learner reviews in the Workspace. While the service runs it holds the
graph's lock, so the Learn terminal (`pnpm learn`) cannot open the same graph.

The service has no authentication. Any local process can reach it, including an agent with shell access, and
any such process can attempt a review decision. Note in the log which agents were connected and what they
could do; a decision the learner does not remember making is an observation.

## What the evidence is today

There is **no session log**. The service does not record the questions it was asked or what it returned. The
evidence that exists is what the service persists, and what the observer keeps at the time.

Persisted beside the graph, written only by the service:

| file                        | holds                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `<graph>`                   | nodes, edges and state events: the source of truth for the learner's understanding |
| `<graph>.suggestions.jsonl` | pending suggestions, and write-ahead records of decisions in progress              |
| `<graph>.sources.jsonl`     | material that was distilled, split into episodes                                   |

A suggestion that was accepted leaves its provenance (the suggestion, the proposing agent, the channel) on
what it committed. A suggestion that was dismissed leaves no record anywhere.

Read through the REST API, or through the same MCP tools an agent uses:

| question                                 | read                                                                |
| ---------------------------------------- | ------------------------------------------------------------------- |
| what did retrieval return, and why       | `POST /api/v1/recall` `{ "question": … }`, or the MCP `recall` tool |
| what does the graph hold                 | `GET /api/v1/state`                                                 |
| how did understanding of one node change | `GET /api/v1/nodes/<id>/history`                                    |
| what is waiting for the learner          | `GET /api/v1/suggestions`                                           |

A `recall` result carries `ranked`, every retrieved node with its `reasons` (each signal's `value`,
`weight`, `contribution` and `share` of the score), and `known`, what the learner has recorded about those
nodes. That is what an agent saw. **Keep it when it matters**: save the response to a file at the time,
together with the `epoch` and `revision` it was read at, rather than asking the same question again later.

For the questions that motivate a session:

| question                                             | answered by                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------ |
| Did it retrieve irrelevant understanding?            | the top `ranked` entries and their `reasons`                 |
| Did it miss understanding that should have mattered? | a **learner report**, then the steps under _False negatives_ |
| Was it overconfident about what the learner knew?    | the `known` array, and the history of each node in it        |
| Did an agent build on recorded understanding?        | what the agent recalled, and its answer, kept at the time    |

Whether the answer helped, and whether the learner recognised a suggestion as their own, need the learner,
not the files. Ask them.

## False negatives

When the learner says _"it should have found X"_:

1. Check that X exists in `GET /api/v1/state`. A draft or revoked node is never a retrieval candidate.
2. Ask the same question through `recall` and keep the result.
3. If X is absent, there are two possible causes, and **no surface on `main` can tell them apart**:
   - _below the relevance floor_: X was a candidate and its total score was under `DEFAULT_MIN_SCORE`. Both
     `retrieve()` and `explain()` skip such a candidate, so it appears in no result;
   - _not a candidate_: X never entered the candidate set, for example because of a filter.

   Record the observation with both causes open. A probe that lifts the floor for one node was built once and
   not merged (see V-003 in the log); it belongs to the retrieval-quality work.

4. Check the reasons of whatever ranked instead, with the per-query semantic gate in mind.

## False positives

A node that should not have ranked highly. **Do not touch the global weights first.** Read the `reasons` of
the winning entry and attribute the win:

```text
semantic    the question is genuinely close in meaning to it
lexical     it shares literal words with the question
graph       it is adjacent to something that matched
cognitive   the learner's own recorded state pulled it up (low confidence, open conflict)
recency     it is simply new
```

An irrelevant node winning on `recency` alone is a different problem from one winning on `semantic`, and only
the second is a retrieval-quality question. `cognitive` winning is usually _correct_, because that is what the
signal is for, so check whether the recorded state really was the learner's: read the node's history and the
provenance of the events that set it.

## Suggestions and decisions

Agents propose and the learner decides. For each suggestion that matters, record:

- what the agent proposed, and the rationale it gave;
- for distilled suggestions, the excerpt it came from, and whether the excerpt supports it;
- what the learner decided (accept, modify, dismiss), and why, in their words.

An accepted suggestion the learner later disowns is a false positive in learner modelling: high severity.

## Classifying what you find

```text
bug                     code does not do what it says
product-design problem  code works, the interaction is wrong
model/provider limit    the deterministic adapter, a real provider or a host model is the ceiling
retrieval-quality       ranking is wrong but the mechanism is sound
abstraction is wrong    evidence that an existing boundary should move
```

Prefer the smallest fix. An abstraction changing is an architecture decision and needs an ADR, not a patch.

## Fix policy

```text
reproduce
→ open an issue that links the log entry
→ add a regression test where appropriate
→ implement the smallest fix
→ run the project checks
→ re-test the original learner scenario
```

Do not refactor unrelated modules. Do not patch individual examples with hard-coded synonyms unless the patch
is clearly temporary and recorded as such in the log.

## After enough sessions

Write up what the sessions showed before deciding what to build next. The roadmap changes because of that
write-up, not because a session ended.
