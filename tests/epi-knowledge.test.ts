import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EpiFileError, readEpiFile, type EpiFile } from '@episteme/epi-format'
import {
  buildEpiFile,
  exportEpiFile,
  exportGraph,
  importEpiFile,
  openSqliteStorage,
} from '@episteme/storage-sqlite'
import { describe, expect, it } from 'vitest'
import { BUILD, HUMAN, NOW, PACKS, forkAndRevoke, learningGraph } from './epi-fixtures.js'

/**
 * The knowledge projection (ADR 0023): derived from the very records the archive carries, through the
 * same Core machinery a live session uses. Determinism, tamper detection and fork/revoke/withdrawal
 * correctness are the contract; a projection that a refold would contradict must not verify.
 */

const readEnvelope = async (file: string): Promise<EpiFile> =>
  readEpiFile(await readFile(file, 'utf8'))

describe('a .epi knowledge file of a real learning session', () => {
  let directory: string
  let graph: string

  const setup = async (): Promise<void> => {
    directory = await mkdtemp(join(tmpdir(), 'episteme-epi-'))
    graph = join(directory, 'graph.db')
    await learningGraph(graph, { publish: true })
  }

  it('derives the same projection from the same history, twice, byte for byte', async () => {
    await setup()
    const one = buildEpiFile(graph, { build: BUILD, packs: PACKS, now: NOW })
    const two = buildEpiFile(graph, { build: BUILD, packs: PACKS, now: NOW })
    expect(JSON.stringify(one)).toBe(JSON.stringify(two))
    expect(one.knowledge?.derivedFrom.historySha256).toBe(one.archive?.history.sha256)
  })

  it('carries the knowledge a reader needs: nodes, typed relations, per-actor state, the fork lineage and the publication', async () => {
    await setup()
    await forkAndRevoke(graph)
    const file = join(directory, 'graph.epi')
    await exportEpiFile(graph, file, { build: BUILD, packs: PACKS, now: NOW })
    const epi = await readEnvelope(file)

    const nodeIds = (epi.knowledge?.nodes ?? []).map((node) => (node as { id: string }).id)
    expect(nodeIds).toEqual(['c_transformer', 'k_position', 'q_position', 'k_nope'])
    const edges = (epi.knowledge?.edges ?? []).map((edge) => (edge as { type: string }).type)
    expect(edges).toEqual(['answers', 'contradicts', 'refers_to'])
    // Two branches: the original line and the fork; the fork names where it was cut from.
    expect(epi.knowledge?.branches).toHaveLength(2)
    const branches = (epi.knowledge?.branches ?? []) as {
      id: string
      parentBranchId?: string
    }[]
    const fork = branches.find((branch) => branch.parentBranchId !== undefined)
    const original = branches.find((branch) => branch.parentBranchId === undefined)
    // The fork names where it was cut from: the original line.
    expect(fork?.parentBranchId).toBe(original?.id)
    // The retracted 'high' reading left the reduction; the fork's 'low' reading is the latest word,
    // and the NoPE conflict stays open.
    expect(epi.knowledge?.state).toContainEqual({
      target: 'k_position',
      actor: HUMAN,
      dimensions: { confidence: { level: 'low' }, conflict: { level: 'open' } },
    })
    // Nothing is erased: the publication and the withdrawal of nothing are both there, and the
    // retracted event is still in the archive's history.
    expect(
      (epi.knowledge?.publications ?? []).some(
        (entry) => (entry as { root?: string }).root === 'k_position',
      ),
    ).toBe(true)
    expect(JSON.stringify(epi.archive?.history.records)).toContain('high')
  })

  it('detects a projection spliced from another file: the receipt names a history this file does not carry', async () => {
    await setup()
    const fileA = join(directory, 'a.epi')
    const fileB = join(directory, 'b.epi')
    await exportEpiFile(graph, fileA, { build: BUILD, packs: PACKS, now: NOW })
    const other = join(directory, 'other.db')
    await learningGraph(other, { publish: true })
    await exportEpiFile(other, fileB, { build: BUILD, packs: PACKS, now: NOW })

    const a = JSON.parse(await readFile(fileA, 'utf8')) as EpiFile
    const b = JSON.parse(await readFile(fileB, 'utf8')) as EpiFile
    // B's history is valid, and so is A's knowledge — but A's projection was derived from A's
    // history, and the receipt says so.
    const spliced = { ...b, knowledge: a.knowledge }
    const file = join(directory, 'spliced.epi')
    await writeFile(file, JSON.stringify(spliced))
    let refusal: unknown
    try {
      readEpiFile(await readFile(file, 'utf8'))
    } catch (reason: unknown) {
      refusal = reason
    }
    expect(refusal).toBeInstanceOf(EpiFileError)
    expect((refusal as EpiFileError).code).toBe('projection_mismatch')
  })

  it('restores the archive into a new graph that exports identically, and refuses to restore a knowledge-only file', async () => {
    await setup()
    const file = join(directory, 'graph.epi')
    await exportEpiFile(graph, file, { build: BUILD, packs: PACKS, now: NOW })
    const restored = join(directory, 'restored.db')
    await importEpiFile(file, restored)
    const before = join(directory, 'before.json')
    const after = join(directory, 'after.json')
    await exportGraph(graph, before, { build: BUILD, now: NOW })
    await exportGraph(restored, after, { build: BUILD, now: NOW })
    // The restored graph's records and digest must match the original byte for byte; the export
    // envelope names the source database file, which legitimately differs ('graph.db' vs
    // 'restored.db'), so compare the content, not the whole envelope.
    const beforeExport = JSON.parse(await readFile(before, 'utf8')) as {
      sha256: string
      records: string[]
    }
    const afterExport = JSON.parse(await readFile(after, 'utf8')) as {
      sha256: string
      records: string[]
    }
    expect(afterExport.sha256).toBe(beforeExport.sha256)
    expect(afterExport.records).toEqual(beforeExport.records)

    const full = JSON.parse(await readFile(file, 'utf8')) as EpiFile
    const knowledgeOnly = {
      format: full.format,
      version: full.version,
      exportedAt: full.exportedAt,
      source: full.source,
      profiles: ['knowledge'],
      ontology: full.ontology,
      knowledge: full.knowledge,
    }
    const readable = join(directory, 'readable.epi')
    await writeFile(readable, JSON.stringify(knowledgeOnly))
    expect(readEpiFile(await readFile(readable, 'utf8')).profiles).toEqual(['knowledge'])
    await expect(importEpiFile(readable, join(directory, 'nope.db'))).rejects.toThrow(
      /no restorable history/,
    )
  })

  it('refuses to build from a graph another connection holds', async () => {
    await setup()
    const storage = await openSqliteStorage(graph)
    try {
      expect(() => buildEpiFile(graph, { build: BUILD, packs: PACKS, now: NOW })).toThrow(
        /already open/,
      )
    } finally {
      await storage.close()
    }
  })

  it('records the vocabulary the session actually registered, in application order', async () => {
    await setup()
    const epi = buildEpiFile(graph, { build: BUILD, packs: PACKS, now: NOW })
    expect(epi.ontology?.packs.map((pack) => pack.name)).toEqual([
      'episteme-application',
      'default-session-pack',
    ])
    const dimensionIds = (epi.ontology?.packs[1]?.definitions.stateDimensions ?? []).map(
      (dimension) => dimension.id,
    )
    expect(dimensionIds).toContain('confidence')
    expect(dimensionIds).toContain('conflict')
  })

  it('leaves nothing behind when a refused build never wrote', async () => {
    await setup()
    const target = join(directory, 'never.epi')
    await writeFile(target, 'keep me')
    await expect(
      exportEpiFile(graph, target, { build: BUILD, packs: PACKS, now: NOW }),
    ).rejects.toThrow(/already exists/)
    expect(await readFile(target, 'utf8')).toBe('keep me')
  })
})
