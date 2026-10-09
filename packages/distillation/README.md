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
- **Canonical text.** The material is read in canonical form (`canonicalText`: line breaks as `\n`, then
  Unicode NFC), and every span points into that text, in UTF-16 offsets. A caller stores that text, so a span
  never needs mapping back ([ADR 0011](../../docs/decisions/0011-host-assisted-distillation.md)).
- **Origin.** A candidate with a `quote` rests on exactly those words:
  - the engine finds them in the episode the suggestion names in `quoteAt`, or else in the one being read;
  - when the words occur there more than once, `quoteAt.occurrence` (1-based) says which;
  - words that cannot be located are refused, never widened to the episode, and leave no origin.

  Only a candidate with no quote rests on the whole episode. The origin carries the excerpt, the time range,
  and the `speaker` whose turn holds the words, when one does.

- **Basis.** Each candidate is `stated` or `inferred`.
  - `stated` means its quoted words lie in a turn whose speaker is the given `learner` (NFC, trimmed, exact; no
    case folding). It says the learner said those words. It does not say that the candidate is what they meant.
  - A reader that says `stated` of anything else is refused.
  - A reader that leaves the basis unset gets `stated` exactly when that holds, and `inferred` otherwise. This
    default is for the rule-based reader, whose candidates are the learner's sentences as written.
  - A reader that offers its own reading, such as a host's model, states the basis of every candidate.
  - Neither basis, nor the learner's acceptance, proves the learner has mastered anything.
- **Checks.** A candidate is refused, with a code, when:
  - its quote cannot be located (`quote_not_found`), occurs more than once with no occurrence named
    (`quote_ambiguous`), runs across two episodes (`quote_spans_episodes`), has fewer than 2 letters or
    digits (`quote_too_short`) or more than 1,000 characters (`quote_too_long`);
  - it says `stated` of words the learner did not say (`basis_mismatch`);
  - its type or relation is not in the policy (`not_allowed`);
  - it duplicates a candidate (`duplicate_candidate`) or something the learner already has (`already_known`,
    which names the `existingNodeId`: only a second node is refused, not the observation);
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
`contradicts`, `revises`) to registered edge types. It also lists the state dimensions and levels that may be suggested,
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

It quotes the sentence each candidate was found in and names which occurrence it is, so words said twice point
at the time they were said. A term with too few letters to rest on, such as a single character in 「」, is
quoted with the line it stands in. It sets no basis of its own; the engine marks it.

It finds what these patterns find. Its purpose is to make the loop real and testable; extraction quality
belongs to a model-backed agent behind the same interface.

## A host's reading

`prepareHostReading({ sourceId, text, items, policy, actorId })` takes what a host's model read
([ADR 0011](../../docs/decisions/0011-host-assisted-distillation.md)). It checks what can be checked before
reading:

- each item's shape;
- its basis, which is required, so there is no default for a host;
- its quote, located in the whole canonical text by the host's `occurrence`. That position is converted into
  the engine's own form, an episode and an occurrence within it;
- what each relation and state change depends on.

It returns those refusals, which carry no origin, and a `CognitiveAgent` that hands the rest to `distill`:

- each node in the episode its quote is in;
- each relation and state change in the latest of its quote's and its candidate ends' episodes.

A candidate end in an earlier episode is named through `workspace.candidates` by the reader's own name for it
(`localRef`), never by constructing an engine reference. The engine then locates every quote again and applies
the same policy and checks as for any reader. `hostRefusalOf` reports an engine refusal under the host's ref,
and as `depends_on_refused` when it names a node the engine refused.
