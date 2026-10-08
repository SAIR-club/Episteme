# Human validation log

A record of what real learners actually hit, so the next architecture decision comes from observed use rather
than roadmap momentum. How to run a session and diagnose it is in [diagnosis.md](diagnosis.md).

## What this file is not

- **Not a journal of speculation.** An entry requires an observation from a real session. Things noticed while
  reading code, or predicted to be problems, belong in an issue.
- **Not reasoning traces.** Entries record what happened, what was concluded, and what was done.
- **Not a bug tracker.** Only issues that shaped a decision or a fix. Routine breakage that a check catches
  belongs in the commit that fixed it.

## Status

**No learner session has been run or recorded.** The entries below are infrastructure observations, made
while building validation tooling, and none of them comes from a learner.

## Entry format

```text
Context              what the learner was doing
What they tried      the concrete action
Expected             what should have happened
Observed             what did happen
Severity             low | medium | high
Classification       one of the classes below
Root cause           why, once established
Action taken         the fix, or "none — recorded only"
General or           does the fix apply to every session, or was it specific to this one?
  session-specific
Status on main       what holds on main, with the commit it was checked against
```

## Classification vocabulary

```text
retrieval failure
wrong cognitive-state inference
bad state-suggestion timing
bad explanation
memory UX confusion
branch/fork confusion
language issue
agent prompt issue
persistence issue
UI friction
missing product capability
```

---

## Infrastructure observations (historical)

Recorded on 2026-10-04 while building validation tooling (a session log, a relevance-floor probe and an
injectable clock) in uncommitted work based on `4e8ceef`, before the Episteme service existed. **That tooling
was never merged.** Its code is kept as a backup outside the repository, and what happens to each part was
decided in [#14](https://github.com/SAIR-club/Episteme/issues/14): the session log and the probe are deferred,
the clock option is dropped.

So each _Action taken_ below describes that unmerged work, not `main`. Each entry ends with what holds on
`main`, checked against `c5ac754` on 2026-10-08. Nothing here has been re-run since.

### V-001 — the `clock` option did not reach retrieval

```text
Context              Writing a deterministic test for the relevance floor
What they tried      Open a session with an explicit fixed clock, create nodes, inspect a low-scoring node
Expected             Node and session times come from the supplied clock
Observed             Every node landed in the same millisecond, so recency tied and nothing was ever
                     "below the floor"
Severity             medium
Classification       persistence issue (test and diagnosis infrastructure)
Root cause           The session built a clock for its own log timestamps but passed the system clock to
                     composition, so node `createdAt`, which feeds the recency signal, never saw it.
Action taken         (unmerged) Forward `clock` into composition.
General              General: the option was silently inert for every caller.
Status on main       Does not apply. `LearnSession.open` has no `clock` option, and the option will not be
                     restored (#14).
```

### V-002 — a session record was written but not awaited

```text
Context              Adding the session log
What they tried      Ask a question, then read the log back
Expected             The question's record is on disk by the time `ask()` resolves
Observed             Often absent; the write raced the read
Severity             high for validation
Classification       persistence issue
Root cause           The log append was fired without being awaited, so a crash between the answer and the
                     write would lose exactly the observation under investigation.
Action taken         (unmerged) `ask`, `record` and `addNode` awaited the append. Write failures were still
                     swallowed so that a broken log could not break the session.
General              General.
Status on main       Does not apply: main has no session log (deferred, #14). Any observation log built later
                     must await its writes and must not swallow failures; the swallowing above is contrary to
                     the project's engineering rules.
```

### V-003 — a diagnosis could not see a node under the relevance floor

```text
Context              Preparing to diagnose false negatives
What they tried      Ask a question that should retrieve a specific node, then ask why that node is missing
Expected             Some way to learn why it did not appear
Observed             `retrieve()` and `explain()` both drop a candidate under the relevance floor, so the
                     node was absent from both, indistinguishable from a node that does not exist
Severity             high
Classification       retrieval failure (diagnosability)
Root cause           The floor is applied inside scoring, so a dropped candidate never reaches any result.
Action taken         (unmerged) `inspect(target)` re-ran the last question with `minScore: 0` and reported the
                     node's real score, every signal, its rank, and whether it was a candidate at all.
General              General.
Status on main       Still true. Scoring in `packages/domain-learn/src/retriever.ts` drops a candidate under
                     `query.minScore ?? DEFAULT_MIN_SCORE`, and no surface lifts it. The probe is deferred to
                     the retrieval-quality work (#14).
```

### V-004 — the semantic signal is gated per query, not per node

```text
Context              Writing an assertion that every signal appears on every candidate
What they tried      Inspect a node for a question unrelated to the graph
Expected             Five signals, several at zero
Observed             Only four: `semantic` was missing entirely
Severity             low as a defect, high as a trap
Classification       bad explanation
Root cause           When the query's strongest similarity is under `SEMANTIC_MATCH_THRESHOLD`, semantic is
                     suppressed for every node. Read per node, that looks like "this node scored low on
                     meaning" when it means "this question is not about anything in the graph".
Action taken         No behavioural change: the gating is intended. (unmerged) The probe reported whether
                     semantic applied to the query.
General              General.
Status on main       Still true: the gate is `semanticIsMeaningful` in the same file. A `recall` result does
                     not say whether semantic applied to the query, so a missing semantic reason is
                     ambiguous when read from the API.
```

### V-005 — the relevance-floor boundary produced an order-dependent test

```text
Context              Testing that a below-floor node is reported as such
What they tried      Build a graph, ask an unrelated question, assert some node falls under the floor
Expected             A stable assertion
Observed             Passed alone, failed in the suite
Severity             medium (test integrity)
Classification       retrieval failure (test)
Root cause           A node at full recency contributes exactly the floor, not less. On a graph written in one
                     millisecond every node tied at the floor, so whether any node was under it depended on
                     clock jitter.
Action taken         (unmerged) The test used a fixed clock and an explicitly older node, and a second test
                     pinned the boundary: a node scoring exactly the floor is returned.
General              General: the boundary is a property of the scoring model, not of the test.
Status on main       The boundary holds: the floor drops only `score < minScore`, and the default recency
                     weight equals `DEFAULT_MIN_SCORE` (both 0.05). The tests were not merged. A test that
                     depends on the floor must control time.
```

---

## Session observations

None yet. The first real learner session appends here.
