import { asId, foldEvents, type DimensionId, type NodeId } from '@episteme/core'
import { MockCognitiveAgent, describeWorkspace } from '@episteme/agent'
import type { Suggestion } from '@episteme/agent'
import { describe, expect, it } from 'vitest'
import { DIMENSION, NODE, createFixture, dimensions, learnTags, level } from './fixtures.js'
import { buildWorkspace, runDemo, stateKey } from './northstar-demo.js'

/**
 * The three questions that decide whether this project is working.
 *
 *   A. Can the system express "I used to understand it this way, and now I understand it
 *      differently"?
 *   B. Can it express "from that same earlier understanding, I later took two different
 *      paths"?
 *   C. Can it make today's answer different *because* of how I understood before?
 *
 * If any of these is not a clear yes, the answer is to stop adding features, not to add
 * more of them. These tests are therefore the acceptance criteria for v0, and they are
 * deliberately written against the public surface rather than internals.
 */
describe('Test A: a change of understanding is expressible', () => {
  it('keeps both the old and the new understanding, and reports the new one as current', () => {
    const context = createFixture()
    const claimId = asId<NodeId>('claim-1')
    context.graph.addNode({
      id: claimId,
      type: NODE.claim,
      label: 'Self-attention does not encode sequence order itself.',
      properties: { text: 'Self-attention does not encode sequence order itself.' },
      tags: learnTags('transformer'),
      tier: 'thought',
      source: 'session:1',
    })

    const before = context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions(
        [DIMENSION.confidence, level('low')],
        [DIMENSION.evidence, level('none')],
      ),
      reason: 'first impression',
    })
    const after = context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions(
        [DIMENSION.confidence, level('high')],
        [DIMENSION.evidence, level('proven')],
      ),
      reason: 'worked through the proof',
    })

    // "Now" is the reduced history.
    const now = context.log.stateOf(claimId, context.humanId)
    expect(now.get(asId<DimensionId>('confidence'))).toEqual({ level: 'high' })

    // "Before" is still exactly readable, not an approximation of it.
    expect(foldEvents([before]).get(asId<DimensionId>('confidence'))).toEqual({ level: 'low' })
    expect(context.log.getEvent(before.id)?.reason).toBe('first impression')
    expect(
      context.log.history({ target: claimId, actorId: context.humanId }).map((e) => e.id),
    ).toEqual([before.id, after.id])
  })
})

describe('Test B: two paths from one understanding are expressible', () => {
  it('branches twice from the same point and keeps both paths open and traceable', () => {
    const context = createFixture()
    const claimId = asId<NodeId>('claim-1')
    context.graph.addNode({
      id: claimId,
      type: NODE.claim,
      label: 'Self-attention does not encode sequence order itself.',
      properties: { text: 'Self-attention does not encode sequence order itself.' },
      tags: learnTags('transformer'),
      tier: 'thought',
      source: 'session:1',
    })

    const origin = context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('low')]),
    })

    const pathA = context.log.fork({
      from: origin.id,
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('high')]),
      reason: 'path A',
    })
    const pathB = context.log.fork({
      from: origin.id,
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.conflict, level('open')]),
      reason: 'path B',
    })

    // Three open ends: the original understanding and both divergences from it. Reading them
    // per branch is what keeps "two paths from one understanding" from collapsing into one.
    const openEnds = context.log.tips(context.humanId)
    expect(openEnds.map((event) => event.id).sort()).toEqual(
      [origin.id, pathA.event.id, pathB.event.id].sort(),
    )

    // Both paths still name the same origin, and neither replaced it.
    expect(pathA.event.forkedFrom).toBe(origin.id)
    expect(pathB.event.forkedFrom).toBe(origin.id)
    expect(context.log.branchAncestry(pathA.branch.id)[0]).toBe(context.log.defaultBranchId)
    expect(context.log.branchAncestry(pathB.branch.id)[0]).toBe(context.log.defaultBranchId)
  })
})

describe('Test C: a later interaction changes because understanding was stored', () => {
  /**
   * One agent, one question, one code path. Only the workspace differs, and it differs only
   * because the graph remembered — so any change in the answer is attributable to the stored
   * understanding and nothing else.
   */
  it('produces a different recommendation once a prior state event exists', async () => {
    const context = createFixture()
    const claimId = asId<NodeId>('claim-1')
    context.graph.addNode({
      id: claimId,
      type: NODE.claim,
      label: 'Self-attention does not encode sequence order itself.',
      properties: { text: 'Self-attention does not encode sequence order itself.' },
      tags: learnTags('transformer'),
      tier: 'thought',
      source: 'session:1',
    })

    const suggestSettled: Suggestion = {
      kind: 'state',
      target: claimId,
      actorId: context.humanId,
      dimensions: { [DIMENSION.transfer]: { level: 'high' } },
      evidence: ['a prior high-confidence state event exists'],
      rationale: 'you already hold this with evidence, so try applying it somewhere new',
    }
    const suggestUnverified: Suggestion = {
      kind: 'state',
      target: claimId,
      actorId: context.humanId,
      dimensions: { [DIMENSION.confidence]: { level: 'low' } },
      evidence: [],
      rationale: 'nothing is recorded about this yet, so treat it as unverified',
    }

    const agent = new MockCognitiveAgent({
      script: [
        {
          // Workspace state is keyed per node, so a rule has to name the claim it conditions
          // on. That is deliberate: an agent must not match one node's state against another's.
          forState: {
            [stateKey(
              'Self-attention does not encode sequence order itself.',
              DIMENSION.confidence,
            )]: { level: 'high' },
          },
          suggestions: [suggestSettled],
        },
      ],
      fallback: { suggestStateChange: [suggestUnverified] },
    })

    // ── First interaction: the graph knows nothing yet ─────────────────────
    const emptyWorkspace = { actorId: context.humanId, nodeIds: [claimId], state: {} }
    const firstAnswer = await agent.suggestStateChange(emptyWorkspace)

    // ── The learner explores, and one state event is recorded ──────────────
    context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions(
        [DIMENSION.confidence, level('high')],
        [DIMENSION.evidence, level('proven')],
      ),
      reason: 'derived it',
    })

    // ── Second interaction: same agent, workspace now carries the history ──
    const workspace = buildWorkspace(context.graph, context.log, context.humanId, 'transformer')
    expect(describeWorkspace(workspace)).toContain('confidence=high')

    const secondAnswer = await agent.suggestStateChange(workspace)

    expect(firstAnswer[0]?.rationale).toBe(suggestUnverified.rationale)
    expect(secondAnswer[0]?.rationale).toBe(suggestSettled.rationale)
    expect(secondAnswer[0]?.rationale).not.toBe(firstAnswer[0]?.rationale)
  })

  it('recovers the stored state a later interaction depends on', async () => {
    const result = await runDemo()
    // The demo completes the whole loop — question, claim, refinement, fork, retraction and a
    // later answer that differs — without touching a database, a model or a frontend.
    expect(result.steps).toHaveLength(9)
    expect(result.finalState['confidence']).toBe('high')
    // The refinement is what currently stands; the open conflict lives on the other line.
    expect(result.finalState['conflict']).toBeUndefined()
    // The two interactions really did differ, and the difference is the point of the demo.
    expect(result.responseWithState.usedContext).toBe(true)
    expect(result.responseWithoutState.usedContext).toBe(false)
    expect(result.responseWithState.text).not.toBe(result.responseWithoutState.text)
  })
})
