import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LearnSession } from '@episteme/application'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeStoredRecords } from './stored.js'

/**
 * A graph written by v0.1.0 opens, reduces and recalls exactly as it did (ADR 0013, step M3).
 *
 * The files in `golden/v0.1` hold the records the v0.1.0 session wrote, one body per line, plus two events in legacy
 * levels. The test lays them into a graph file as they are, which is how a graph that predates the SQLite file
 * comes to hold them. Moving the application's vocabulary into a scene profile must not change a single thing read
 * from them.
 */

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'golden', 'v0.1')

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-golden-'))
  const lines = async (name: string) =>
    (await readFile(join(GOLDEN, name), 'utf8')).split(/\r?\n/).filter((line) => line.trim() !== '')
  await writeStoredRecords(join(directory, 'graph.db'), {
    records: await lines('graph.jsonl'),
    logs: {
      suggestions: await lines('graph.jsonl.suggestions.jsonl'),
      sources: await lines('graph.jsonl.sources.jsonl'),
    },
  })
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function readGraph(open: (filePath: string) => Promise<LearnSession>) {
  const session = await open(join(directory, 'graph.db'))
  try {
    const nodes = session.listNodes().map((node) => node.nodeId)
    return {
      nodes,
      understanding: Object.fromEntries(nodes.map((id) => [id, session.understandingOf(id)])),
      events: session.eventCount,
      pending: session.pendingSuggestions().map((suggestion) => ({
        id: suggestion.id,
        proposal: suggestion.proposal,
        proposedBy: suggestion.proposedBy,
      })),
      recall: await session.recall('why does attention need to know the order'),
    }
  } finally {
    await session.close()
  }
}

describe('the v0.1.0 golden graph', () => {
  it('reads exactly as it did', async () => {
    const expected: unknown = JSON.parse(await readFile(join(GOLDEN, 'expected.json'), 'utf8'))
    const read = await readGraph((filePath) => LearnSession.open({ filePath }))
    expect(JSON.parse(JSON.stringify(read))).toEqual(expected)
  })
})
