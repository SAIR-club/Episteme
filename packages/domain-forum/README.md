# @episteme/domain-forum — placeholder

Not implemented. This directory records the intended shape of the Forum domain pack so the
boundary is visible; it contains no code and is not a workspace package yet.

Episteme Forum is a _view_ over the shared graph, not a separate store. It must not become
`Post → Reply → Reply → Reply`. The structure it needs to express is how a thought came about,
where it diverged and how it was synthesised:

```text
Question

Thought v1
   ↓ evolves

Thought v2
   ├── fork → Thought v2'
   │
   └── evolves → Thought v3

          ↓

      Synthesis
```

The asset of a forum is therefore not the number of posts but how thinking was produced, forked,
corrected and combined.

## What this pack is expected to register

- **Node types** — reusing `concept`, `question`, `claim`, `thought` and `synthesis` from the
  shared ontology rather than defining parallel ones, plus anything the discussion scene needs
  that Core does not have (`discussion` as a container, if it proves necessary).
- **Edge types** — the epistemic relations Core already declares (`supports`, `contradicts`,
  `synthesizes`, `evolves_to`, `forks_from`) should carry most of the weight. This pack exists to
  add only what is genuinely specific to discussion.
- **Guards** — the cross-application rules of the scene. A contribution must be attributable, and
  a synthesis must name what it synthesises.
- **Projection rules** — a `Discussion View` scoped by scene, topic and depth, and a
  `learn → forum` projection that lets a thought written while learning be contributed without
  conversion.

## The shared-node requirement

These two moves are the reason the layers exist, and both must work without any conversion step:

- In a discussion, a user sees `Thought: "Self-attention is permutation equivariant."` and chooses
  **Add to my graph**, producing a claim scoped to them with a `state: exploring` tag and
  `source: forum/thought_xxx`.
- While learning, a user forms a thought and chooses **Contribute to discussion**, which makes it
  a thought in the forum.

Both are the same underlying object. If either needs a copy or a translation, the domain boundary
has been drawn in the wrong place.

## Prerequisites before implementing

- ADR 0001 — the Core boundary this pack depends on.
- The `learn` pack, as the reference implementation of a pack.
- An access/policy layer, since discussion content is contributed rather than private by default.

See the [architecture overview](../../docs/architecture/overview.md).
