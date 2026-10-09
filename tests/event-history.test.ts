import { asId, type DimensionId, type EventId, type NodeId } from '@episteme/core'
import { describe, expect, it } from 'vitest'
import { NODE, createFixture, dimensions, learnTags, level } from './fixtures.js'

/**
 * History is append-only.
 *
 * If a past state can be overwritten then the system cannot express "I used to understand
 * it this way", which is the whole point of the project. These tests pin that down at the
 * level of observable behaviour rather than implementation detail.
 */
describe('event history is append-only', () => {
  it('records a change of mind as a new event and keeps the earlier one readable', () => {
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

    const first = context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions(['confidence', level('low')]),
      reason: 'first reading',
    })
    const second = context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions(['confidence', level('high')]),
      reason: 'worked through the derivation',
    })

    expect(second.id).not.toBe(first.id)
    expect(context.log.eventCount).toBe(2)

    // The earlier event is still there, unchanged.
    const stored = context.log.getEvent(first.id)
    expect(stored).toEqual(first)
    expect(stored?.dimensions.get(asId<DimensionId>('confidence'))).toEqual({ level: 'low' })

    // And the history reads as the story of that change, oldest first.
    const history = context.log.history({ target: claimId, actorId: context.humanId })
    expect(history.map((event) => event.id)).toEqual([first.id, second.id])
    expect(history.map((event) => event.reason)).toEqual([
      'first reading',
      'worked through the derivation',
    ])
  })

  it('freezes committed events so a caller cannot mutate recorded history', () => {
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
      dimensions: dimensions(['confidence', level('low')]),
    })

    expect(Object.isFrozen(event)).toBe(true)
    expect(() => {
      // @ts-expect-error deliberately violating the immutability contract
      event.createdAt = 999
    }).toThrow(TypeError)
    expect(context.log.getEvent(event.id)?.createdAt).toBe(event.createdAt)
  })

  it('rejects a commit that tries to reopen a historical point instead of forking', () => {
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

    const first = context.log.commit({
      target: claimId,
      actorId: context.humanId,
      dimensions: dimensions(['confidence', level('low')]),
    })

    expect(() =>
      context.log.commit({
        target: claimId,
        actorId: context.humanId,
        dimensions: dimensions(['confidence', level('high')]),
        forkedFrom: first.id,
      }),
    ).toThrow(/fork/i)
  })

  it('does not expose any way to update or delete a committed event', () => {
    const context = createFixture()
    const surface = context.log as unknown as Record<string, unknown>

    for (const forbidden of ['update', 'delete', 'remove', 'edit', 'overwrite', 'clear']) {
      expect(surface[forbidden]).toBeUndefined()
    }
    expect(typeof context.log.getEvent(asId<EventId>('missing'))).toBe('undefined')
  })
})
