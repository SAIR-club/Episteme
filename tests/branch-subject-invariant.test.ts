import { asId, type BranchId, type DimensionId, type EventId, type NodeId } from '@episteme/core'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DIMENSION,
  NODE,
  createFixture,
  dimensions,
  level,
  type EpistemeContext,
} from './fixtures.js'

/**
 * The branch-versus-subject invariant.
 *
 * Three axes meet in this model and they are easy to conflate:
 *
 * ```text
 * branch   a line of inquiry — forked, and read as a stitched ancestry
 * subject  a node — the thing an understanding is *about*
 * actor    who holds that understanding
 * ```
 *
 * Conflating them has caused real, subtle bugs twice: `tips()` returned a branch's last event regardless
 * of which node it concerned, and `history()` mutated the array it was reading. Both were invisible until
 * a branch happened to hold events for more than one subject.
 *
 * This file states the distinction once, as assertions, so a change that blurs it fails here rather than in
 * a later feature. Nothing in retrieval may introduce a fourth interpretation.
 */

const ORDER = asId<NodeId>('claim_order')
const HEADS = asId<NodeId>('claim_heads')

let context: EpistemeContext

function seedClaims(): void {
  for (const [id, label] of [
    [ORDER, 'Self-attention does not encode sequence order.'],
    [HEADS, 'How many attention heads should I use?'],
  ] as const) {
    context.graph.addNode({
      id,
      type: NODE.claim,
      label,
      properties: { text: label },
      tags: ['topic:transformer'],
      tier: 'thought',
    })
  }
}

function record(
  target: NodeId,
  dimension: string,
  value: string,
  actorId = context.humanId,
): EventId {
  const event = context.log.commit({
    target,
    actorId,
    dimensions: dimensions([dimension, level(value)]),
  })
  return event.id
}

/** One dimension's current level for an actor, optionally read on a specific branch. */
function levelOn(target: NodeId, dimension: string, branchId?: string): string | undefined {
  const state =
    branchId === undefined
      ? context.log.stateOf(target, context.humanId)
      : context.log.stateOf(target, context.humanId, { branchId: asId<BranchId>(branchId) })
  return state.get(asId<DimensionId>(dimension))?.level
}

beforeEach(() => {
  context = createFixture()
  seedClaims()
})

describe('branch is a line of inquiry, not a subject', () => {
  it('answers "where did this actor leave off?" per branch, and "on this subject?" per branch and subject', () => {
    // Both events land on the *same* branch, and the second concerns a different subject. This is the
    // arrangement that made two documented answers disagree: a branch holds events for every node its
    // actor reasoned about, so "the tip of the branch" and "the tip of this subject" are different
    // questions with different answers.
    const orderEvent = record(ORDER, DIMENSION.confidence, 'high')
    const headsEvent = record(HEADS, DIMENSION.confidence, 'low')

    // One line of inquiry, one end: the branch's most recent event, whatever it is about.
    const branchTips = context.log.tips(context.humanId)
    expect(branchTips.map((event) => event.id)).toEqual([headsEvent])

    // Per subject: scanning the branch for the most recent event *about that node*. The ORDER tip is still
    // its own event even though the branch has since moved on to another subject — that is the whole
    // distinction, and the opposite of filtering the branch tip by subject.
    expect(context.log.tips(context.humanId, ORDER).map((event) => event.id)).toEqual([orderEvent])
    expect(context.log.tips(context.humanId, HEADS).map((event) => event.id)).toEqual([headsEvent])

    // An actor with no events on a subject gets nothing, rather than another actor's line.
    expect(context.log.tips(context.agentId)).toHaveLength(0)
    expect(context.log.tips(context.humanId, asId<NodeId>('claim_absent'))).toHaveLength(0)
  })

  it('narrows a subject tip as that subject advances, without disturbing another subject', () => {
    const first = record(ORDER, DIMENSION.confidence, 'medium')
    const headsEvent = record(HEADS, DIMENSION.confidence, 'high')

    // Advancing ORDER must move only ORDER's tip. This is the bug that was found and fixed: a
    // branch-scoped read resolved its tip to the branch's *last* event, which was about another node, and
    // so found nothing.
    const second = record(ORDER, DIMENSION.confidence, 'high')

    expect(context.log.tips(context.humanId, ORDER).map((event) => event.id)).toEqual([second])
    expect(context.log.tips(context.humanId, HEADS).map((event) => event.id)).toEqual([headsEvent])

    // The superseded event is no longer a tip for its subject, but it is still an event: a tip is a
    // position in a history, not a deletion.
    expect(context.log.tips(context.humanId, ORDER).map((event) => event.id)).not.toContain(first)
    expect(context.log.getEvent(first)?.id).toBe(first)
  })

  it('keeps a fork scoped to the subject it was forked about', () => {
    const orderEvent = record(ORDER, DIMENSION.confidence, 'high')
    record(HEADS, DIMENSION.confidence, 'low')

    const forked = context.log.fork({
      target: ORDER,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('low')]),
      from: orderEvent,
    })

    // The new branch holds one event, about ORDER only.
    expect(context.log.eventsOfBranch(forked.branch.id)).toHaveLength(1)
    expect(context.log.eventsOfBranch(forked.branch.id)[0]?.target).toBe(ORDER)

    // A subject-scoped read on the fork sees ORDER and nothing else, even though the parent branch also
    // holds an event about HEADS. A fork inherits the ancestry of its own line of inquiry, not every
    // subject the parent branch ever touched.
    expect(
      context.log.stateOf(ORDER, context.humanId, { branchId: forked.branch.id }).size,
    ).toBeGreaterThan(0)
    expect(context.log.stateOf(HEADS, context.humanId, { branchId: forked.branch.id }).size).toBe(0)
  })

  it('leaves a branch-global read of its own branch unchanged when another branch diverges', () => {
    const event = record(ORDER, DIMENSION.confidence, 'high')

    context.log.fork({
      target: ORDER,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('low')]),
      from: event,
    })

    // Events on the default branch are exactly what was committed to it. `eventsOfBranch` is the
    // branch-global read, and it must not be widened by a fork elsewhere.
    expect(context.log.eventsOfBranch(context.log.defaultBranchId).map((e) => e.id)).toEqual([
      event,
    ])
  })

  it('gives a fork its own open end without disturbing the branch it came from', () => {
    const base = record(ORDER, DIMENSION.confidence, 'medium')

    // `fork` moves the actor onto the new branch: the next commit continues the *fork*, not the branch it
    // was cut from. That is what makes a fork a change of direction rather than a second annotation.
    const forked = context.log.fork({
      target: ORDER,
      actorId: context.humanId,
      dimensions: dimensions([DIMENSION.confidence, level('high')]),
      from: base,
    })

    const advanced = record(ORDER, DIMENSION.confidence, 'low')

    // The fork's first event continues the fork point explicitly, so a lineage fold reaches the
    // understanding the fork started from without special-casing branches.
    expect(forked.event.parent).toBe(base)
    expect(forked.event.forkedFrom).toBe(base)
    expect(context.log.currentBranch(context.humanId).id).toBe(forked.branch.id)
    expect(advanced).toBeDefined()

    // The fork now holds one open end for this subject, and the original branch keeps its own — untouched,
    // because the fork read only the lineage it was cut from.
    const orderTips = context.log.tips(context.humanId, ORDER).map((event) => event.id)
    expect(orderTips).toHaveLength(2)
    expect(orderTips).toContain(base)
    // Per branch, the tip is that branch's most recent event about the subject — the original branch never
    // advanced past `base`, so `base` is still its end for this subject.
    expect(orderTips).toContain(advanced)

    // And the inherited reading is still reachable from the fork even though it was never committed there.
    expect(context.log.eventsOfBranch(forked.branch.id).map((event) => event.id)).toEqual([
      forked.event.id,
      advanced,
    ])
    expect(context.log.branchAncestry(forked.branch.id)).toEqual([
      context.log.defaultBranchId,
      forked.branch.id,
    ])
    expect(levelOn(ORDER, DIMENSION.confidence, forked.branch.id)).toBe('low')
  })
})

describe('a retrieval result names its subject, actor and branch context', () => {
  it('reports the node each entry is about, and never mixes two actors', async () => {
    const { DeterministicEmbeddingAdapter, InMemoryEmbeddingCache, HybridRetriever, retrieveWith } =
      await import('@episteme/core')

    record(ORDER, DIMENSION.confidence, 'high', context.humanId)
    record(ORDER, DIMENSION.confidence, 'low', context.agentId)

    const hybrid = new HybridRetriever(
      context.graph,
      context.log,
      new DeterministicEmbeddingAdapter(),
      new InMemoryEmbeddingCache(),
    )

    const forHuman = await retrieveWith(
      hybrid,
      context.graph,
      context.log,
      'sequence order in attention',
      { actorId: context.humanId, depth: 1 },
    )
    const forAgent = await retrieveWith(
      hybrid,
      context.graph,
      context.log,
      'sequence order in attention',
      { actorId: context.agentId, depth: 1 },
    )

    // The retrieved *graph* part is identical: a concept is shared.
    expect(forHuman.nodes.map((node) => node.id)).toEqual(forAgent.nodes.map((node) => node.id))

    // The *understanding* part is not. This is the invariant a retrieval result must never blur, and it is
    // why a result carries both: `nodes` is the subject, `known` is the subject-as-understood-by-actor.
    // The context names the actor it was built for, so the reading is never ambiguous.
    expect(forHuman.actorId).toBe(context.humanId)
    expect(forAgent.actorId).toBe(context.agentId)

    expect(forHuman.known.map((entry) => entry.nodeId)).toContain(ORDER)
    expect(forAgent.known.map((entry) => entry.nodeId)).toContain(ORDER)

    const humanConfidence = forHuman.known.find((entry) => entry.nodeId === ORDER)?.state.confidence
      ?.level
    const agentConfidence = forAgent.known.find((entry) => entry.nodeId === ORDER)?.state.confidence
      ?.level
    expect(humanConfidence).toBe('high')
    expect(agentConfidence).toBe('low')
  })
})
