import {
  asId,
  contextSummary,
  retrieveRelevantContext,
  toAgentContext,
  type ActorId,
  type EdgeId,
  type NodeId,
} from '@episteme/core'
import { MockCognitiveAgent, type AgentResponse } from '@episteme/agent'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DIMENSION,
  EDGE,
  NODE,
  createFixture,
  dimensions,
  learnerResponder,
  learnTags,
  level,
  type EpistemeContext,
} from './fixtures.js'

/**
 * The mechanism proof for v0.
 *
 * The whole project rests on one claim: that a later interaction changes *because* prior
 * understanding was stored. This test isolates that claim as tightly as it can — one graph,
 * one agent, one code path, and only one difference between the two runs, which is whether a
 * state event had been recorded.
 *
 * A real language model could pass a weaker version of this test by accident, which is why
 * the agent is a mock that answers from the context it was handed: any difference in the
 * answer is attributable to the context and nothing else.
 */

const QUESTION = 'Then why does RoPE work?'
const CLAIM_ID = asId<NodeId>('claim_order')
const CLAIM_LABEL = 'Self-attention alone does not encode sequence order.'

function seedGraph(context: EpistemeContext): void {
  const concept = (id: string, label: string, topic: string) =>
    context.graph.addNode({
      id: asId<NodeId>(id),
      type: NODE.concept,
      label,
      properties: { text: label },
      tags: learnTags(topic),
      tier: 'reference',
      source: 'reference:transformer',
    })

  concept('c_transformer', 'Transformer', 'transformer')
  concept('c_self_attention', 'Self-Attention', 'transformer')
  concept('c_positional_encoding', 'Positional Encoding', 'transformer')
  concept('c_permutation_invariance', 'Permutation Invariance', 'transformer')
  concept('c_rope', 'RoPE', 'rope')

  context.graph.addNode({
    id: CLAIM_ID,
    type: NODE.claim,
    label: CLAIM_LABEL,
    properties: { text: CLAIM_LABEL },
    // RoPE exists to answer exactly the limitation this claim states, so the claim sits under
    // both topics. Retrieval here is neighbourhood-based, not semantic: a question about RoPE
    // reaches the prior understanding through a shared topic, not by guessing at similarity.
    tags: [...learnTags('transformer'), 'topic:rope'],
    tier: 'thought',
    source: 'session:1',
  })

  context.graph.addEdge({
    id: asId<EdgeId>('e_claim_refers_attention'),
    type: EDGE.refersTo,
    from: CLAIM_ID,
    to: asId<NodeId>('c_self_attention'),
  })
  context.graph.addEdge({
    id: asId<EdgeId>('e_rope_refers_invariance'),
    type: EDGE.refersTo,
    from: asId<NodeId>('c_rope'),
    to: asId<NodeId>('c_permutation_invariance'),
  })
}

/** One question, answered with whatever the graph currently knows about this learner. */
async function ask(
  context: EpistemeContext,
  agent: MockCognitiveAgent,
  question: string,
  actorId: ActorId,
): Promise<{
  response: AgentResponse
  summary: string
  display: string
  matchedNodeIds: string[]
}> {
  const retrieved = await retrieveRelevantContext(context.graph, context.log, question, {
    actorId,
    depth: 1,
  })
  const response = await agent.respond({ text: question }, toAgentContext(retrieved))
  return {
    response,
    summary: retrieved.summary,
    display: contextSummary(retrieved),
    matchedNodeIds: retrieved.nodes.map((node) => node.id),
  }
}

describe('critical loop: a later interaction changes because understanding was stored', () => {
  let context: EpistemeContext
  let agent: MockCognitiveAgent

  beforeEach(() => {
    context = createFixture()
    seedGraph(context)
    agent = new MockCognitiveAgent({ responder: learnerResponder })
  })

  it('answers differently after a state event is recorded, with nothing else changed', async () => {
    // ── First interaction: the agent has no recorded understanding to work from ──
    const before = await ask(context, agent, QUESTION, context.humanId)
    expect(before.response.usedContext).toBe(false)
    // "Nothing recorded" is empty *as data*; only the display form says so in words.
    expect(before.summary).toBe('')
    expect(before.display).toBe('nothing is recorded about this yet')

    // ── The user explores, and their understanding is recorded ──
    context.log.commit({
      target: CLAIM_ID,
      actorId: context.humanId,
      dimensions: dimensions(
        [DIMENSION.confidence, level('high')],
        [DIMENSION.articulation, level('medium')],
      ),
      reason: 'derived why attention cannot encode order on its own',
      source: 'session:1',
    })

    // ── Second interaction: same question, same agent, same code ──
    const after = await ask(context, agent, QUESTION, context.humanId)

    // The retrieval found the stored understanding rather than the whole graph.
    expect(after.matchedNodeIds).toContain(CLAIM_ID)
    expect(after.summary).toContain(CLAIM_LABEL)
    expect(after.summary).toContain('confidence=high')

    // And the answer is different, in a way that is about data rather than wording.
    expect(after.response.usedContext).toBe(true)
    expect(after.response.text).not.toBe(before.response.text)
  })

  it('carries the stored understanding into the response rather than a bare flag', async () => {
    context.log.commit({
      target: CLAIM_ID,
      actorId: context.humanId,
      dimensions: dimensions(
        [DIMENSION.confidence, level('high')],
        [DIMENSION.articulation, level('medium')],
      ),
      source: 'session:1',
    })

    const { response, summary } = await ask(context, agent, QUESTION, context.humanId)

    // The response names the understanding it started from, so the difference is inspectable
    // by a human and not only by an assertion.
    expect(response.contextSummary).toBe(summary)
    expect(response.text).toContain(CLAIM_LABEL)
    expect(response.text).toContain('without re-deriving the groundwork')
  })

  it('refuses to build on a position the learner has marked as contested', async () => {
    context.log.commit({
      target: CLAIM_ID,
      actorId: context.humanId,
      dimensions: dimensions(
        [DIMENSION.confidence, level('high')],
        [DIMENSION.conflict, level('open')],
      ),
      source: 'session:1',
    })

    const { response } = await ask(context, agent, QUESTION, context.humanId)

    expect(response.usedContext).toBe(true)
    expect(response.text).toContain('unresolved conflict')
    // Building on it as settled is exactly what must not happen.
    expect(response.text).not.toContain('without re-deriving the groundwork')
  })

  it('lets the same question produce different answers for two different learners', async () => {
    context.log.commit({
      target: CLAIM_ID,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('high')]),
      source: 'session:1',
    })

    const human = await ask(context, agent, QUESTION, context.humanId)
    const agentActor = await ask(context, agent, QUESTION, context.agentId)

    // The graph is shared; the understanding is not.
    expect(human.response.usedContext).toBe(true)
    expect(agentActor.response.usedContext).toBe(false)
    expect(agentActor.summary).toBe('')
    expect(agentActor.display).toBe('nothing is recorded about this yet')
  })

  it('records what the agent was actually told, so the claim is auditable', async () => {
    await ask(context, agent, QUESTION, context.humanId)

    const [invocation] = agent.invocations
    expect(invocation?.capability).toBe('respond')
    expect(invocation?.input.text).toBe(QUESTION)
    expect(invocation?.context.summary).toBe('')
  })
})
