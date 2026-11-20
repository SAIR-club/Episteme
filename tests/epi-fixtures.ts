import { CognitiveSession, applicationPackDefinitions } from '@episteme/application'
import {
  asId,
  createFixedClock,
  defineDomainPack,
  type ActorId,
  type DimensionId,
  type EdgeTypeId,
  type NodeId,
  type StateValue,
} from '@episteme/core'
import { openEpisteme } from '@episteme/sdk'
import { openSqliteStorage } from '@episteme/storage-sqlite'
import { expect } from 'vitest'
import { TEST_PACK_VOCABULARY } from './fixtures.js'
import { testScene } from './test-scene.js'

/**
 * A real piece of learning, with a genuine conflict in it: attention needs position information, and
 * NoPE models — which drop positional encodings and still work — say otherwise. Nothing here is
 * pre-filled: every node, edge and event goes through the session's ordinary paths.
 */
export const NOW = () => new Date(0)
export const BUILD = 'test-build'
export const PACKS = [
  { name: 'episteme-application', definitions: applicationPackDefinitions },
  { name: 'test-pack', definitions: TEST_PACK_VOCABULARY },
]
export const HUMAN = 'actor_human'

/** Runs `refuse` and returns the error it threw, so a test can assert on its code and message. */
export function refusalOf(refuse: () => unknown): {
  readonly code?: string
  readonly message?: string
} {
  try {
    refuse()
  } catch (error) {
    return error as { readonly code?: string; readonly message?: string }
  }
  throw new Error('expected a refusal')
}

/** Builds the learning fixture into `graph`, optionally publishing the positional-encoding claim. */
export async function learningGraph(
  graph: string,
  options: { readonly publish?: boolean } = {},
): Promise<void> {
  const session = await CognitiveSession.open({ filePath: graph, sharing: true, scene: testScene })
  try {
    await session.addNode({
      id: 'c_transformer',
      label: 'Transformer',
      kind: 'concept',
      topic: 'transformer',
    })
    await session.addNode({
      id: 'k_position',
      label: 'Attention needs position information',
      kind: 'claim',
      topic: 'transformer',
    })
    await session.addNode({
      id: 'q_position',
      label: 'Why does attention need position information?',
      kind: 'question',
      topic: 'transformer',
    })
    await session.link('k_position', 'q_position', asId<EdgeTypeId>('answers'))
    await session.link('k_position', 'c_transformer', asId<EdgeTypeId>('refers_to'))
    await session.record('k_position', { confidence: 'medium' }, { reason: 'first reading' })
    await session.record(
      'k_position',
      { confidence: 'high' },
      { reason: 'worked the rope example by hand' },
    )
    await session.addNode({
      id: 'k_nope',
      label: 'NoPE models drop positional encodings and still work',
      kind: 'claim',
      topic: 'transformer',
    })
    await session.link('k_nope', 'k_position', asId<EdgeTypeId>('contradicts'))
    await session.record('k_position', { conflict: 'open' }, { reason: 'the NoPE result' })
    if (options.publish === true) {
      const published = await session.publish({
        root: 'k_position',
        include: ['q_position', 'c_transformer'],
      })
      expect(published.ok).toBe(true)
    }
  } finally {
    await session.close()
  }
}

/** Forks one line of inquiry and retracts a recorded change, through Core's own paths. */
export async function forkAndRevoke(graph: string): Promise<void> {
  const storage = await openSqliteStorage(graph)
  try {
    const episteme = await openEpisteme(storage, {
      packs: PACKS.map((pack) => defineDomainPack(pack.name, pack.definitions)),
      clock: createFixedClock(0),
    })
    const lineage = episteme.log.history({
      target: asId<NodeId>('k_position'),
      actorId: asId<ActorId>(HUMAN),
    })
    expect(lineage.length).toBe(3)
    // A divergent reading, cut from the first event: "I used to understand it this way, then I went
    // two different directions" stays expressible, and the fork inherits nothing recorded after it.
    const forked = episteme.log.fork({
      from: lineage[0]!.id,
      target: asId<NodeId>('k_position'),
      actorId: asId<ActorId>(HUMAN),
      dimensions: new Map([
        [asId<DimensionId>('confidence'), { level: 'low' } satisfies StateValue],
      ]),
      reason: 'the NoPE result made me doubt the rope example',
    })
    expect(forked.branch.parentBranchId).toBeDefined()
    // The 'high' reading is retracted: the event stays readable, its effect leaves the reduction.
    const revocation = episteme.log.revokeStateEvent(lineage[1]!.id, {
      reason: 'the example was wrong',
    })
    expect(revocation.eventId).toBe(lineage[1]!.id)
    await episteme.persist()
  } finally {
    await storage.close()
  }
}
