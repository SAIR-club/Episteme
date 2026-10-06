# @episteme/application

The use-case layer: what a learner can do with their own graph, independent of the surface they do it from.

`LearnSession` opens a graph, answers a question from the retrieval it displays, records what the human now
understands, adds and links nodes, and summarises progress. The terminal and web surfaces in
[`apps/learn`](../../apps/learn/README.md) drive it, and so will the MCP endpoint described in
[ADR 0008](../../docs/decisions/0008-agent-plugin-surface.md).

It lives in a package rather than in an app so that no surface depends on another one. The MCP endpoint must
not look like it depends on the Learn web app, because it does not. Both depend on this.

The class keeps its name for now. It is Learn-shaped because Learn is the only scene, and renaming it before a
second scene exists would be an abstraction without a second case to fit.

## What it guarantees

- **One retrieval per answer.** The ranking a surface displays and the context the answer was built on come
  from the same call, so they cannot disagree.
- **Only the human records.** `record()` has no actor parameter. Every state event it commits is authored by
  the human, and Core's guards would refuse anything else.
- **Mutations are serialised.** Every method that changes the graph, the history or the drafts (`record`,
  `addNode`, `link`, `batch`, `propose`, `decide`, `flush`, `close`) runs in one queue per session, each
  after the one before it, including its write. Two decisions on one draft therefore cannot both commit:
  the first one queued wins, and the other finds the draft already decided. Reads are not queued. A closed
  session refuses every further change.
- **One owner.** A session owns its graph file from `open()` until `close()`, and a second session over the
  same file is refused with `GraphLockedError`.
- **An agent only proposes.** `propose()` keeps an agent's claim, link or state change as a pending draft in
  `<graph>.suggestions.jsonl`, beside the graph and outside it. It never changes the graph or the history.
  A proposal that could never be accepted is refused at once, as a value: unknown nodes, a link the graph's
  own preview rejects, or a dimension or level the learner could not record.
- **Only the human decides, through one path.** `decide()` is the single use case from a human decision to
  the graph, and every channel calls it: the Learn review queue and MCP elicitation. **Accept** commits the
  agent's value; a state change is `confirmed`, with `confirmedBy` set here to this session's human, never to
  a value a caller supplies. **Modify** commits the human's own value, of the same kind and under the same
  checks, as authored. **Dismiss** removes the draft and commits nothing. What is committed goes through the
  graph's validated path, and its source names the suggestion, the agent and the channel (ADR 0008).
- **A decision lands once, across a crash.** An accept or modify first writes a write-ahead record to the
  drafts file: an operation id and the ids it will create. Then it writes the graph, then removes the
  draft and the record in one write. Opening a session settles any record a crash left behind. The draft is
  completed if the graph holds the change, and rolled back to pending if not; `session.recovered` says
  which. Deciding a draft whose earlier attempt failed mid-write settles that attempt first, so a retry
  never commits twice.

## Distillation

`distill({ title, text })` turns learning material into pending suggestions ([ADR 0009](../../docs/decisions/0009-distillation.md)).
It changes no understanding.

- **The material** is kept in `<graph>.sources.jsonl`, beside the graph and outside it. That file has the same
  owner and the same atomic writes as the drafts, and `sources()` lists it.
- **Extraction.** The material is split into episodes and read by a distiller, the rule-based one unless
  another `CognitiveAgent` is given. What the distiller finds is checked against the domain's policy,
  `learnDistillationPolicy` unless another is given. Each kept candidate then goes through the checks
  `propose` applies.
- **Each suggestion carries its `origin`**: source, episode, character span, excerpt, time. It also records
  who proposed it (`actor_agent_<distiller>`) and the client that asked (`requestedBy`, provenance only).
- **References within a batch.** A suggestion found together with a node, such as a claim answering a
  question or a change in how sure the learner is about it, names that node as `cand:<suggestion id>`. It can
  be accepted only after that node is: before that, `depends_on_pending`; if the node was dismissed,
  `unresolved_candidate`.
- **An accepted node** records `suggestion` (the id it came from) and `origin` among its properties.
- **Bounded.** Material over `MAX_MATERIAL` characters, or a queue already holding `MAX_PENDING`
  suggestions, is refused as a value before anything is kept.

## Layout

| File                 | Contents                                                                      |
| -------------------- | ----------------------------------------------------------------------------- |
| `src/session.ts`     | `LearnSession`, the recordable dimensions, and the view types surfaces render |
| `src/responder.ts`   | the Chinese answer templates the session's scripted agent uses                |
| `src/sources.ts`     | `SourceStore`: distilled material, kept outside the graph                     |
| `src/suggestions.ts` | `SuggestionStore` and the `Proposal` kinds an agent can make                  |
