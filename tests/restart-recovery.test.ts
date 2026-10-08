import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asId, type DimensionId, type EdgeId, type NodeId } from '@episteme/core'
import { DIMENSION, EDGE, NODE, learnerResponder, learnTags } from '@episteme/domain-learn'
import { MockCognitiveAgent } from '@episteme/agent'
import { LocalStorageAdapter, openLocalStorage } from '@episteme/storage-local'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dimensions, level, openEpisteme, askIn, type EpistemeContext } from './fixtures.js'

/**
 * The Phase 1 claim: a user's understanding survives process restart and still affects future
 * interaction.
 *
 * The two halves of this test never share memory. Session 1 writes through a `LocalStorageAdapter`
 * and is then dropped; the adapter that session 2 reads is a *second* object built from the same
 * file with an empty in-memory state and a fresh id counter. That is what makes this a restart test
 * rather than an in-process round trip: if persistence were accidental, or if any cognition lived
 * only in a variable, session 2 would come back empty.
 */

const QUESTION_FIRST = 'Why does Transformer need positional encoding?'
const QUESTION_AFTER = 'Then why does RoPE work?'
const CLAIM_ID = asId<NodeId>('claim_order')
const CLAIM_TEXT = 'Self-attention alone does not encode sequence order.'

/** Concepts are public and shared; none of them belongs to a learner. */
function seedConcepts(context: EpistemeContext): void {
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
  concept('c_rope', 'RoPE', 'rope')
}

/** Session 1: the learner asks, forms a claim, records it, and explores a second line. */
function runFirstSession(context: EpistemeContext): {
  claimEventId: string
  forkEventId: string
  forkBranchId: string
} {
  seedConcepts(context)

  context.graph.addNode({
    id: asId<NodeId>('q_positional'),
    type: NODE.question,
    label: QUESTION_FIRST,
    properties: { text: QUESTION_FIRST },
    tags: learnTags('transformer'),
    tier: 'thought',
    source: 'session:1',
  })

  context.graph.addNode({
    id: CLAIM_ID,
    type: NODE.claim,
    label: CLAIM_TEXT,
    properties: { text: CLAIM_TEXT },
    // Tagged under both topics so a later question about RoPE reaches it through the graph.
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

  const claim = context.log.commit({
    target: CLAIM_ID,
    actorId: context.humanId,
    dimensions: dimensions(
      [DIMENSION.confidence, level('high')],
      [DIMENSION.articulation, level('medium')],
      [DIMENSION.evidence, level('reproduced')],
    ),
    reason: 'derived why attention cannot represent order on its own',
    source: 'session:1',
  })

  // A second line of inquiry, forked from the claim's own event.
  const forked = context.log.fork({
    from: claim.id,
    target: CLAIM_ID,
    actorId: context.humanId,
    dimensions: dimensions([DIMENSION.conflict, level('open')]),
    reason: 'relative position may answer this without absolute indices',
    source: 'session:1',
  })

  return {
    claimEventId: claim.id,
    forkEventId: forked.event.id,
    forkBranchId: forked.branch.id,
  }
}

describe('restart recovery', () => {
  let directory: string
  let filePath: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'episteme-restart-'))
    filePath = join(directory, 'graph.jsonl')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('carries understanding across a restart and changes the next interaction', async () => {
    // 鈹€鈹€ Session 1 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    const storageA = await openLocalStorage(filePath)
    const session1 = await openEpisteme(storageA)
    expect(session1.log.eventCount).toBe(0)

    // Before anything is recorded, the agent has nothing to build on.
    const coldAgent = new MockCognitiveAgent({ responder: learnerResponder })
    const beforeAnyUnderstanding = await askIn(session1, coldAgent, QUESTION_AFTER)
    expect(beforeAnyUnderstanding.response.usedContext).toBe(false)
    expect(beforeAnyUnderstanding.summary).toBe('')

    const written = runFirstSession(session1)
    const stateBeforeShutdown = [...session1.log.stateOf(CLAIM_ID, session1.humanId).entries()]
    const historyBeforeShutdown = session1.log
      .history({ target: CLAIM_ID, actorId: session1.humanId })
      .map((event) => event.id)

    // The agent now answers from what was recorded, in the same process.
    const warmAgent = new MockCognitiveAgent({ responder: learnerResponder })
    const inProcess = await askIn(session1, warmAgent, QUESTION_AFTER)
    expect(inProcess.response.usedContext).toBe(true)

    await session1.log.persist()
    const writtenPath = await storageA.save()
    expect(writtenPath).toBeUndefined()
    // A restart means the first owner is gone before the second opens the file.
    await storageA.close()

    // 鈹€鈹€ Shutdown 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    // Nothing is shared with what follows: a second adapter reads the file from scratch.
    const storageB = new LocalStorageAdapter(filePath)
    const loaded = await storageB.open()

    expect(loaded.events.events.length).toBe(session1.log.eventCount)

    // 鈹€鈹€ Session 2: a new process, the same history 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    const session2 = await openEpisteme(storageB)

    // The understanding is back, derived from the reloaded events rather than a saved snapshot.
    const stateAfterRestart = [...session2.log.stateOf(CLAIM_ID, session2.humanId).entries()]
    expect(stateAfterRestart).toEqual(stateBeforeShutdown)
    expect(
      session2.log.history({ target: CLAIM_ID, actorId: session2.humanId }).map((e) => e.id),
    ).toEqual(historyBeforeShutdown)

    const reloadedAgent = new MockCognitiveAgent({ responder: learnerResponder })
    const afterRestart = await askIn(session2, reloadedAgent, QUESTION_AFTER)

    // The point of the whole phase: retrieval finds the prior understanding, and the answer differs.
    expect(afterRestart.response.usedContext).toBe(true)
    expect(afterRestart.summary).toContain(CLAIM_TEXT)
    expect(afterRestart.response.text).not.toBe(beforeAnyUnderstanding.response.text)
    expect(afterRestart.response.text).toBe(inProcess.response.text)
    expect(written.forkBranchId).toBeTypeOf('string')
  })

  it('does not collide on ids after reload, so history keeps distinct moments', async () => {
    const storageA = await openLocalStorage(filePath)
    const session1 = await openEpisteme(storageA)
    seedConcepts(session1)
    session1.graph.addNode({
      id: CLAIM_ID,
      type: NODE.claim,
      label: CLAIM_TEXT,
      properties: { text: CLAIM_TEXT },
      tags: learnTags('transformer'),
      tier: 'thought',
      source: 'session:1',
    })
    const first = session1.log.commit({
      target: CLAIM_ID,
      actorId: session1.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('medium')]),
    })
    await session1.log.persist()
    await storageA.save()
    // A restart means the first owner is gone before the second opens the file.
    await storageA.close()

    const storageB = await openLocalStorage(filePath)
    const session2 = await openEpisteme(storageB)

    // A fresh counter would hand out `evt_1` again and two different moments would share one id.
    const second = session2.log.commit({
      target: CLAIM_ID,
      actorId: session2.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('high')]),
    })

    expect(second.id).not.toBe(first.id)
    expect(session2.log.eventCount).toBe(2)
    expect(session2.log.getEvent(first.id)?.id).toBe(first.id)
  })

  it('keeps a learner who never persisted anything from seeing another file\u2019s cognition', async () => {
    const storageA = await openLocalStorage(filePath)
    const session1 = await openEpisteme(storageA)
    seedConcepts(session1)
    session1.graph.addNode({
      id: CLAIM_ID,
      type: NODE.claim,
      label: CLAIM_TEXT,
      properties: { text: CLAIM_TEXT },
      tags: learnTags('transformer'),
      tier: 'thought',
      source: 'session:1',
    })
    session1.log.commit({
      target: CLAIM_ID,
      actorId: session1.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('high')]),
    })
    await session1.log.persist()
    await storageA.save()
    // A restart means the first owner is gone before the second opens the file.
    await storageA.close()

    // A second, unrelated file must not inherit the first one's understanding.
    const otherPath = join(directory, 'other.jsonl')
    const storageOther = await openLocalStorage(otherPath)
    const other = await openEpisteme(storageOther)

    expect(other.log.eventCount).toBe(0)
    expect(other.log.stateOf(CLAIM_ID, other.humanId).size).toBe(0)

    // While the persisted file still has it, so the emptiness is isolation and not a failed read.
    const storageBack = await openLocalStorage(filePath)
    const back = await openEpisteme(storageBack)
    expect(back.log.eventCount).toBe(1)
    expect(back.log.stateOf(CLAIM_ID, back.humanId).get(asId<DimensionId>('confidence'))).toEqual({
      level: 'high',
    })
  })
})
