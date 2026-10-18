# Decision log

One line per decision: what was decided, why, and where it came from. Newest first.

- Architecture decisions, meaning anything that touches Core's boundary, the event model or a
  [project invariant](../../AGENTS.md#project-invariants), get a full ADR in
  [`docs/decisions/`](../decisions/). The entry here links to it.
- Smaller decisions, such as scope, priority or process, are recorded only here. If one turns out
  to touch an invariant, write the ADR and link it.
- Source is where the decision was made: an ADR, an issue, a PR, or a discussion in
  [`docs/discussions/`](../discussions/index.md).
- An entry is never edited to change its meaning. A reversal is a new entry that names the one it
  supersedes.

| date       | decision                                                                                                                | why                                                                                     | source                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 2026-10-12 | Near-term MVP is a knowledge network for browsing and reusing good cognitive work; long-term, understanding is shared, confronted, forked and corrected across people | Make the graph useful beyond one learner, while Core stays general and Learner stays an application | Maintainer direction, [vision](vision.md#product-direction) |
| 2026-10-09 | Pause development after v0.1.0; the first step on resuming is one real learning loop with a real host and a real learner | Every claim so far is proven only with scripted clients                                  | [current-plan](current-plan.md)                                                    |
| 2026-10-08 | A host may submit its own reading; Episteme verifies every quote against the stored source before queueing               | Use the host's model without trusting its quotes                                         | [ADR 0011](../decisions/0011-host-assisted-distillation.md)                        |
| 2026-10-08 | The host becomes the Episteme service, which exclusively owns its storage; every surface goes through its API           | One owner per graph; Learn becomes one client among others                               | [ADR 0010](../decisions/0010-episteme-service.md)                                  |
| 2026-10-06 | Distillation only produces suggestions; raw material stays outside the graph                                            | Draft → Thought → Reference; nothing inferred enters the graph without a human decision | [ADR 0009](../decisions/0009-distillation.md)                                      |
| 2026-10-05 | Episteme is a plugin agents attach to over MCP; agents can only recall and propose                                      | Agents are plentiful; a durable record of a person's understanding is not                | [ADR 0008](../decisions/0008-agent-plugin-surface.md)                              |
| 2026-10-04 | Semantic retrieval is one weighted signal among five, behind the existing `Retriever` seam                              | Paraphrased questions must reach stored cognition without a vector database             | [ADR 0007](../decisions/0007-semantic-retrieval.md)                                |
| 2026-10-04 | Persist to one append-only JSONL file                                                                                   | Understanding must survive a restart; history is the source of truth                    | [ADR 0006](../decisions/0006-persistence-format.md)                                |
| 2026-10-03 | A branch is a line of inquiry with its own readable lineage                                                             | Gate B: two paths from the same earlier understanding                                   | [ADR 0005](../decisions/0005-fork-lineage.md)                                      |
| 2026-10-03 | Scenes are domain packs, the only sanctioned way to add vocabulary                                                      | Keep Core scene-independent                                                             | [ADR 0004](../decisions/0004-domain-extension-boundary.md)                         |
| 2026-10-03 | Storage is a port; enforcement stays in the graph layer                                                                 | One validation path; no adapter becomes a second authority                              | [ADR 0003](../decisions/0003-storage-abstraction.md)                               |
| 2026-10-03 | Understanding is an append-only log of state events; current state is derived                                           | "I used to think this, now I think that" must be readable back                          | [ADR 0002](../decisions/0002-event-sourced-cognitive-state.md)                     |
| 2026-10-03 | Core contains only graph primitives, in four one-directional layers                                                     | Serve many scenes without Core absorbing any one of them                                | [ADR 0001](../decisions/0001-core-boundary.md)                                     |
