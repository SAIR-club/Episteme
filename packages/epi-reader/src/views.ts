/**
 * Derived presentation over a knowledge file's own data (ADR 0023): the same stable ids, organized
 * differently. A view computes nothing that is not already in the file, copies no knowledge into
 * itself, and is rebuildable from the knowledge section alone — so a damaged or missing view can
 * never change what is true.
 */
import { asDimensionRecord } from './index.js'
import type { EpiKnowledgeFile, EpiNode } from './index.js'

/** One node of an outline: the file's own id, and the nodes hung beneath it. */
export interface OutlineNode {
  readonly id: string
  readonly children: readonly OutlineNode[]
}

export interface OutlineGroup {
  /** The `topic:` tag value the group hangs from, or `ungrouped`. */
  readonly topic: string
  readonly roots: readonly OutlineNode[]
}

/**
 * A mind-map-like outline: every node hangs beneath what it answers, supports or refers to; nodes
 * nothing hangs under are roots. Children order deterministically by (createdAt, id); a node is
 * placed once even when several relations reach it, so no concept is duplicated into two states.
 */
export function outlineView(epi: EpiKnowledgeFile): readonly OutlineGroup[] {
  const EDGE_TYPES = new Set(['answers', 'supports', 'refers_to'])
  const parentOf = new Map<string, string>()
  const orderedEdges = [...epi.edges()].sort(
    (left, right) => left.type.localeCompare(right.type) || left.from.localeCompare(right.from),
  )
  for (const edge of orderedEdges) {
    if (!EDGE_TYPES.has(edge.type)) continue
    if (!parentOf.has(edge.from) && edge.from !== edge.to) parentOf.set(edge.from, edge.to)
  }

  const childrenOf = new Map<string, string[]>()
  for (const node of epi.nodes()) {
    const parent = parentOf.get(node.id)
    if (parent === undefined) continue
    const children = childrenOf.get(parent) ?? []
    children.push(node.id)
    childrenOf.set(parent, children)
  }
  const ordered = (ids: readonly string[]): readonly string[] =>
    [...ids].sort((left, right) => rank(left) - rank(right))

  const rank = (id: string): number => {
    const node = epi.node(id)
    return node?.createdAt ?? 0
  }

  const build = (id: string, depth: number): OutlineNode => ({
    id,
    children:
      depth > 32 ? [] : ordered(childrenOf.get(id) ?? []).map((child) => build(child, depth + 1)),
  })

  const roots = epi
    .nodes()
    .filter((node) => !parentOf.has(node.id))
    .map((node) => node.id)

  const groups = new Map<string, string[]>()
  for (const id of roots) {
    const topic = epi
      .node(id)
      ?.tags?.find((tag) => tag.startsWith('topic:'))
      ?.slice('topic:'.length)
    const key = topic ?? 'ungrouped'
    const ids = groups.get(key) ?? []
    ids.push(id)
    groups.set(key, ids)
  }
  return [...groups.keys()].sort().map((topic) => ({
    topic,
    roots: ordered(groups.get(topic) ?? []).map((id) => build(id, 0)),
  }))
}

export interface MapView {
  readonly nodes: readonly EpiNode[]
  readonly edges: readonly {
    readonly id: string
    readonly from: string
    readonly to: string
    readonly type: string
  }[]
}

/** A typed relation network: the knowledge section's own nodes and edges, nothing rearranged. */
export function mapView(epi: EpiKnowledgeFile): MapView {
  return {
    nodes: epi.nodes(),
    edges: epi.edges().map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      type: edge.type,
    })),
  }
}

export interface TimelineEntry {
  readonly at: number
  readonly kind: 'state' | 'fork'
  /** For `state`: the event record this entry shows, when the archive names it. */
  readonly eventId?: string
  /** For `state`: the node whose understanding changed, as the file's own id. */
  readonly nodeId?: string
  readonly branchId?: string
  /** For `fork`: where the new branch was cut from. */
  readonly forkPoint?: string
  readonly actor?: string
  readonly reason?: string
  readonly dimensions?: Readonly<Record<string, unknown>>
  readonly revoked?: boolean
  readonly revocationReason?: string
}

/**
 * The revision timeline: every state change the archive carries, in the archive's own record order —
 * the order the events were committed in — with forks marked. Entries reference the file's own ids;
 * the timeline owns no knowledge of its own. A knowledge-only file has no timeline.
 */
export function timelineView(epi: EpiKnowledgeFile): readonly TimelineEntry[] {
  const archive = epi.archive
  if (archive === undefined) return []
  const known = new Set(epi.nodes().map((node) => node.id))
  const revocations = new Map<string, { reason?: string }>()
  const entries: TimelineEntry[] = []
  for (const record of archive.records) {
    let parsed: unknown
    try {
      parsed = JSON.parse(record)
    } catch {
      continue
    }
    const body = parsed as {
      kind?: string
      event?: Record<string, unknown>
      branch?: Record<string, unknown>
      revocation?: { eventId?: string; reason?: string }
    }
    if (body.kind === 'revocation' && typeof body.revocation?.eventId === 'string') {
      revocations.set(body.revocation.eventId, {
        ...(typeof body.revocation.reason === 'string' ? { reason: body.revocation.reason } : {}),
      })
      continue
    }
    if (body.kind === 'branch') {
      const branch = body.branch
      if (
        branch !== undefined &&
        typeof branch.id === 'string' &&
        typeof branch.parentBranchId === 'string'
      ) {
        entries.push({
          at: typeof branch.createdAt === 'number' ? branch.createdAt : 0,
          kind: 'fork',
          branchId: branch.id,
          ...(typeof branch.forkPoint === 'string' ? { forkPoint: branch.forkPoint } : {}),
        })
      }
      continue
    }
    if (body.kind !== 'event') continue
    const event = body.event
    if (event === undefined || typeof event.target !== 'string' || !known.has(event.target)) {
      continue
    }
    entries.push({
      at: typeof event.createdAt === 'number' ? event.createdAt : 0,
      kind: 'state',
      ...(typeof event.id === 'string' ? { eventId: event.id } : {}),
      nodeId: event.target,
      ...(typeof event.branchId === 'string' ? { branchId: event.branchId } : {}),
      ...(typeof event.actorId === 'string' ? { actor: event.actorId } : {}),
      ...(typeof event.reason === 'string' ? { reason: event.reason } : {}),
      dimensions: asDimensionRecord(event.dimensions),
      revoked: false,
    })
  }
  // A revocation record trails the event it withdraws, so marking happens after collection.
  return entries.map((entry) => {
    if (entry.kind !== 'state' || entry.eventId === undefined) return entry
    const revocation = revocations.get(entry.eventId)
    if (revocation === undefined) return entry
    return {
      ...entry,
      revoked: true,
      ...(revocation.reason === undefined ? {} : { revocationReason: revocation.reason }),
    }
  })
}
