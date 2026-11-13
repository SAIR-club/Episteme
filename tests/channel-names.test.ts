import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CognitiveSession, convertGraph, currentChannel } from '@episteme/application'
import { type EpistemeService, startService } from '@episteme/service'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * The review channel is now `review` and a session's own events are `session`, as on the team's main line.
 * Graphs already hold `learn-review` and `learn-surface`; those records are read under the new name and never
 * rewritten. The fixture is the older build's graph (`older-graph/`), whose two reviews say `learn-review`.
 */

const FIXTURE = fileURLToPath(new URL('./older-graph/', import.meta.url))
const COMPANIONS = ['.suggestions.jsonl', '.sources.jsonl', '.threads.jsonl', '.scene.jsonl']

let directory: string
let graph: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-channels-'))
  const older = join(directory, 'learn.jsonl')
  await copyFile(join(FIXTURE, 'learn.jsonl'), older)
  for (const suffix of COMPANIONS) {
    await copyFile(join(FIXTURE, `learn.jsonl${suffix}`), `${older}${suffix}`)
  }
  graph = join(directory, 'learn.db')
  await convertGraph(older, graph)
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** The review bodies as stored, oldest first. */
function storedReviews(): { readonly channel: string; readonly suggestionId: string }[] {
  const db = new Database(graph, { readonly: true })
  try {
    return (
      db.prepare("SELECT body FROM companions WHERE name = 'suggestions' ORDER BY seq").all() as {
        body: string
      }[]
    )
      .map(
        (row) =>
          JSON.parse(row.body) as {
            kind: string
            review?: { channel: string; suggestionId: string }
          },
      )
      .flatMap((record) =>
        record.kind === 'review' && record.review !== undefined ? [record.review] : [],
      )
  } finally {
    db.close()
  }
}

describe('channel names', () => {
  it('maps only the earlier name', () => {
    expect(currentChannel('learn-review')).toBe('review')
    expect(currentChannel('review')).toBe('review')
    expect(currentChannel('mcp-elicitation')).toBe('mcp-elicitation')
    expect(currentChannel('delegation')).toBe('delegation')
  })

  it('reads an older review under its current name and leaves the stored record as it was', async () => {
    expect(storedReviews().map((review) => review.channel)).toEqual([
      'learn-review',
      'learn-review',
    ])

    const session = await CognitiveSession.open({ filePath: graph })
    try {
      expect(session.reviews().map((review) => review.channel)).toEqual(['review', 'review'])
    } finally {
      await session.close()
    }

    expect(storedReviews().map((review) => review.channel)).toEqual([
      'learn-review',
      'learn-review',
    ])
  })

  it('writes the current names: `review` for a decision, `session` for a recorded level', async () => {
    const session = await CognitiveSession.open({ filePath: graph })
    try {
      const [draft] = session.pendingSuggestions()
      expect(draft).toBeDefined()
      // An SDK caller that still passes the earlier name gets the current one written.
      const decided = await session.decide(draft!.id, { action: 'dismiss' }, 'learn-review')
      expect(decided.ok).toBe(true)

      const node = await session.addNode({ label: '改名之后记下的', kind: 'claim' })
      await session.record(node.nodeId, { confidence: 'medium' })
      expect(session.historyOf(node.nodeId)?.at(-1)?.source).toBe('session')
    } finally {
      await session.close()
    }

    expect(storedReviews().map((review) => review.channel)).toEqual([
      'learn-review',
      'learn-review',
      'review',
    ])
  })

  describe('through the service', () => {
    let service: EpistemeService
    let open = false

    beforeEach(async () => {
      service = await startService({ port: 0, graph })
      open = true
    })

    afterEach(async () => {
      if (open) await service.close()
    })

    async function reviewsFor(channel: string): Promise<string[]> {
      const response = await fetch(`${service.apiUrl}/reviews?channel=${channel}`)
      expect(response.status).toBe(200)
      const body = (await response.json()) as { reviews: { suggestionId: string }[] }
      return body.reviews.map((review) => review.suggestionId)
    }

    it('finds older and newer reviews under either name', async () => {
      const pending = await fetch(`${service.apiUrl}/suggestions`)
      const { suggestions } = (await pending.json()) as { suggestions: { id: string }[] }
      const draft = suggestions[0]
      expect(draft).toBeDefined()
      const decided = await fetch(`${service.apiUrl}/suggestions/decide`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(service.humanToken === undefined
            ? {}
            : { authorization: `Bearer ${service.humanToken}` }),
        },
        body: JSON.stringify({ id: draft!.id, action: 'dismiss' }),
      })
      expect(decided.status).toBe(200)

      // The service holds the file exclusively, so what is stored is read after it closes.
      const unfiltered = await fetch(`${service.apiUrl}/reviews`)
      const all = (
        (await unfiltered.json()) as { reviews: { suggestionId: string }[] }
      ).reviews.map((review) => review.suggestionId)
      expect(all).toHaveLength(3)
      expect(all).toContain(draft!.id)
      expect(await reviewsFor('review')).toEqual(all)
      expect(await reviewsFor('learn-review')).toEqual(all)
      expect(await reviewsFor('delegation')).toEqual([])

      await service.close()
      open = false
      expect(storedReviews().map((review) => review.channel)).toEqual([
        'learn-review',
        'learn-review',
        'review',
      ])
    })
  })
})
