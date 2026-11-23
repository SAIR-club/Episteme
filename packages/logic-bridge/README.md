# @episteme/logic-bridge — placeholder

Not implemented. This directory records the intended shape of optional formalisation support; it
contains no code and is not a workspace package yet.

Formal verification is a **plugin, not a Core dependency**.

```text
Claim
  ↓ formally_expressible
formalizer
  ↓
Lean / Datalog / SMT
  ↓
verification result
  ↓
StateEvent
```

The output of formalisation is not a truth verdict that overwrites anything. It is a _state event_:
"this claim was mechanically checked, and here is the result and the artefact that produced it".
Everything the project already guarantees then applies unchanged — the event is append-only, it
belongs to an actor, it carries a source, and a contradiction it reveals is preserved rather than
resolved.

## The one hard constraint

**Do not let Lean — or any formal tool — block v0.** Adding a solver to the critical path would
make the project's actual question ("can understanding be tracked and reused?") depend on a
research-grade toolchain. Core must keep running and testing with no such dependency present,
which the current tests already demonstrate.

## Expected seam

This belongs in the Adapters layer, next to storage and model providers, behind an interface
declared by the layer above it. A `Claim` that is formally expressible is still a claim; the
bridge contributes an `Evidence` node and a `StateEvent`, never a new kind of truth.

A future pack would plausibly register:

- a state dimension such as `formal_status` (`not_expressed`, `expressed`, `verified`, `failed`);
- guards requiring a `derived_from` edge to the artefact that produced a verification result;
- projection rules that surface unverified formal claims.

## Prerequisites before implementing

- A stable Core with the Learn loop closed — the current Phase 0 goal.
- A decision on which tool first. Lean is the most expressive and the most expensive; Datalog is the
  likeliest place to start, since it can express many relational claims about a graph cheaply.
- An `Evidence` representation that can hold a machine-checkable artefact as a source.

See ADR 0001 for why this is not in Core.
