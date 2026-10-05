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
- **Writes are ordered.** `flush()` serialises persistence behind one chain, so concurrent callers in one
  process cannot interleave a read of the log with a partial write.

## Layout

| File               | Contents                                                                      |
| ------------------ | ----------------------------------------------------------------------------- |
| `src/session.ts`   | `LearnSession`, the recordable dimensions, and the view types surfaces render |
| `src/responder.ts` | the Chinese answer templates the session's scripted agent uses                |
