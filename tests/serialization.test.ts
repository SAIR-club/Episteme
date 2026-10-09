import {
  asId,
  type ActorId,
  type BranchId,
  type EdgeId,
  type EdgeTypeId,
  type EventId,
  type NodeId,
} from '@episteme/core'
import {
  SERIALIZATION_SCHEMA_VERSION,
  deserializeRecord,
  serializeRecord,
  type PersistedRecord,
} from '@episteme/storage-local'
import { describe, expect, it } from 'vitest'
import { DIMENSION, NODE, learnTags } from './fixtures.js'
import { createFixture, dimensions, level } from './fixtures.js'

/**
 * The serialization contract.
 *
 * Persistence is only as trustworthy as the shape it writes, so the round trip is tested on its
 * own, without file I/O, for every record kind. A silent loss here would look like a learner who
 * never understood anything rather than like a broken file.
 */
describe('serialization contract', () => {
  function roundTrip(record: PersistedRecord): PersistedRecord {
    return deserializeRecord(serializeRecord(record), 1)
  }

  it('stamps every record with a schema version', () => {
    const context = createFixture()
    const node = context.graph.addNode({
      id: asId<NodeId>('c1'),
      type: NODE.concept,
      label: 'RoPE',
      properties: { text: 'RoPE' },
      tags: learnTags('rope'),
      tier: 'reference',
      source: 'reference:rope',
    })

    const record: PersistedRecord = {
      schemaVersion: SERIALIZATION_SCHEMA_VERSION,
      kind: 'node',
      node,
    }
    const line = serializeRecord(record)
    const parsed = JSON.parse(line) as { schemaVersion: number }
    expect(parsed.schemaVersion).toBe(1)
    expect(roundTrip(record)).toEqual(record)
  })

  it('preserves event dimensions, which a naive JSON write would silently drop', () => {
    const context = createFixture()
    const claimId = asId<NodeId>('claim-1')
    context.graph.addNode({
      id: claimId,
      type: NODE.claim,
      label: 'Order is not encoded by attention alone.',
      properties: { text: 'Order is not encoded by attention alone.' },
      tags: learnTags('transformer'),
      tier: 'thought',
      source: 'session:1',
    })

    const event = context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions(
        [DIMENSION.confidence, level('high')],
        [DIMENSION.evidence, level('reproduced')],
      ),
      reason: 'derived it',
      source: 'session:1',
    })

    const record: PersistedRecord = {
      schemaVersion: SERIALIZATION_SCHEMA_VERSION,
      kind: 'event',
      event: { ...event, dimensions: [...event.dimensions.entries()] },
    }
    const restored = roundTrip(record)
    expect(restored.kind).toBe('event')
    if (restored.kind !== 'event') throw new Error('expected an event record')

    // The dimensions are what make an event worth storing; `{}` here would be data loss that still
    // parses.
    expect(restored.event.dimensions).toEqual([
      [DIMENSION.confidence, { level: 'high' }],
      [DIMENSION.evidence, { level: 'reproduced' }],
    ])
    expect(restored.event.reason).toBe('derived it')
    expect(restored.event.source).toBe('session:1')
  })

  it('round-trips every kind without losing fields', () => {
    const context = createFixture()
    const node = context.graph.addNode({
      id: asId<NodeId>('c2'),
      type: NODE.concept,
      label: 'Self-Attention',
      properties: { text: 'Self-Attention' },
      tags: learnTags('transformer'),
      tier: 'reference',
      source: 'reference:x',
    })
    const edge = context.graph.addEdge({
      id: asId<EdgeId>('e1'),
      type: asId<EdgeTypeId>('refers_to'),
      from: node.id,
      to: node.id,
      source: 'session:1',
    })

    const records: readonly PersistedRecord[] = [
      { schemaVersion: SERIALIZATION_SCHEMA_VERSION, kind: 'node', node },
      { schemaVersion: SERIALIZATION_SCHEMA_VERSION, kind: 'edge', edge },
      {
        schemaVersion: SERIALIZATION_SCHEMA_VERSION,
        kind: 'branch',
        branch: {
          id: asId<BranchId>('br_1'),
          actorId: asId<ActorId>('actor_human'),
          forkPoint: asId<EventId>('evt_9'),
          createdAt: 5,
        },
      },
      {
        schemaVersion: SERIALIZATION_SCHEMA_VERSION,
        kind: 'revocation',
        revocation: { eventId: asId<EventId>('evt_3'), revokedAt: 7, reason: 'misrecorded' },
      },
    ]

    for (const record of records) {
      expect(roundTrip(record)).toEqual(record)
    }
  })

  it('omits absent optional fields instead of writing explicit undefined', () => {
    const context = createFixture()
    const node = context.graph.addNode({
      id: asId<NodeId>('c3'),
      type: NODE.concept,
      label: 'Positional Encoding',
      properties: { text: 'Positional Encoding' },
      tags: learnTags('transformer'),
      tier: 'reference',
      source: 'reference:x',
    })

    const line = serializeRecord({
      schemaVersion: SERIALIZATION_SCHEMA_VERSION,
      kind: 'node',
      node,
    })
    const parsed = JSON.parse(line) as { node: Record<string, unknown> }

    // A reader must be able to tell "not stated" from "stated as nothing".
    expect(Object.hasOwn(parsed.node, 'priority')).toBe(false)
    expect(Object.hasOwn(parsed.node, 'revoked')).toBe(false)
    expect(parsed.node['source']).toBe('reference:x')
  })

  it('refuses a record it cannot understand rather than guessing', () => {
    expect(() => deserializeRecord('not json at all', 4)).toThrow(/line 4 is not valid JSON/)
    expect(() => deserializeRecord('"a string"', 2)).toThrow(/line 2 is not an object/)
    expect(() => deserializeRecord(JSON.stringify({ schemaVersion: 99, kind: 'node' }), 7)).toThrow(
      /schema version 99/,
    )
    expect(() =>
      deserializeRecord(JSON.stringify({ schemaVersion: 1, kind: 'mystery' }), 9),
    ).toThrow(/unknown kind "mystery"/)
  })

  it('rejects a file written by a newer schema instead of reinterpreting it', () => {
    // A version it knows must be accepted, so the check is not vacuously failing.
    const record = { schemaVersion: SERIALIZATION_SCHEMA_VERSION, kind: 'branch', branch: {} }
    expect(() => deserializeRecord(JSON.stringify(record), 1)).not.toThrow()

    const future = { schemaVersion: SERIALIZATION_SCHEMA_VERSION + 1, kind: 'branch', branch: {} }
    expect(() => deserializeRecord(JSON.stringify(future), 1)).toThrow(/schema version 2/)
  })
})
