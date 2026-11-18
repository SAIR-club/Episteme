import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GraphExportError,
  exportFromGraph,
  exportGraph,
  exportPublishedEpi,
  publishedEpiOf,
  type GraphExport,
} from '@episteme/storage-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUILD, NOW, PACKS, learningGraph } from './epi-fixtures.js'
import { writeStoredRecords } from './stored.js'

/**
 * Publication authorization under hostile data (hardening): the whitelist is re-verified against
 * the records themselves, so a tampered publication record — an edge written by someone else, a
 * root that is not among the members, a member that is really an edge, a boundary that is not
 * public — refuses the export instead of leaking. Crafted records go through the pure seam
 * (`publishedEpiOf`) because the same records can reach the exporter from a damaged or
 * hand-written graph file, not only through the ordinary write paths.
 */
let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-epi-scoped-hostile-'))
})

afterEach(async () => {
  await import('node:fs/promises').then((fs) => fs.rm(directory, { recursive: true, force: true }))
})

/** One record as it was persisted, parsed for inspection. */
type AnyRecord = { readonly kind: string; readonly [key: string]: unknown }

/** Rewrites every record body that satisfies `when`, keeping the rest byte-for-byte. */
function withRecords(
  exported: GraphExport,
  when: (record: AnyRecord) => boolean,
  change: (record: AnyRecord) => void,
): GraphExport {
  const records = exported.records.map((body) => {
    const record = JSON.parse(body) as AnyRecord
    if (when(record)) change(record)
    return JSON.stringify(record)
  })
  return { ...exported, records }
}

/** The persisted body of the one record of `kind` whose entity has `id`, if the graph holds it. */
function bodyOf(exported: GraphExport, kind: string, id: string): string | undefined {
  return exported.records.find((body) => {
    const record = JSON.parse(body) as AnyRecord
    return record.kind === kind && (record[kind] as { id?: string }).id === id
  })
}

const OPTIONS = {
  build: BUILD,
  packs: PACKS,
  now: NOW,
  actorId: 'actor_human',
  root: 'k_position',
} as const

/** The real published learning graph, read back as records a tamperer could have written. */
async function publishedExport(graph: string): Promise<GraphExport> {
  await learningGraph(graph, { publish: true })
  return exportFromGraph(graph, { build: BUILD, now: NOW })
}

describe('a scoped export of hostile records', () => {
  it('refuses a published edge that was written by someone else', async () => {
    const graph = join(directory, 'graph.db')
    const exported = await publishedExport(graph)
    const tampered = withRecords(
      exported,
      (record) => record.kind === 'edge' && (record.edge as { type: string }).type === 'answers',
      (record) => {
        ;(record.edge as { actorId: string }).actorId = 'actor_other'
      },
    )
    expect(() => publishedEpiOf(tampered, OPTIONS)).toThrow(GraphExportError)
    expect(() => publishedEpiOf(tampered, OPTIONS)).toThrow(/someone else/)
    expect(() => publishedEpiOf(tampered, OPTIONS)).toThrow(
      expect.objectContaining({ code: 'unsafe_publication' }),
    )
  })

  it('refuses a publication whose root is not among its members', async () => {
    const graph = join(directory, 'graph.db')
    const exported = await publishedExport(graph)
    // With no published edges there is no boundary check to catch it indirectly: the file would
    // name a root that is absent from the nodes it carries.
    const tampered = withRecords(
      exported,
      (record) => record.kind === 'publication',
      (record) => {
        const publication = record.publication as { members: string[]; edges: string[] }
        publication.members = publication.members.filter((id) => id !== 'k_position')
        publication.edges = []
      },
    )
    expect(() => publishedEpiOf(tampered, OPTIONS)).toThrow(GraphExportError)
    expect(() => publishedEpiOf(tampered, OPTIONS)).toThrow(
      expect.objectContaining({ code: 'unsafe_publication' }),
    )
  })

  it('refuses a member that is really an edge, not a node', async () => {
    const graph = join(directory, 'graph.db')
    const exported = await publishedExport(graph)
    const edgeId = (
      JSON.parse(
        exported.records.find((body) => (JSON.parse(body) as AnyRecord).kind === 'edge')!,
      ) as { edge: { id: string } }
    ).edge.id
    const tampered = withRecords(
      exported,
      (record) => record.kind === 'publication',
      (record) => {
        const publication = record.publication as { members: string[] }
        publication.members = [...publication.members, edgeId]
      },
    )
    expect(() => publishedEpiOf(tampered, OPTIONS)).toThrow(
      expect.objectContaining({ code: 'unsafe_publication' }),
    )
  })

  it('refuses a member node that was written by someone else', async () => {
    const graph = join(directory, 'graph.db')
    const exported = await publishedExport(graph)
    const tampered = withRecords(
      exported,
      (record) => record.kind === 'node' && (record.node as { id: string }).id === 'q_position',
      (record) => {
        ;(record.node as { actorId: string }).actorId = 'actor_other'
      },
    )
    expect(() => publishedEpiOf(tampered, OPTIONS)).toThrow(
      expect.objectContaining({ code: 'unsafe_publication' }),
    )
  })

  it('refuses a member node that is a draft', async () => {
    const graph = join(directory, 'graph.db')
    const exported = await publishedExport(graph)
    const tampered = withRecords(
      exported,
      (record) => record.kind === 'node' && (record.node as { id: string }).id === 'q_position',
      (record) => {
        ;(record.node as { meta: { tier: string } }).meta = { tier: 'draft' }
      },
    )
    expect(() => publishedEpiOf(tampered, OPTIONS)).toThrow(
      expect.objectContaining({ code: 'unsafe_publication' }),
    )
  })

  it('refuses a member node that was revoked', async () => {
    const graph = join(directory, 'graph.db')
    const exported = await publishedExport(graph)
    const tampered = withRecords(
      exported,
      (record) => record.kind === 'node' && (record.node as { id: string }).id === 'q_position',
      (record) => {
        ;(record.node as { revoked: boolean }).revoked = true
      },
    )
    expect(() => publishedEpiOf(tampered, OPTIONS)).toThrow(
      expect.objectContaining({ code: 'unsafe_publication' }),
    )
  })

  it('refuses a boundary endpoint that cannot be proven visible to everyone', async () => {
    const graph = join(directory, 'graph.db')
    const exported = await publishedExport(graph)
    // A thought-tier node outside the membership, reached by a published edge: visible to the
    // author alone, so the boundary must refuse it even though the edge itself is the author's.
    const memberBody = bodyOf(exported, 'node', 'q_position')
    expect(memberBody).toBeDefined()
    const outsider = JSON.parse(memberBody!) as {
      node: { id: string; meta: { tier: string } }
    }
    outsider.node.id = 'k_outsider'
    outsider.node.meta = { tier: 'thought' }
    const tampered = withRecords(
      { ...exported, records: [...exported.records, JSON.stringify(outsider)] },
      (record) => record.kind === 'edge' && (record.edge as { type: string }).type === 'refers_to',
      (record) => {
        ;(record.edge as { to: string }).to = 'k_outsider'
      },
    )
    expect(() => publishedEpiOf(tampered, OPTIONS)).toThrow(
      expect.objectContaining({ code: 'unsafe_publication' }),
    )
  })

  it('refuses when two publications of the same person share one root', async () => {
    const graph = join(directory, 'graph.db')
    const exported = await publishedExport(graph)
    const publicationBody = exported.records.find(
      (body) => (JSON.parse(body) as AnyRecord).kind === 'publication',
    )
    expect(publicationBody).toBeDefined()
    // The same actor and root under a second id: which publication is being shared is ambiguous.
    const second = JSON.parse(publicationBody!) as { publication: { id: string } }
    second.publication.id = 'pub_second'
    const tampered = {
      ...exported,
      records: [...exported.records, JSON.stringify(second)],
    }
    expect(() => publishedEpiOf(tampered, OPTIONS)).toThrow(
      expect.objectContaining({ code: 'ambiguous_publication' }),
    )
  })
})

describe('a scoped export and companion logs', () => {
  it('never carries companion contents, while the archive export does', async () => {
    const graph = join(directory, 'graph.db')
    await learningGraph(graph, { publish: true })
    // Distilled material lands in a companion log; the scoped exporter must leave it behind.
    const secret = '{"excerpt":"secret dialogue about the rope example"}'
    await writeStoredRecords(graph, { logs: { sources: [secret] } })

    const file = join(directory, 'shared.epi')
    const epi = await exportPublishedEpi(graph, file, OPTIONS)
    expect(JSON.stringify(epi)).not.toContain('secret dialogue')
    const readBack = await readFile(file, 'utf8')
    expect(readBack).not.toContain('secret dialogue')

    // Control: the same graph's archive export does carry companions, so the assertion above can
    // actually fail when the whitelist is broken.
    const whole = join(directory, 'whole.epi')
    await exportGraph(graph, whole, { build: BUILD, now: NOW })
    expect(await readFile(whole, 'utf8')).toContain('secret dialogue')
  })
})
