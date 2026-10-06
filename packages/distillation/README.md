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
