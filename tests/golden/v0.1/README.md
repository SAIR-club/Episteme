# Golden graph: v0.1.0

A graph written by the v0.1.0 session and its pack, kept so a refactor of the application can be checked
against it (ADR 0013, step M3). `tests/golden-graph.test.ts` lays the record bodies in these files into a graph file and compares what it
reads with `expected.json`.

It holds four seeded nodes, two edges, three recorded state events, a pending agent proposal, a distilled
reading with its source, and two events in legacy levels (`evidence: weak`, `transfer: near`). Those two were
appended by hand, because the current session refuses legacy levels for new input; they are what a graph
written before that refusal contains.

Do not regenerate these files to make a test pass. If the expected reading changes on purpose, say why in
the commit that changes `expected.json`.
