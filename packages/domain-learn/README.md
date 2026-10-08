# @episteme/domain-learn

The **Learn** domain pack: the vocabulary and rules of the Learn scene, registered into Core without
changing it.

Learn is Episteme's first scene, not its ontology. Everything here is additive — the shared node
types (`concept`, `question`, `claim`) are the same objects the Forum scene will read, so a thought
written while learning can be contributed to a discussion without conversion.

## What it registers

**Node types** — `concept`, `question`, `claim`, `evidence`, `thought`, `synthesis`.

**Edge types** — the epistemic relations (`refers_to`, `answers`, `supports`, `contradicts`,
`prerequisite`, `synthesizes`, `derived_from`, `organized_from`, `exemplifies`) plus the structural
and provenance ones (`contains`, `authored_by`, `tagged_with`, `evolves_to`, `forks_from`, `same_as`).
Endpoint constraints are declared only where the constraint is genuinely part of the meaning.

**State dimensions** — the axes of understanding:

| Dimension      | Kind        | Levels                                           |
| -------------- | ----------- | ------------------------------------------------ |
| `exposure`     | ordinal     | `none`, `seen`, `studied`, `worked`              |
| `confidence`   | ordinal     | `low`, `medium`, `high`                          |
| `evidence`     | ordinal     | `none`, `anecdotal`, `reproduced`, `proven`      |
| `articulation` | ordinal     | `low`, `medium`, `high`                          |
| `transfer`     | ordinal     | `low`, `medium`, `high`                          |
| `conflict`     | ordinal     | `none`, `suspected`, `open`, `resolved`          |
| `source`       | categorical | `self`, `agent`, `paper`, `discussion`, `course` |

There is deliberately **no single `mastery` score**. A learner can be confident and unable to
articulate, or fluent and full of unresolved conflict, and collapsing that into one number would
destroy exactly the information the system exists to keep.

**Guards** — two rules, because anchoring is Learn's vocabulary and cannot live in Core:

- `learn/thought-requires-source` — a `thought` or `synthesis` must carry a source and at least one
  anchor. A `claim` deliberately does _not_: it is an assertion the learner holds, grounded later by
  `supports` and `contradicts` edges, so demanding an anchor up front would block the ordinary case of
  forming a position before finding evidence for it.
- `learn/anchors-must-exist` — every id in `anchors` must already exist. A node may anchor itself: a
  thought written directly is its own source of truth for the exploration.

## Usage

```ts
import { applyDomainPacks } from '@episteme/core'
import { learnDomainPack, NODE, EDGE, DIMENSION, learnTags } from '@episteme/domain-learn'

applyDomainPacks([learnDomainPack], { registries })

graph.addNode({
  id: asId<NodeId>('claim-1'),
  type: NODE.claim,
  label: 'Self-attention does not encode sequence order itself.',
  properties: { text: 'Self-attention does not encode sequence order itself.' },
  tags: learnTags('transformer'), // scene:learn, topic:transformer, state:active
  tier: 'thought',
  source: 'session:1',
})
```

`learnDomainPack` uses `registerIfAbsent` throughout, so a pack that shares this vocabulary — Forum,
for instance — composes with it rather than conflicting.

## Distillation policy

`@episteme/domain-learn/distillation` exports `learnDistillationPolicy`, which says what distillation may suggest
in the Learn scene ([ADR 0009](../../docs/decisions/0009-distillation.md)):

- concepts, questions, claims and evidence, as Learn's own node types;
- `refers_to`, `answers`, `supports` and `contradicts` between them;
- changes to `confidence` and `articulation`, with the levels this pack registers.

It never distils a `thought`. A thought is understanding the learner organised deliberately, so what material
yields stays a claim until the learner organises it. It is a subpath export, so the pack's main entry does not
depend on distillation.
