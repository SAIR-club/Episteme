# @episteme/distillation

Distillation turns learning material into candidate understanding, and produces suggestions only
([ADR 0009](../../docs/decisions/0009-distillation.md)). It never writes the graph: everything it finds is
proposed to the learner, who accepts, modifies or dismisses it.

It is domain-agnostic. It knows what a dialogue turn, a paragraph, a question and an example look like, and
nothing about any subject. What a candidate becomes in a given graph is up to a `DistillationPolicy` from a
Domain Pack.

## Segmentation

`segment(material)` splits material into **learning episodes**. It is deterministic.

- **Dialogue**: chosen when most non-empty lines are `speaker: utterance`, optionally preceded by `[mm:ss]` or
  `[hh:mm:ss]`. A question opens an episode. The turns that follow belong to it until the next question, and
  consecutive questions stay together. A line without a speaker continues the turn before it. Timestamps give
  each episode a time range, which runs to the start of the next episode.
- **Prose**: everything else, split into paragraphs at blank lines.

Every episode records its character span in the source, and its text is exactly the source between those
offsets. That is what lets a suggestion made from it point back at the words it came from.

## Distilling

`distill({ material, agent, policy, actorId, known })` runs the agent over each episode, in order:
`suggestStructure`, then `suggestConnections`, then `suggestStateChange`. The workspace carries the episode
(`material`), the learner's `known` nodes, and every candidate kept so far, so a later answer can connect to an
earlier question. It returns every candidate it found and **writes nothing**.

- **References.** A node the agent names `q1` in episode 2 becomes `e2.q1`. Other suggestions name it
  `cand:e2.q1`, and the engine rewrites the agent's local names to these.
- **Origin.** Each candidate's origin is the span of its `quote` in the source when the episode holds the
  quote, and the whole episode otherwise. The origin also carries the excerpt and the time range.
- **Checks.** A candidate is refused, with a code, when:
  - its type or relation is not in the policy (`not_allowed`);
  - it duplicates a candidate (`duplicate_candidate`) or something the learner already has (`already_known`);
  - an end is unknown (`unknown_endpoint`) or depends on a refused candidate (`depends_on_refused`);
  - a state change uses a dimension or a level the policy does not allow (`not_allowed`);
  - it is over the policy's limits (`over_limit`);
  - the policy's own `validate` refuses it.

  Refused candidates stay in the result.

- **Domain properties.** The policy's `propertiesFor(role, label)` fills in what a node of that role must
  carry in its domain, whichever agent suggested it.
- **State changes** are always about `actorId`, and always `authority: 'suggested'`.

## The policy

A `DistillationPolicy` comes from a Domain Pack. It maps the engine's roles (`concept`, `question`, `claim`,
`evidence`, `thought`) to registered node types, and its relations (`about`, `answers`, `supports`,
`contradicts`) to registered edge types. It also lists the state dimensions and levels that may be suggested,
and sets the limits per episode and per run. A role or relation the policy leaves out is never suggested.

## The rule-based distiller

`RuleBasedDistiller` is the first `CognitiveAgent` for distillation. It is deterministic, uses no model, and
works on Chinese and English:

| it finds                   | when                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| a question                 | a sentence ends with `?` or `？`                                                                                                            |
| evidence                   | a sentence offers an example, an experiment or a proof (例如、实验、for example)                                                            |
| a claim                    | a sentence gives a reason or a limit (因为、所以、无法、because, cannot)                                                                    |
| a concept                  | a term is set apart in 「」『』“”《》 and is not one the learner has                                                                        |
| answers / supports / about | a claim follows the episode's question; evidence follows its first claim; a label mentions a known node or a new concept                    |
| a possible change of state | the learner says 我明白了 / I see (confidence medium), 还不太懂 / I'm confused (low), or 我能讲给别人 / I can explain (articulation medium) |

It finds what these patterns find. Its purpose is to make the loop real and testable; extraction quality
belongs to a model-backed agent behind the same interface.
