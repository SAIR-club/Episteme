import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CognitiveSession } from '@episteme/application'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * A graph written by v0.1.0 opens, reduces and recalls exactly as it did (ADR 0013, step M3).
 *
 * The files in `golden/v0.1` were written by the v0.1.0 session, plus two events in legacy levels. Moving the
 * application's vocabulary into a scene profile must not change a single thing read from them.
 */

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'golden', 'v0.1')

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-golden-'))
  await cp(GOLDEN, directory, { recursive: true })
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function readGraph(open: (filePath: string) => Promise<CognitiveSession>) {
  const session = await open(join(directory, 'graph.jsonl'))
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
    const read = await readGraph((filePath) => CognitiveSession.open({ filePath }))
    expect(JSON.parse(JSON.stringify(read))).toEqual(expected)
  })
})
