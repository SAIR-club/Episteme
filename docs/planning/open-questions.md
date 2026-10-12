# Open questions

Questions that are still undecided or unverified. When one is answered, move it to
[`decision-log.md`](decision-log.md) with its source and remove it here. Known bugs and limitations
with a tracking issue belong in the issue tracker, not here.

## Unverified assumptions behind v0.1.0

Each is answered by the real learning loop in [`current-plan.md`](current-plan.md), not in advance.

| question                                                                                            | source                                                             |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Can Claude Code connect to the service over Streamable HTTP and see the tools?                      | [current-plan](current-plan.md#尚未验证的关键假设), assumption 1   |
| Is the proposing agent identified (`actor_agent_claude-code`, not `actor_agent_unidentified`)?      | [current-plan](current-plan.md#尚未验证的关键假设), assumption 2   |
| Can a real model quote verbatim, with an acceptable rejection rate?                                 | current-plan, assumption 3; [ADR 0011](../decisions/0011-host-assisted-distillation.md) |
| Does the model label only the learner's own words as `stated`?                                      | current-plan, assumption 4                                         |
| Is the review cost acceptable to a learner?                                                         | current-plan, assumption 5                                         |
| Does a fresh session recall confirmed understanding and build on it (gate C)?                       | current-plan, assumption 6                                         |
| Is the deterministic embedding adapter good enough for real phrasing?                               | current-plan, assumption 7; [retrieval](../architecture/retrieval.md) |

## Product direction

| question                                                                                                                         | source                                     |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| How does the knowledge-network MVP relate to the real-learner validation that current-plan puts first? Before it, after it, or as its replacement? | [vision](vision.md#product-direction), [current-plan](current-plan.md) |
| What makes a piece of cognitive work "good" enough to surface to others, given that a `reference` is verified but not absolute truth? | [vision](vision.md#product-direction)       |
| What does browsing someone else's understanding read: their claims and history only, or their state too, given "private by default"? | [AGENTS.md invariants](../../AGENTS.md#project-invariants) |

## Design questions

| question                                                                                                  | source                                                                |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| May "modify" change a proposal's target, endpoints or dimension, or only its value?                       | [roadmap: Hardening backlog](roadmap.md#hardening-backlog)            |
| Is one Learn vocabulary pack enough for the questions agents bring, or do the tools need a scene parameter? | [roadmap: Phase 3](roadmap.md#phase-3--episteme-as-an-mcp-host-implemented) |
| Which agent may recall what (Cognitive Access Control / Scoped Recall)?                                   | [roadmap: Phase 4](roadmap.md#phase-4--privacy-before-other-peoples-understanding-arrives) |
| How are embeddings handled as personal data when a remote provider is used?                               | [roadmap: Phase 4](roadmap.md#phase-4--privacy-before-other-peoples-understanding-arrives) |
