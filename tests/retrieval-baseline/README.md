# Hybrid retrieval baseline (#72)

The fixture has 24 concepts and claims, 11 edges, and 37 hand-labelled queries
about machine learning, databases, and networking. It covers direct lookups,
two-character Chinese terms, paraphrases, mixed Chinese/English, one-hop graph
neighbours, and questions with no relevant node. Grade 2 is a direct answer,
grade 1 is useful context, and unlisted nodes have grade 0.

The test runs the in-memory hybrid retriever with deterministic embeddings through
`retrieveWith`, the entry point used by `recall`. It reads the scored order at
depth 1 with a limit of 10. The fixture uses deterministic creation times and
has no recorded learner state. Ranking metrics are macro-averaged over the 33
answerable queries. Recall and MRR count both positive grades, MRR uses the
first relevant node in the returned list, and nDCG@10 uses gains of 3 and 1.
The four no-answer queries report empty responses and total results separately.

| Query group | Queries | Recall@1 | Recall@3 | Recall@5 | Recall@10 | MRR | nDCG@10 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| All answerable | 33 | 0.475 | 0.750 | 0.773 | 0.773 | 0.768 | 0.732 |
| Direct | 8 | 0.729 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
| Two-character Chinese | 7 | 0.512 | 0.643 | 0.714 | 0.714 | 0.714 | 0.662 |
| Paraphrase | 8 | 0.188 | 0.313 | 0.313 | 0.313 | 0.292 | 0.267 |
| Mixed Chinese/English | 7 | 0.464 | 0.964 | 1.000 | 1.000 | 1.000 | 0.971 |
| Graph neighbour | 3 | 0.500 | 1.000 | 1.000 | 1.000 | 1.000 | 0.864 |

| Warm latency samples | p50 | p95 | Empty no-answer responses | Results across no-answer queries |
| ---: | ---: | ---: | ---: | ---: |
| 555 | 0.995 ms | 1.441 ms | 0/4 | 9 |

Paraphrases are the weakest group. Five of eight retrieve no relevant node,
and the compound-index paraphrase finds only the related general index node.
Two-character Chinese is the next weakest group. `日志` misses WAL and recovery,
and `过期` misses DNS TTL and HTTP caching. Each no-answer query returns the
newest node, and the iPhone query returns five additional
irrelevant nodes. The fixed-frequencies query reaches positional encoding at
rank 2 through its edge to the sinusoidal encoding claim.

## Regenerate

```sh
pnpm exec tsc -b
EPISTEME_WRITE_BASELINE=1 pnpm exec vitest run tests/retrieval-baseline.test.ts
```

In PowerShell, set `$env:EPISTEME_WRITE_BASELINE = '1'` before running Vitest and
clear it afterwards with `Remove-Item Env:EPISTEME_WRITE_BASELINE`. Update the
tables from the generated `baseline.json` when refreshing the reference.

The test times one query at a time after three untimed passes, with 15 measured
passes and nearest-rank percentiles. Normal runs require ranking metrics to
hold overall and for each category, with no ranking tolerance. They also
require at least as many empty no-answer responses and at most as many results
across those queries. Latency is recorded but not compared by default, because
the baseline was measured on one machine and CI runners differ. Set
`EPISTEME_CHECK_LATENCY=1` to compare it on the same machine; each percentile may
then increase by the greater of 25% or 0.5 ms.
