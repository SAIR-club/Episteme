import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEpiFile } from '@episteme/epi-format'
import { openEpi } from '@episteme/epi-reader'
import { GraphExportError, exportPublishedEpi } from '@episteme/storage-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUILD, NOW, PACKS, learningGraph } from './epi-fixtures.js'

/**
 * Scoped knowledge publication (G4): the whitelist is computed from the persisted Publication
 * record before serialization, private material never enters the bytes, and anything that cannot be
 * proven safe refuses the export. The leak scan reads every string the file carries — header,
 * ontology, knowledge and the receipt — because a private node hidden from one section but present
 * in another is still leaked.
 */
let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-epi-scoped-'))
})

afterEach(async () => {
  await import('node:fs/promises').then((fs) => fs.rm(directory, { recursive: true, force: true }))
})

describe('a scoped export of one publication', () => {
  it('carries exactly the published subgraph, and nothing private anywhere in the file', async () => {
    const graph = join(directory, 'graph.db')
    await learningGraph(graph, { publish: true })
    const file = join(directory, 'shared.epi')
    const epi = await exportPublishedEpi(graph, file, {
      build: BUILD,
      packs: PACKS,
      now: NOW,
      actorId: 'actor_human',
      root: 'k_position',
    })

    // The sharing shape: readable, verifiable, honest about not being restorable.
    expect(epi.profiles).toEqual(['knowledge'])
    expect(epi.archive).toBeUndefined()
    const checked = readEpiFile(await readFile(file, 'utf8'))
    expect(checked.profiles).toEqual(['knowledge'])
    expect(checked.archive).toBeUndefined()

    const reader = openEpi(JSON.stringify(epi))
    expect(reader.restorable).toBe(false)
    expect(reader.nodes().map((node) => node.id)).toEqual([
      'c_transformer',
      'k_position',
      'q_position',
    ])
    expect(reader.edges().map((edge) => edge.type)).toEqual(['answers', 'refers_to'])
    // What another reader may reuse is named.
    expect(reader.publications()).toHaveLength(1)
    // Understanding state is private: a publication shares knowledge, not anyone's state.
    expect(reader.state()).toEqual([])
    expect(reader.actors()).toEqual([])

    // Leak scan over every byte the file carries: the private claim, its label, the recorded
    // reasons and the event records are absent from every section. (Vocabulary ids such as
    // `confidence` or `contradicts` do appear — the ontology manifest deliberately carries the
    // registered vocabulary; it carries no one's content.)
    const raw = JSON.stringify(epi)
    for (const secret of [
      'k_nope',
      'NoPE',
      'the NoPE result',
      'rope example',
      'evt_',
      'br_',
      '"revocations"',
      '"withdrawals"',
    ]) {
      expect(raw, `leaked ${secret}`).not.toContain(secret)
    }
  })

  it('refuses when nothing is authorized to share', async () => {
    const graph = join(directory, 'graph.db')
    await learningGraph(graph)
    await expect(
      exportPublishedEpi(graph, join(directory, 'shared.epi'), {
        build: BUILD,
        packs: PACKS,
        now: NOW,
        actorId: 'actor_human',
        root: 'k_position',
      }),
    ).rejects.toThrow(GraphExportError)
    await expect(
      exportPublishedEpi(graph, join(directory, 'shared.epi'), {
        build: BUILD,
        packs: PACKS,
        now: NOW,
        actorId: 'actor_human',
        root: 'k_position',
      }),
    ).rejects.toMatchObject({ code: 'no_publication' })
  })

  it('refuses when a member can no longer be proven safe, and writes nothing', async () => {
    // A real path: the publication exists, but a member node was revoked afterwards. The export
    // re-verifies the publication's rules against the persisted records, so it refuses rather than
    // share a subgraph whose meaning quietly changed.
    const graph = join(directory, 'graph.db')
    await learningGraph(graph, { publish: true })
    const { openEpisteme } = await import('@episteme/sdk')
    const { openSqliteStorage } = await import('@episteme/storage-sqlite')
    const storage = await openSqliteStorage(graph)
    try {
      const episteme = await openEpisteme(storage, {})
      episteme.graph.revokeNode('q_position')
      await episteme.persist()
    } finally {
      await storage.close()
    }

    const target = join(directory, 'shared.epi')
    await expect(
      exportPublishedEpi(graph, target, {
        build: BUILD,
        packs: PACKS,
        now: NOW,
        actorId: 'actor_human',
        root: 'k_position',
      }),
    ).rejects.toMatchObject({ code: 'unsafe_publication' })
    expect(
      await readFile(target, 'utf8').then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    // Nothing was written, and the graph itself still exports as a whole.
    const { exportGraph } = await import('@episteme/storage-sqlite')
    const whole = join(directory, 'whole.epi')
    await exportGraph(graph, whole, { build: BUILD, now: NOW })
    const parsed = JSON.parse(await readFile(whole, 'utf8')) as { counts?: { records?: number } }
    expect((parsed.counts?.records ?? 0) > 0).toBe(true)
  })

  it('refuses to share a withdrawn publication', async () => {
    const graph = join(directory, 'graph.db')
    const session = await import('@episteme/application').then((m) =>
      m.CognitiveSession.open({ filePath: graph, sharing: true }),
    )
    let publicationId: string
    try {
      await session.addNode({ id: 'c_solo', label: 'Solo concept', kind: 'concept', topic: 'solo' })
      const published = await session.publish({ root: 'c_solo' })
      if (!published.ok) throw new Error(JSON.stringify(published.refusal))
      publicationId = published.publication.id
    } finally {
      await session.close()
    }
    const withdrawnSession = await import('@episteme/application').then((m) =>
      m.CognitiveSession.open({ filePath: graph, sharing: true }),
    )
    try {
      const withdrawn = await withdrawnSession.withdrawPublication(publicationId, 'changed my mind')
      if (!withdrawn.ok) throw new Error(JSON.stringify(withdrawn.refusal))
    } finally {
      await withdrawnSession.close()
    }

    await expect(
      exportPublishedEpi(graph, join(directory, 'shared.epi'), {
        build: BUILD,
        packs: PACKS,
        now: NOW,
        actorId: 'actor_human',
        root: 'c_solo',
      }),
    ).rejects.toMatchObject({ code: 'withdrawn_publication' })
  })
})
