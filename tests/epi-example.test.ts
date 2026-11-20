import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { EPI_FORMAT, EPI_PROFILES, EPI_VERSION, readEpiFile } from '@episteme/epi-format'
import { openEpi, outlineView, timelineView, type OutlineNode } from '@episteme/epi-reader'
import { describe, expect, it } from 'vitest'

/**
 * The committed example and schema (G7): `docs/epi/example.epi` is a real export of the
 * positional-encoding case — material, initial understanding, the NoPE conflict, a fork, a
 * retraction and a publication — and must keep answering through the reader. The JSON Schema must
 * agree with the container constants, so the documented format and the implemented one cannot
 * drift.
 */
const docsDir = join(import.meta.dirname, '..', 'docs', 'epi')

describe('the committed .epi example and schema', () => {
  it('reads the example file and answers what it shows', async () => {
    const epi = openEpi(await readFile(join(docsDir, 'example.epi'), 'utf8'))
    epi.verifyIntegrity()
    expect(epi.restorable).toBe(true)
    expect(epi.nodes().map((node) => node.id)).toEqual(
      expect.arrayContaining(['claim_1', 'question_1']),
    )
    // The conflict and the revision are visible: an open conflict, a live contradicts relation,
    // and a retracted reading with its stated reason.
    expect(
      Object.values(epi.state().find((entry) => entry.target === 'claim_1')?.dimensions ?? {}),
    ).toContainEqual({ level: 'open' })
    expect(epi.edges().some((edge) => edge.type === 'contradicts')).toBe(true)
    const thread = epi.historyOf('claim_1')
    expect(
      thread.some((clue) => clue.revoked && clue.revocationReason === 'the NoPE finding'),
    ).toBe(true)
    // One file, several organizations, the same ids.
    const outlineIds = outlineView(epi)
      .flatMap((group) => group.roots)
      .flatMap(flattenNodes)
    const timeline = timelineView(epi)
    expect(outlineIds).toContain('claim_1')
    expect(timeline.filter((entry) => entry.kind === 'state').length).toBeGreaterThanOrEqual(5)
    // What another reader may reuse is named.
    expect(epi.publications().length).toBeGreaterThanOrEqual(1)
  })

  it('keeps the JSON Schema in step with the container constants', async () => {
    const schema = JSON.parse(await readFile(join(docsDir, 'epi-v2.schema.json'), 'utf8')) as {
      properties?: {
        format?: { const?: string }
        version?: { const?: number }
        profiles?: { items?: { enum?: string[] } }
      }
    }
    expect(schema.properties?.format?.const).toBe(EPI_FORMAT)
    expect(schema.properties?.version?.const).toBe(EPI_VERSION)
    const profileEnum = (schema.properties?.profiles as { items?: { enum?: string[] } }).items?.enum
    expect(profileEnum).toEqual([...EPI_PROFILES])
    // The example file must satisfy the schema's declared shape: the envelope fields it requires.
    const example = readEpiFile(await readFile(join(docsDir, 'example.epi'), 'utf8'))
    for (const key of ['format', 'version', 'exportedAt', 'source', 'profiles']) {
      expect(example, `example carries ${key}`).toHaveProperty(key)
    }
  })
})

function flattenNodes(node: OutlineNode): string[] {
  return [node.id, ...node.children.flatMap(flattenNodes)]
}
