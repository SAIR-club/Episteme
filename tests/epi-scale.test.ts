import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asId, createFixedClock, defineDomainPack, type ActorId, type NodeId } from '@episteme/core'
import { openEpi, timelineView } from '@episteme/epi-reader'
import { openEpisteme } from '@episteme/sdk'
import {
  exportEpiFile,
  importEpiFile,
  openSqliteStorage,
  exportGraph,
} from '@episteme/storage-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUILD, NOW, PACKS } from './epi-fixtures.js'

/**
 * Scale and compatibility (G7): a graph with a large append-only history exports, restores and
 * reads back without loss — the records and their digest are identical after the round trip, and
 * the reader still answers over the restored file.
 */
const NODES = 400
const READINGS_PER_NODE = 3

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-epi-scale-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('a large history through export, restore and the reader', () => {
  it('round-trips hundreds of nodes and events without losing a record', async () => {
    const graph = join(directory, 'big.db')
    const storage = await openSqliteStorage(graph)
    try {
      const episteme = await openEpisteme(storage, {
        packs: PACKS.map((pack) => defineDomainPack(pack.name, pack.definitions)),
        clock: createFixedClock(0),
      })
      for (let index = 0; index < NODES; index += 1) {
        const id = asId<NodeId>(`c_${index}`)
        episteme.graph.addNode({
          id,
          type: asId('concept'),
          label: `Concept ${index}`,
          properties: { text: `Concept ${index}` },
          tags: ['topic:scale'],
        })
        for (let reading = 0; reading < READINGS_PER_NODE; reading += 1) {
          episteme.log.commit({
            target: id,
            actorId: asId<ActorId>('actor_human'),
            dimensions: new Map([
              [asId('confidence'), { level: reading % 2 === 0 ? 'low' : 'medium' }],
            ]),
            reason: `reading ${reading}`,
          })
        }
      }
      await episteme.persist()
    } finally {
      await storage.close()
    }

    const file = join(directory, 'big.epi')
    await exportEpiFile(graph, file, { build: BUILD, packs: PACKS, now: NOW })
    const restored = join(directory, 'restored.db')
    await importEpiFile(file, restored)

    // The restored graph exports the same records and the same digest; only the source name differs.
    const before = join(directory, 'before.json')
    const after = join(directory, 'after.json')
    await exportGraph(graph, before, { build: BUILD, now: NOW })
    await exportGraph(restored, after, { build: BUILD, now: NOW })
    const beforeExport = JSON.parse(await readFile(before, 'utf8')) as {
      sha256: string
      records: string[]
    }
    const afterExport = JSON.parse(await readFile(after, 'utf8')) as {
      sha256: string
      records: string[]
    }
    expect(afterExport.records).toHaveLength(beforeExport.records.length)
    expect(afterExport.sha256).toBe(beforeExport.sha256)
    expect(afterExport.records).toEqual(beforeExport.records)

    // The reader answers over the file: all nodes present, state folded, timeline complete.
    const epi = openEpi(await readFile(file, 'utf8'))
    epi.verifyIntegrity()
    expect(epi.nodes()).toHaveLength(NODES)
    expect(epi.state().length).toBeGreaterThanOrEqual(NODES)
    const timeline = timelineView(epi)
    expect(timeline.filter((entry) => entry.kind === 'state')).toHaveLength(
      NODES * READINGS_PER_NODE,
    )
  })
})
