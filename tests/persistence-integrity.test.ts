import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  asId,
  contextSummary,
  retrieveRelevantContext,
  type ActorId,
  type DimensionId,
  type EdgeId,
  type EventId,
  type NodeId,
} from '@episteme/core'
import { MockCognitiveAgent } from '@episteme/agent'
import { LocalStorageAdapter, openLocalStorage } from '@episteme/storage-local'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DIMENSION,
  EDGE,
  NODE,
  askIn,
  dimensions,
  learnerResponder,
  learnTags,
  level,
  openEpisteme,
  type EpistemeContext,
} from './fixtures.js'

/**
 * What must survive a restart, and what must not leak across one.
 *
 * The restart test proves the loop; this suite pins down each integrity property separately, so a
 * regression names which guarantee broke rather than only that the loop stopped working.
 */
const CLAIM_ID = asId<NodeId>('claim_order')
const OTHER_CLAIM_ID = asId<NodeId>('claim_rope')
const CLAIM_TEXT = 'Self-attention alone does not encode sequence order.'
const QUESTION = 'Then why does RoPE work?'

function seed(context: EpistemeContext): void {
  const concept = (id: string, label: string, topic: string) =>
    context.graph.addNode({
      id: asId<NodeId>(id),
      type: NODE.concept,
      label,
      properties: { text: label },
      tags: learnTags(topic),
      tier: 'reference',
      source: 'reference:x',
    })

  concept('c_transformer', 'Transformer', 'transformer')
  concept('c_self_attention', 'Self-Attention', 'transformer')
  concept('c_rope', 'RoPE', 'rope')

  context.graph.addNode({
    id: CLAIM_ID,
    type: NODE.claim,
    label: CLAIM_TEXT,
    properties: { text: CLAIM_TEXT },
    tags: [...learnTags('transformer'), 'topic:rope'],
    tier: 'thought',
    source: 'session:1',
  })
  context.graph.addNode({
    id: OTHER_CLAIM_ID,
    type: NODE.claim,
    label: 'RoPE injects relative position.',
    properties: { text: 'RoPE injects relative position.' },
    tags: learnTags('rope'),
    tier: 'thought',
    source: 'session:1',
  })
  context.graph.addEdge({
    id: asId<EdgeId>('e1'),
    type: EDGE.refersTo,
    from: CLAIM_ID,
    to: asId<NodeId>('c_self_attention'),
  })
}

describe('recovery integrity', () => {
  let directory: string
  let filePath: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'episteme-integrity-'))
    filePath = join(directory, 'graph.jsonl')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('preserves event order and branch ancestry', async () => {
    const storageA = await openLocalStorage(filePath)
    const session1 = await openEpisteme(storageA)
    seed(session1)

    const first = session1.log.commit({
      target: CLAIM_ID,
      actorId: session1.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('medium')]),
      reason: 'first pass',
    })
    const second = session1.log.commit({
      target: CLAIM_ID,
      actorId: session1.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('high')]),
      reason: 'second pass',
    })
    const forked = session1.log.fork({
      from: second.id,
      target: CLAIM_ID,
      actorId: session1.humanId,
      dimensions: dimensions([DIMENSION.conflict, level('open')]),
      reason: 'another direction',
    })

    const orderBefore = session1.log
      .history({ target: CLAIM_ID, actorId: session1.humanId })
      .map((e) => e.id)
    const ancestryBefore = session1.log.branchAncestry(forked.branch.id)
    await session1.log.persist()
    await storageA.save()
    // A restart means the first owner is gone before the second opens the file.
    await storageA.close()

    const session2 = await openEpisteme(await openLocalStorage(filePath))

    // Commit order is part of the history, not an accident of storage.
    expect(
      session2.log.history({ target: CLAIM_ID, actorId: session2.humanId }).map((e) => e.id),
    ).toEqual(orderBefore)
    // Lineage survives: a fork still knows which branch it came from and where it split.
    expect(session2.log.branchAncestry(forked.branch.id)).toEqual(ancestryBefore)
    const reloadedBranch = session2.log.getBranch(forked.branch.id)
    expect(reloadedBranch?.parentBranchId).toBe(session1.log.defaultBranchId)
    expect(reloadedBranch?.forkPoint).toBe(second.id)
    expect(session2.log.getEvent(first.id)?.reason).toBe('first pass')
  })

  it('keeps a retracted event historically present, and still out of the current state', async () => {
    const storageA = await openLocalStorage(filePath)
    const session1 = await openEpisteme(storageA)
    seed(session1)

    const kept = session1.log.commit({
      target: CLAIM_ID,
      actorId: session1.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('low')]),
    })
    const retracted = session1.log.commit({
      target: CLAIM_ID,
      actorId: session1.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('high')]),
    })
    session1.log.revokeStateEvent(retracted.id, { reason: 'overstated' })
    const visibleBefore = session1.log.history({ target: CLAIM_ID, actorId: session1.humanId })
    await session1.log.persist()
    await storageA.save()
    // A restart means the first owner is gone before the second opens the file.
    await storageA.close()

    const session2 = await openEpisteme(await openLocalStorage(filePath))

    // The retraction is data, so it survives: the event is still readable...
    expect(session2.log.getEvent(retracted.id)).toEqual(retracted)
    expect(session2.log.isRevoked(retracted.id)).toBe(true)
    expect(session2.log.revocationOf(retracted.id)?.reason).toBe('overstated')
    // ...and still has no effect on what the learner currently understands.
    expect(
      session2.log.stateOf(CLAIM_ID, session2.humanId).get(asId<DimensionId>('confidence')),
    ).toEqual({ level: 'low' })
    expect(
      session2.log.history({ target: CLAIM_ID, actorId: session2.humanId }).map((e) => e.id),
    ).toEqual(visibleBefore.map((e) => e.id))
    expect(
      session2.log
        .history({ target: CLAIM_ID, actorId: session2.humanId, includeRevoked: true })
        .map((e) => e.id),
    ).toEqual([kept.id, retracted.id])
  })

  it('preserves actor isolation and shared concepts', async () => {
    const storageA = await openLocalStorage(filePath)
    const session1 = await openEpisteme(storageA)
    seed(session1)

    session1.log.commit({
      target: CLAIM_ID,
      actorId: session1.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('high')]),
    })
    session1.log.commit({
      target: CLAIM_ID,
      actorId: session1.agentId,
      dimensions: dimensions([DIMENSION.confidence, level('low')]),
    })
    await session1.log.persist()
    await storageA.save()
    // A restart means the first owner is gone before the second opens the file.
    await storageA.close()

    const session2 = await openEpisteme(await openLocalStorage(filePath))

    // One shared claim, two independent understandings.
    expect(
      session2.log.stateOf(CLAIM_ID, session2.humanId).get(asId<DimensionId>('confidence')),
    ).toEqual({ level: 'high' })
    expect(
      session2.log.stateOf(CLAIM_ID, session2.agentId).get(asId<DimensionId>('confidence')),
    ).toEqual({ level: 'low' })
    // A concept belongs to nobody, so it is still one node after reload.
    expect(session2.graph.getNode('c_self_attention')?.actorId).toBe(session1.humanId)
    expect(session2.graph.findNodes({ type: NODE.concept })).toHaveLength(3)
  })

  it('reduces to the same state after reload, and retrieves an equivalent context', async () => {
    const storageA = await openLocalStorage(filePath)
    const session1 = await openEpisteme(storageA)
    seed(session1)

    session1.log.commit({
      target: CLAIM_ID,
      actorId: session1.humanId,
      dimensions: dimensions(
        [DIMENSION.confidence, level('high')],
        [DIMENSION.articulation, level('medium')],
        [DIMENSION.evidence, level('reproduced')],
      ),
    })
    session1.log.commit({
      target: asId<NodeId>('c_rope'),
      actorId: session1.humanId,
      dimensions: dimensions([DIMENSION.exposure, level('studied')]),
    })

    const stateBefore = [...session1.log.stateOf(CLAIM_ID, session1.humanId).entries()]
    const contextBefore = await retrieveRelevantContext(session1.graph, session1.log, QUESTION, {
      actorId: session1.humanId,
      depth: 1,
    })
    await session1.log.persist()
    await storageA.save()
    // A restart means the first owner is gone before the second opens the file.
    await storageA.close()

    const session2 = await openEpisteme(await openLocalStorage(filePath))
    const stateAfter = [...session2.log.stateOf(CLAIM_ID, session2.humanId).entries()]
    const contextAfter = await retrieveRelevantContext(session2.graph, session2.log, QUESTION, {
      actorId: session2.humanId,
      depth: 1,
    })

    expect(stateAfter).toEqual(stateBefore)
    // Retrieval equivalence: same nodes, same order, same joined state. Order matters because
    // ranking is deterministic, so a reordering would be a real behaviour change.
    expect(contextAfter.nodes.map((n) => n.id)).toEqual(contextBefore.nodes.map((n) => n.id))
    expect(contextAfter.summary).toBe(contextBefore.summary)
    expect(contextAfter.known).toEqual(contextBefore.known)
    expect(contextSummary(contextAfter)).toBe(contextSummary(contextBefore))
  })

  it('gives the same answer to the same question after reload as before shutdown', async () => {
    const storageA = await openLocalStorage(filePath)
    const session1 = await openEpisteme(storageA)
    seed(session1)
    session1.log.commit({
      target: CLAIM_ID,
      actorId: session1.humanId,
      dimensions: dimensions(
        [DIMENSION.confidence, level('high')],
        [DIMENSION.articulation, level('medium')],
      ),
    })
    await session1.log.persist()
    await storageA.save()
    // A restart means the first owner is gone before the second opens the file.
    await storageA.close()

    const cold = await askIn(
      session1,
      new MockCognitiveAgent({ responder: learnerResponder }),
      QUESTION,
    )
    const session2 = await openEpisteme(await openLocalStorage(filePath))
    const warm = await askIn(
      session2,
      new MockCognitiveAgent({ responder: learnerResponder }),
      QUESTION,
    )

    expect(warm.response.text).toBe(cold.response.text)
    expect(warm.response.usedContext).toBe(true)
  })

  it('fails loudly on a truncated file instead of reporting a shorter history', async () => {
    const storageA = await openLocalStorage(filePath)
    const session1 = await openEpisteme(storageA)
    seed(session1)
    session1.log.commit({
      target: CLAIM_ID,
      actorId: session1.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('high')]),
    })
    await session1.log.persist()
    await storageA.save()
    // A restart means the first owner is gone before the second opens the file.
    await storageA.close()

    // Simulate a crash that left a half-written final line.
    const contents = await readFile(filePath, 'utf8')
    const truncated = `${contents.split('\n').slice(0, -2).join('\n')}\n{"schemaVersion":1,"kind":"ev`
    await writeFile(filePath, truncated, 'utf8')

    await expect(openLocalStorage(filePath)).rejects.toThrow(/not valid JSON/)
  })

  it('refuses to be used before it is opened', () => {
    const storage = new LocalStorageAdapter(filePath)
    expect(() => storage.putNode({ id: asId<NodeId>('x') } as never)).toThrow(/before open/)
  })

  it('treats a missing file as an empty history rather than an error', async () => {
    const storage = await openLocalStorage(join(directory, 'does-not-exist.jsonl'))
    expect(storage.listNodes()).toHaveLength(0)
    // And its event log is reported absent, so a fresh history is started rather than restored.
    const session = await openEpisteme(storage)
    expect(session.log.eventCount).toBe(0)
    expect(session.log.getBranch(session.log.defaultBranchId)).toBeDefined()
  })

  it('keeps a second actor\u2019s branch and events apart from the first after reload', async () => {
    const storageA = await openLocalStorage(filePath)
    const session1 = await openEpisteme(storageA)
    seed(session1)

    const humanEvent = session1.log.commit({
      target: CLAIM_ID,
      actorId: session1.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('high')]),
    })
    const agentEvent = session1.log.commit({
      target: OTHER_CLAIM_ID,
      actorId: session1.agentId,
      dimensions: dimensions([DIMENSION.confidence, level('low')]),
    })
    await session1.log.persist()
    await storageA.save()
    // A restart means the first owner is gone before the second opens the file.
    await storageA.close()

    const session2 = await openEpisteme(await openLocalStorage(filePath))
    const humanBranch = session2.log.getEvent(humanEvent.id)?.branchId
    const agentBranch = session2.log.getEvent(agentEvent.id)?.branchId

    expect(humanBranch).toBeDefined()
    expect(agentBranch).toBeDefined()
    expect(humanBranch).not.toBe(agentBranch)
    // Each actor's line of inquiry is their own, and each is read per subject: a branch holds
    // events for every node its actor reasoned about.
    expect(session2.log.tips(session2.humanId, CLAIM_ID).map((e) => e.id)).toEqual([humanEvent.id])
    expect(session2.log.tips(session2.agentId, OTHER_CLAIM_ID).map((e) => e.id)).toEqual([
      agentEvent.id,
    ])
    expect(session2.log.tips(session2.humanId, OTHER_CLAIM_ID)).toHaveLength(0)
    // An id from the other actor's path is still not a valid fork point.
    expect(() =>
      session2.log.fork({
        from: humanEvent.id,
        target: CLAIM_ID,
        actorId: asId<ActorId>('actor_agent'),
        dimensions: dimensions([DIMENSION.conflict, level('open')]),
      }),
    ).toThrow(/another actor/)
    expect(session2.log.getEvent(asId<EventId>(humanEvent.id))).toBeDefined()
  })
})
