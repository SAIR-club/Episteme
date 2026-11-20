# 0021 — A turn says which credential wrote it

Status: **accepted** (2026-11-04). Adds to [ADR 0015](0015-threads-and-scene-records.md) (threads and turns) and
[ADR 0019](0019-host-driven-learning.md) (the host teaches). Follows [ADR 0012](0012-human-review-security.md) (who a
caller is comes from the credential).

## Context

A real host records everything a learner says with `thread_append`, so `speaker: learner` from an agent is the normal
path, not an abuse. Those turns can then back learning evidence (`host-learning.ts` checks that the quote is in a
learner turn, not who wrote the turn).

The record did not hold up afterwards:

- Over MCP, `by` named the agent. Over REST with an agent token, `by` was the person's own id, against ADR 0015's "the
  agent that relayed the turn, or the person".
- A turn the person typed and a turn an agent sent over REST were identical.

A relayed or invented sentence could therefore look like the person's own when they review what it supports. It cannot
become confirmed understanding by itself, because a candidate still waits for them.

## Decision

**A turn keeps the kind of credential it arrived with, and relayed words stay usable as evidence, marked as relayed.
The person judges them.**

1. `Turn` gains an optional `writtenWith: 'person' | 'agent'`, set by the service from the credential and never from a
   request body or tool argument.

   | How the turn arrives                              | `writtenWith` | `by`                 |
   | ------------------------------------------------- | ------------- | -------------------- |
   | a workbench route that takes only the person's credential | `person`      | the person           |
   | REST with the person's token                      | `person`      | the person           |
   | REST with an agent token                          | `agent`       | the agent, from its label |
   | MCP, with any token or none                       | `agent`       | the agent            |
   | REST with no credential, on one machine           | absent        | the person           |

2. MCP counts as a relay even with the person's own token: a host is still writing what it says the person said.
3. Absent means unknown, not the person. Turns from before this ADR have no field, and neither do requests with no
   credential. Nothing back-fills them, because a guess here would be the same mistake this decision removes. Older
   turns whose `by` is an agent are already known to be relayed.
4. The review surfaces show the difference: "Agent 转述" for a relay and "来源未记录" for unknown. The conversation,
   the candidate, the held item and its trail, and what came of a session all read it from the turn the words lie in. A
   host's own `basis: stated` has no such turn on record, so it reads as a relay: the host is who says the words are the
   person's.
5. Relayed turns can still be evidence. Refusing them would leave the host-driven loop with none.

## Consequences

- The field is additive, so `THREADS_SCHEMA_VERSION` stays 1. Older builds ignore it, and exports carry it.
- `by` over REST with an agent token now names the agent. Nothing decides anything from `by`; ownership comes from the
  thread.
- This records how words arrived, not whether they are true. An agent can still misquote; a same-user agent that uses
  the person's token (ADR 0012) reads as the person.
- Older graphs show "来源未记录" on most learner turns, including ones the person really typed.
