# 0009 — Distillation: learning material in, suggestions out

Status: **accepted** (2026-10-06).

## Context

Until now, understanding entered the graph in two ways: the learner recorded it, or an agent proposed it one
suggestion at a time ([ADR 0008](0008-agent-plugin-surface.md)). Neither works for the most common thing a
learner has: a stretch of real material, such as a lesson, an explanation, or a conversation with a tutor,
that holds questions, claims, evidence and changes of mind all at once.

_Distillation_ turns such material into candidate understanding. The commitments it must keep are already
written down:

- **Draft → Thought → Reference.** Raw transcripts and generated content are drafts. They stay out of the graph
  until a human organises them. `Artifact` is described in the data model and was never registered, because
  nothing produced one.
- **AI is a scaffold, not the author.** Whatever is inferred is a suggestion. The human accepts, modifies or
  dismisses it through the one decision path of ADR 0008.
- **Core only does what the graph must do.** Extraction, segmentation and their policies are not graph
  primitives.

`CognitiveAgent` already declares `suggestStructure`, `suggestStateChange` and `suggestConnections`, but no
production code calls them, and their `AgentWorkspace` has no way to carry the material being read.

## Decision

**Distillation is a producer of suggestions. It never writes the graph.**

1. **Raw material stays outside the graph.** The material and its segmentation live in
   `<graph>.sources.jsonl` beside the graph. That file has the same single owner as the graph and is written
   atomically like the drafts file. Nothing from it becomes a node. A suggestion carries an **origin**
   (source id, episode id, character span, verbatim excerpt, and time when the material has timestamps). An
   accepted node keeps that origin among its properties, so what the learner kept can be traced back to the
   words it came from. `Artifact` stays unregistered.
2. **Segmentation is deterministic and domain-agnostic.** A dialogue is split into turns, and a question with
   the answer that follows becomes one learning episode. Prose is split into paragraphs. `[mm:ss]` timestamps
   become the episode's time range.
3. **Extraction reuses `CognitiveAgent`.** For each episode the engine calls `suggestStructure`, then
   `suggestConnections`, then `suggestStateChange`. The workspace gains three optional fields: the episode's
   `material`, the learner's `known` nodes, and this episode's `candidates`. A suggestion may name a candidate
   of the same run as `cand:<ref>`. The first extractor is a deterministic, rule-based agent with no model. It
   is replaceable, and a model-backed agent can later implement the same interface without changing the engine.
4. **Policy comes from the domain.** A `DistillationPolicy`, supplied by a Domain Pack, maps the engine's
   domain-neutral roles (concept, question, claim, evidence, thought) to registered node types, and its
   relations (about, answers, supports, contradicts) to registered edge types. It also says which state
   dimensions and levels may be proposed, how many candidates an episode may yield, and how to validate a
   candidate. A refused candidate keeps its refusal, as `AgentSuggestion` intends, rather than disappearing.
5. **Candidates become pending suggestions through the existing path.** Each kept candidate is proposed like
   any other suggestion and decided through `LearnSession.decide()`. A proposal may refer to another
   candidate of its run. Such a reference resolves only once that candidate has been accepted: the accepted
   node records which suggestion it came from. Until then, accepting the dependent suggestion is refused with
   `depends_on_pending`; if the referenced candidate was dismissed, with `unresolved_candidate`.
6. **Bounded.** Material length, candidates per episode, candidates per run and the number of pending
   suggestions all have limits. Going over a limit is a refusal returned as a value.

The entry points are the application (`session.distill`), the Learn web surface and an MCP `distill` tool.
The MCP tool runs Episteme's own extractor inside the host. It records the calling client as `requestedBy`,
for provenance only. Its results go to the review queue and are never put to the learner through
elicitation.

## Alternatives

**Register `Artifact` and store the material as a draft-tier node.** This would allow `derived_from` edges
inside the graph. Rejected because it brings raw material into the graph's history, which is what
Draft → Thought → Reference keeps out. An origin on each accepted node keeps the trace without that.

**A model-backed extractor first.** Better extraction. Rejected for the first version because results would
not be reproducible, tests could only use a mock, a dependency and a key would be needed, and the material
would leave the machine. The interface is kept, so this can be added later as a replacement.

**One suggestion per episode, accepted as a whole.** Simpler dependencies. Rejected because the learner would
have to accept everything an episode yielded or nothing. Per-candidate review, with explicit dependencies, keeps
each decision small.

**Let the agent of an MCP host do the extraction and `propose` the results.** This already works through
ADR 0008. It is not a replacement for distillation inside Episteme: it depends on what each host does, and the
extraction policy would then belong to no Domain Pack.

## Consequences

- A learner can bring real material and keep exactly the parts they recognise as their own understanding.
  Nothing is recorded until they decide.
- Accepted nodes carry structured provenance (`suggestion`, `origin`) in their properties. State events
  carry it through `sourceOf` and `reason`.
- A suggestion that depends on another cannot be accepted first. The review queue shows the dependency.
- The rule-based extractor is deliberately modest: it finds what its patterns find. Its value is that the loop
  can be exercised and tested end to end. Extraction quality is a later concern, behind the same interface.
- The sources file is new personal data, held in plain text like the graph. It falls under the encryption at
  rest work of Phase 4.
