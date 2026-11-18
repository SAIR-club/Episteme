import { EpiFileError, readEpiFile, knowledgeDigestOf, type EpiFile } from '@episteme/epi-format'
import { buildEpiFile, verifyEpiProjection } from '@episteme/storage-sqlite'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUILD, NOW, PACKS, learningGraph } from './epi-fixtures.js'

/**
 * Hash integrity against replay consistency (hardening): the container's checksums prove the bytes
 * are the ones that were written, and the receipts pin the named inputs — but a tamperer can edit
 * the knowledge section and recompute its checksum, and `readEpiFile` still passes. Only refolding
 * the carried history through Core proves the projection actually derives from what the file
 * carries, so the archive profile gets that verification here, where Core lives.
 */
let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-epi-verify-'))
})

afterEach(async () => {
  await import('node:fs/promises').then((fs) => fs.rm(directory, { recursive: true, force: true }))
})

/** The refusal code a refused verification carries, or a marker when nothing was refused. */
function codeOf(run: () => void): string {
  try {
    run()
  } catch (error) {
    return (error as { code?: string }).code ?? 'no code'
  }
  return 'no refusal'
}

function exportedArchive(graph: string): EpiFile {
  return buildEpiFile(graph, { build: BUILD, packs: PACKS, now: NOW })
}

describe('replay verification of an archive knowledge projection', () => {
  it('accepts a projection that really derives from the carried history', async () => {
    const graph = join(directory, 'graph.db')
    await learningGraph(graph, { publish: true })
    const epi = exportedArchive(graph)
    expect(() => verifyEpiProjection(epi)).not.toThrow()
  })

  it('refuses an edited knowledge section whose checksum was recomputed', async () => {
    const graph = join(directory, 'graph.db')
    await learningGraph(graph, { publish: true })
    const epi = exportedArchive(graph)

    // A tamperer rewrites a claim and fixes the section checksum: every byte-level check now
    // agrees with itself, and readEpiFile — which checks checksums and receipts, never a refold —
    // passes. This is exactly the forgery hash integrity cannot see.
    const knowledge = epi.knowledge
    if (knowledge === undefined) throw new Error('the export carries no knowledge section')
    const forged = {
      ...knowledge,
      nodes: knowledge.nodes.map((node) =>
        (node as { id: string }).id === 'k_position'
          ? { ...(node as object), label: 'Attention needs no position information' }
          : node,
      ),
    }
    delete (forged as { sha256?: string }).sha256
    const resealed: EpiFile = {
      ...epi,
      knowledge: { ...forged, sha256: knowledgeDigestOf(forged) },
    }
    expect(() => readEpiFile(JSON.stringify(resealed))).not.toThrow()
    expect(() => verifyEpiProjection(resealed)).toThrow(EpiFileError)
    expect(codeOf(() => verifyEpiProjection(resealed))).toBe('projection_mismatch')
  })

  it('refuses to replay-verify a knowledge-only file, which carries no history', async () => {
    const graph = join(directory, 'graph.db')
    await learningGraph(graph, { publish: true })
    const epi = exportedArchive(graph)
    const knowledgeOnly: EpiFile = { ...epi, profiles: ['knowledge'] }
    delete (knowledgeOnly as { archive?: unknown }).archive
    expect(() => verifyEpiProjection(knowledgeOnly)).toThrow(EpiFileError)
    expect(codeOf(() => verifyEpiProjection(knowledgeOnly))).toBe('missing_section')
    expect(() => verifyEpiProjection(knowledgeOnly)).toThrow(/no history/)
  })
})
