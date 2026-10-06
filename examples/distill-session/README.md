# @episteme/example-distill-session

Distillation end to end ([ADR 0009](../../docs/decisions/0009-distillation.md)): a real learning dialogue
becomes suggestions, the learner decides, and only what they decided reaches the graph.

```bash
pnpm demo:distill        # from the repo root
```

## What it shows

1. **Before**: two concepts the learner already has, and no recorded understanding.
2. **Distilled**: a six-turn tutoring dialogue becomes two episodes and sixteen suggestions. They cover
   questions, claims, an example, a term, how they relate (answers, supports, refers to), and two changes of
   understanding read from what the learner said ("我明白了", "我还不太懂"). Each suggestion shows the words it
   came from.
3. **Nothing is recorded yet.**
4. **The learner decides**:
   - accepting "the claim answers the question" before either exists is refused (`depends_on_pending`);
   - accepting the question and the claim, then the relation, works;
   - "you now understand it" is accepted;
   - the example is dismissed, so "the example supports the claim" is refused (`unresolved_candidate`);
   - one claim is put in the learner's own words.
5. **After a restart**: only the decided nodes, relations and changes are in the graph. Each node points back
   at its words, the change is `confirmed` by the learner, and the example was never recorded.

The distiller is rule-based and deterministic, so the output is the same on every run.
