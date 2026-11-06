# Vision

Why Episteme exists, what it is for, and where its edges are. This file changes only when the
direction itself changes. What is being built now is MindLink, planned in its own repository
([SAIR-club/MindLink](https://github.com/SAIR-club/MindLink)).

## Purpose

> **Episteme turns inquiry into persistent, evolving understanding.**

Episteme is open cognitive infrastructure for carrying, organising and evolving _human
understanding_. The question it answers is not "how do we let an AI answer faster", but:

> How do we make the understanding produced while exploring a question, learning something,
> discussing it or researching it structured, kept, branched, corrected, compared and reused, so
> that it keeps shaping how people and AI interact later?

The most valuable asset is not chat history or course content. It is a **cognitive graph that keeps
evolving**: one graph that Learn, Forum and Research project views over.

Source: [`README.md`](../../README.md).

## Original intent

- **Understanding, not material.** A note, a knowledge base or a RAG index stores text that may be
  retrieved later. Episteme stores what a particular person has come to understand from it: units,
  relations, multi-dimensional state and history.
- **A layer agents attach to, not another agent.** Agents are plentiful. What none of them has is a
  durable, inspectable record of how _the person they are talking to_ understands something, one
  that survives the session, the tool and the model. The host agent supplies the model; Episteme
  supplies the understanding it should build on.
- **The person decides.** An agent may suggest; only the person's decision makes anything their
  understanding.

Sources: [`README.md`](../../README.md), [roadmap (archived): Positioning](https://github.com/SAIR-club/Episteme/blob/archive/docs-2026-10-19/docs/planning/roadmap.md#positioning-a-layer-agents-attach-to-not-another-agent),
[ADR 0008](../decisions/0008-agent-plugin-surface.md).

## Product direction

Set by the maintainer on 2026-10-12 (see [decision log](decision-log.md)).

- **Near-term MVP:** a knowledge network where people can browse and reuse good cognitive work: the
  questions, claims, evidence and revisions others arrived at, not only their final answers.
- **Long-term:** understanding from different people can be shared, confronted, forked and corrected, and
  keeps evolving together.
- **Architecture:** Episteme Core provides the general cognitive structure, event history and the
  primitives for collaborative evolution. Learner is an application on top of Core and does not rebuild what
  Core already provides. A working end-to-end scenario comes before new abstraction layers, and the design
  stays open to research, discussion and other scenes.

## The gate

Every phase must keep these three a clear **yes**. If one stops being a clear yes, the answer is to
stop adding features rather than add more of them.

- **A**: "I used to understand it this way, and now I understand it differently."
- **B**: "From that same earlier understanding, I later took two different paths."
- **C**: "Because I understood it this way before, today's answer is different."

Source: [roadmap (archived): The gate, unchanged](https://github.com/SAIR-club/Episteme/blob/archive/docs-2026-10-19/docs/planning/roadmap.md#the-gate-unchanged).

## Boundaries

What Episteme is not: a chat assistant, a knowledge base, a course generator or a forum. It ships no
model of its own.

Hard constraints are the project invariants in
[`AGENTS.md`](../../AGENTS.md#project-invariants). Changing one requires an ADR in
[`docs/decisions/`](../decisions/).

Explicitly out of scope for now, because scope creep is the main risk to this project:

```text
an agent of our own            multi-agent systems
recommendation engines         automatic curriculum generation
reputation ranking             leaderboards
semantic automatic merge       AI truth oracles
automatic knowledge-graph generation   federation
institutional deployment       payments
complex governance             educational-effect experiments
full Lean integration
```

Source: [roadmap (archived): Explicitly out of scope for now](https://github.com/SAIR-club/Episteme/blob/archive/docs-2026-10-19/docs/planning/roadmap.md#explicitly-out-of-scope-for-now).
