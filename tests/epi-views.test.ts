import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openEpi,
  mapView,
  outlineView,
  timelineView,
  type OutlineNode,
  type TimelineEntry,
} from '@episteme/epi-reader'
import { exportEpiFile } from '@episteme/storage-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUILD, NOW, PACKS, forkAndRevoke, learningGraph } from './epi-fixtures.js'

/**
 * Multi-view over one file (G6): the same stable ids organized as an outline and as a revision
 * timeline. Views are derived presentation — rebuildable from the knowledge section alone — so a
 * damaged or missing views section cannot touch what is true, and no view ever copies a node into
 * a second state.
 */
let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-epi-views-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('two organizational views over one .epi file', () => {
  it('organizes the same ids as an outline and as a revision timeline', async () => {
    const graph = join(directory, 'graph.db')
    await learningGraph(graph)
    await forkAndRevoke(graph)
    const file = join(directory, 'graph.epi')
    await exportEpiFile(graph, file, { build: BUILD, packs: PACKS, now: NOW })
    const epi = openEpi(await readFile(file, 'utf8'))

    // The outline: concepts and questions are roots, the claim hangs under what it answers, and
    // the ids are the file's own — never copies.
    const outline = outlineView(epi)
    const flat = outline.flatMap((group) => group.roots).flatMap(flatten)
    expect(new Set(flat).size).toBe(flat.length)
    const ids = new Set(flat)
    expect(ids).toContain('k_position')
    expect(ids).toContain('c_transformer')
    const kPositionEntry = outline
      .flatMap((group) => group.roots)
      .flatMap(flattenNodes)
      .find((entry) => entry.id === 'q_position')
    // The claim hangs beneath the question it answers.
    expect(kPositionEntry?.children.some((child) => child.id === 'k_position')).toBe(true)

    // The map: the typed relation network, unchanged.
    const map = mapView(epi)
    expect(map.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining(['c_transformer', 'k_position', 'q_position', 'k_nope']),
    )
    expect(map.edges.map((edge) => edge.type)).toEqual(
      expect.arrayContaining(['answers', 'contradicts', 'refers_to']),
    )

    // The timeline: the revision thread, in commit order, forks marked.
    const timeline = timelineView(epi)
    const reasons = timeline
      .filter((entry) => entry.kind === 'state' && entry.nodeId === 'k_position')
      .map((entry) => entry.reason)
    expect(reasons).toEqual([
      'first reading',
      'worked the rope example by hand',
      'the NoPE result',
      'the NoPE result made me doubt the rope example',
    ])
    const fork = timeline.find((entry) => entry.kind === 'fork')
    expect(fork?.forkPoint).toBe(epi.historyOf('k_position')[0]?.eventId)
    expect(threadRevocations(timeline)).toContain('worked the rope example by hand')
  })

  it('rebuilds identical views after the views section is lost or damaged', async () => {
    const graph = join(directory, 'graph.db')
    await learningGraph(graph)
    const file = join(directory, 'graph.epi')
    await exportEpiFile(graph, file, { build: BUILD, packs: PACKS, now: NOW })
    const full = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>

    // Missing views: the views are derived, so absence changes nothing.
    const withoutViews = { ...full, views: undefined }
    const rebuilt = openEpi(JSON.stringify(withoutViews))
    // Damaged views: a broken entry is dropped, never allowed to gate the knowledge it decorates.
    const damaged = {
      ...full,
      views: [{ name: 1 }, 'no', { name: 'ok', kind: 'outline', over: {}, layout: {} }],
    }
    const stillReadable = openEpi(JSON.stringify(damaged))
    expect(stillReadable.views).toEqual([{ name: 'ok', kind: 'outline', over: {}, layout: {} }])
    // The knowledge either way is the same bytes, and the views rebuild identically.
    expect(JSON.stringify(stillReadable.knowledge)).toBe(JSON.stringify(rebuilt.knowledge))
    expect(JSON.stringify(outlineView(stillReadable))).toBe(JSON.stringify(outlineView(rebuilt)))
    expect(JSON.stringify(timelineView(stillReadable))).toBe(JSON.stringify(timelineView(rebuilt)))
  })
})

function flatten(node: OutlineNode): string[] {
  return [node.id, ...node.children.flatMap(flatten)]
}

function flattenNodes(node: OutlineNode): OutlineNode[] {
  return [node, ...node.children.flatMap(flattenNodes)]
}

function threadRevocations(timeline: readonly TimelineEntry[]): readonly (string | undefined)[] {
  return timeline
    .filter((entry) => entry.kind === 'state' && entry.revoked === true)
    .map((entry) => entry.reason)
}
