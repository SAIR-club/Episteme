import { asId, type NodeId, type NodeTypeId } from '@episteme/core'
import { RuleBasedDistiller, distill } from '@episteme/distillation'
import { learnTags, learnStateDimensions } from '@episteme/domain-learn'
import { learnDistillationPolicy } from '@episteme/domain-learn/distillation'
import { describe, expect, it } from 'vitest'
import { createFixture } from './fixtures.js'

/**
 * The Learn scene's distillation policy (ADR 0009).
 *
 * What matters is that it agrees with the Learn pack itself: everything it lets distillation suggest must be
 * something a Learn graph would accept, so a learner who accepts a candidate is never refused for a reason
 * the policy could have known.
 */

const DIALOGUE = [
  '学生：为什么 Transformer 需要位置编码？',
  '老师：因为自注意力本身不区分词的顺序。例如把句子里的词打乱，注意力的输出只是跟着重新排列。',
  '学生：我明白了。那「旋转位置编码」呢？',
  '老师：它把位置编码成向量的旋转，所以相对位置会体现在点积里。',
  '学生：我还不太懂。',
].join('\n')

async function distilled() {
  return distill({
    material: { sourceId: 'src', text: DIALOGUE },
    agent: new RuleBasedDistiller({ policy: learnDistillationPolicy }),
    policy: learnDistillationPolicy,
    actorId: 'actor_human',
    known: [],
  })
}

describe('the Learn distillation policy', () => {
  it('suggests only nodes a Learn graph accepts as they are', async () => {
    const context = createFixture()
    const result = await distilled()
    const nodes = result.candidates.flatMap((candidate) =>
      candidate.status === 'suggested' && candidate.suggestion.kind === 'node'
        ? [{ ref: candidate.ref, node: candidate.suggestion }]
        : [],
    )
    expect(nodes.length).toBeGreaterThan(0)
    for (const { ref, node } of nodes) {
      const preview = context.graph.previewNode({
        id: asId<NodeId>(`n_${ref}`),
        type: asId<NodeTypeId>(node.nodeType),
        label: node.label,
        properties: node.properties ?? {},
        tags: learnTags('distilled'),
        tier: 'thought',
        source: 'distillation:src',
      })
      expect(preview.ok, `${ref} ${node.nodeType}: ${JSON.stringify(preview)}`).toBe(true)
    }
  })

  it('never distils a thought, which only the learner organises', async () => {
    const result = await distilled()
    expect(learnDistillationPolicy.nodeTypes.thought).toBeUndefined()
    expect(
      result.candidates.some(
        (candidate) =>
          candidate.suggestion.kind === 'node' && candidate.suggestion.nodeType === 'thought',
      ),
    ).toBe(false)
  })

  it('uses registered edge types, and the levels Learn registers for each dimension', () => {
    const context = createFixture()
    for (const edgeType of Object.values(learnDistillationPolicy.edgeTypes)) {
      expect(context.registries.edgeTypes.has(edgeType ?? '')).toBe(true)
    }
    for (const [dimension, levels] of Object.entries(learnDistillationPolicy.stateDimensions)) {
      const registered = learnStateDimensions.find((definition) => definition.id === dimension)
      expect(levels).toEqual(registered?.levels)
    }
  })

  it('suggests a learner’s change of state only within those levels', async () => {
    const result = await distilled()
    const states = result.candidates.flatMap((candidate) =>
      candidate.status === 'suggested' && candidate.suggestion.kind === 'state'
        ? Object.entries(candidate.suggestion.dimensions)
        : [],
    )
    expect(states.map(([dimension, value]) => `${dimension}=${value.level}`)).toEqual([
      'confidence=medium',
      'confidence=low',
    ])
  })
})
