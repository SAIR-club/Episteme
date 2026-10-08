# Applications

Two exist: `apps/service`, the Episteme service that owns a graph and serves MCP and REST
([ADR 0010](../docs/decisions/0010-episteme-service.md)), and `apps/learn`, the Learn terminal and the page
the service serves as a Workspace. The rest of this file records the intended application surfaces, so the
layer boundary is visible.

Applications are where product decisions live: UI, interaction flows, ranking, feeds,
notifications, quizzes — anything whose value depends on one particular product rather than on the
graph itself. Nothing here may be a prerequisite for the others, and none of it may be needed by
Core to run its tests.

A planned application is a **view**, never a store. `Episteme Learn` and `Episteme Forum` both read
the same `Episteme Graph` through projections; if either needs its own database, the domain
boundary has been drawn in the wrong place.

## apps/learn — Episteme Learn

The Learner View answers one question:

> How do I currently understand this field?

— not "which chapters does this course have?". It should be able to show `Concept`, `Claim`,
`Question`, `Evidence`, `State`, `Conflict`, `History` and `Branch` for a topic. Ideally:

```text
Positional Encoding

├── Why is it necessary?
│
├── Self-Attention
│   └── permutation invariance
│
├── Sinusoidal PE
│
└── RoPE
```

That structure is not a syllabus written in advance by a teacher. It is the cognitive structure the
learner's own exploration produced, which is why `project()` returns `seeds` and `expanded`
separately — the view can distinguish "you asked about this" from "this turned out to be connected".

## apps/forum — Episteme Forum

The Discussion View over the same graph, focused on how thinking was produced, forked, corrected and
combined rather than on a post count. See
[`packages/domain-forum`](../../packages/domain-forum/README.md) for the structure it must express.

## What is deliberately missing

There is no application shell, framework or build tooling here, on purpose. Phase 0's goal is to
verify the cognitive loop with no frontend, no model and no database; that is what
`examples/learn-session` and `tests/northstar.test.ts` demonstrate. Choosing a frontend stack before
the loop is proven would be a guess about the thing that matters least right now.

## Prerequisites before implementing

- Phase 0 complete: the loop in the [README](../../README.md) verified end to end.
- A decision on frontend stack, recorded as an ADR — it is a replaceable choice, so it should be made
  deliberately rather than by default.
- `@episteme/sdk`, so an application does not wire Core together by hand.
