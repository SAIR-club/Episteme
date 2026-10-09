# @episteme/agent

The cognitive agent interface, plus a scripted mock. **AI suggests; the human confirms.**

Episteme ships no model of its own: an agent host supplies it ([ADR 0008](../../docs/decisions/0008-agent-plugin-surface.md)),
and a host's reading of material enters through the host reader of `@episteme/distillation`
([ADR 0011](../../docs/decisions/0011-host-assisted-distillation.md)). The mock stays because the loop's proofs
need an agent that is held constant: an agent that could not be held constant would make the
project's central claim — "the response changed _because_ of stored understanding" — impossible to
verify. The mock answers from the workspace it is handed, so a test can vary only the history and
attribute any difference in the answer to it. That is Test C in
[`tests/northstar.test.ts`](../../tests/northstar.test.ts).

## The boundary

An agent receives an `AgentWorkspace` — a projection plus the actor's current state, keyed per node —
never the raw store. It may:

- ask questions;
- offer counterexamples;
- suggest connections;
- suggest claims, concepts and edges;
- suggest state changes;
- suggest syntheses;
- recommend the next step of exploration.

Everything it infers is `suggested` and requires human confirmation before it becomes the user's own
cognitive state. An agent may **not** write to the graph directly, and may never decide which side of
a conflict is right. This is the project's most important principle and it is expressed in the type
rather than in documentation:

```ts
interface CognitiveAgent {
  readonly id: string
  readonly description: string
  suggestStructure(workspace: AgentWorkspace): Promise<readonly Suggestion[]>
  suggestStateChange(workspace: AgentWorkspace): Promise<readonly Suggestion[]>
  suggestConnections(workspace: AgentWorkspace): Promise<readonly Suggestion[]>
}
```

Note what is absent: there is no `commit`, no `write`, no `resolveConflict`. An agent produces
`Suggestion`s and stops.

Workspace state is keyed `${node.label}#${dimension}` on purpose: an agent must not be able to match
one node's state against another's, and a reviewer must be able to see which node a suggestion was
conditioned on.

## The confirmation shape

A suggestion an agent makes is exactly what the human sees:

```text
Agent:
"You may not fully understand permutation invariance."

Evidence:
- contradiction in a previous answer
- repeated question

Actions: [Accept] [Modify] [Ignore] [View Evidence]
```

`AgentSuggestion` carries `status` and an optional `refusal`. A proposal that validation rejects keeps
its refusal rather than disappearing, so the human can see what was proposed and why it was not
accepted — `graph.previewNode` and `previewEdge` return a `MutationRefusal` as a value for exactly
this flow.

## Usage

```ts
import { MockCognitiveAgent } from '@episteme/agent'

const agent = new MockCognitiveAgent({
  script: [
    {
      // Fires only when the workspace carries this state; rules are checked in order.
      forState: { 'Some claim.#confidence': { level: 'high' } },
      suggestions: [/* ... */],
    },
  ],
  fallback: { suggestStateChange: [/* ... */] },
})

const suggestions = await agent.suggestStateChange(workspace)
agent.lastWorkspace // the workspace it was actually handed, for assertions
```

## Deferred

- a real model provider (`Adapters` layer, behind this same interface);
- persisting suggestions and their outcomes;
- an embedding/search adapter for finding relevant history, which is how a later interaction would
  retrieve the state it should be conditioned on at scale.
