import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { appendFile, copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CognitiveSession,
  GraphConversionError,
  UnreadableGraphError,
  convertGraph,
  currentChannel,
} from '@episteme/application'
import { startService } from '@episteme/service'
import {
  SQLITE_FORMAT_VERSION,
  convertLegacyGraph,
  openSqliteStorage,
} from '@episteme/storage-sqlite'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Carrying an older graph into a new file. The fixture was written by the build that kept graphs in JSONL files
 * (`older-graph/generate.mjs`), with what that build showed for it, so the conversion is held to the older build's
 * own reading and not to this one's idea of it.
 */

const FIXTURE = fileURLToPath(new URL('./older-graph/', import.meta.url))
const COMPANIONS = ['.suggestions.jsonl', '.sources.jsonl', '.threads.jsonl', '.scene.jsonl']

interface Expected {
  readonly nodes: readonly { readonly nodeId: string }[]
  readonly understanding: readonly unknown[]
  readonly history: readonly unknown[]
  readonly sources: readonly unknown[]
  readonly threads: readonly unknown[]
  readonly pending: readonly unknown[]
  readonly reviews: readonly unknown[]
  readonly delegations: readonly unknown[]
  readonly sceneRecords: readonly unknown[]
}
const EXPECTED = JSON.parse(readFileSync(join(FIXTURE, 'expected.json'), 'utf8')) as Expected

let directory: string
let older: string
let target: string

/** Every file in the directory, by name, with what is in it. */
function everything(): Record<string, string> {
  return Object.fromEntries(
    readdirSync(directory)
      .sort()
      .map((name) => [
        name,
        createHash('sha256')
          .update(readFileSync(join(directory, name)))
          .digest('hex'),
      ]),
  )
}

async function copyCompanions(to: string): Promise<void> {
  for (const suffix of COMPANIONS) {
    await copyFile(join(FIXTURE, `learn.jsonl${suffix}`), `${to}${suffix}`)
  }
}

function recordLines(): string[] {
  return readFileSync(join(FIXTURE, 'learn.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
}

/**
 * The older SQLite layout, as a killed process leaves it: everything committed is still in the log beside the file.
 * The copies are taken while the connection is open, so nothing has been folded in.
 */
async function olderSqliteWithLiveLog(to: string): Promise<void> {
  const original = join(directory, 'writing', 'graph.db')
  mkdirSync(join(directory, 'writing'))
  const db = new Database(original)
  db.pragma('journal_mode = WAL')
  db.pragma('wal_autocheckpoint = 0')
  db.exec('CREATE TABLE records (seq INTEGER PRIMARY KEY, body TEXT NOT NULL)')
  db.pragma('user_version = 1')
  const insert = db.prepare('INSERT INTO records (seq, body) VALUES (?, ?)')
  recordLines().forEach((line, index) => insert.run(index + 1, line))
  await copyFile(original, to)
  await copyFile(`${original}-wal`, `${to}-wal`)
  db.close()
  await rm(join(directory, 'writing'), { recursive: true, force: true })
}

/** Reads a new graph the way the application does and holds it to what the older build showed. */
async function expectTheOlderBuildsReading(graph: string): Promise<void> {
  const session = await CognitiveSession.open({ filePath: graph })
  try {
    const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null))
    const nodes = session.listNodes()
    expect(plain(nodes)).toMatchObject(EXPECTED.nodes)
    expect(nodes.map(({ nodeId }) => plain(session.understandingOf(nodeId)))).toMatchObject(
      EXPECTED.understanding,
    )
    expect(nodes.map(({ nodeId }) => plain(session.historyOf(nodeId)))).toMatchObject(
      EXPECTED.history,
    )
    expect(plain(session.sources())).toMatchObject(EXPECTED.sources)
    expect(plain(session.threads().map(({ id }) => session.threadView(id)))).toMatchObject(
      EXPECTED.threads,
    )
    expect(plain(session.pendingSuggestions())).toMatchObject(EXPECTED.pending)
    // The older build named the review channel `learn-review`; it now reads under its current name, `review`, and
    // the stored record keeps the old one (`channel-names.test.ts`). Nothing else about a review changes.
    expect(plain(session.reviews())).toMatchObject(
      (EXPECTED.reviews as { readonly channel: string }[]).map((review) => ({
        ...review,
        channel: currentChannel(review.channel),
      })),
    )
    expect(plain(session.delegations())).toMatchObject(EXPECTED.delegations)
    expect(plain(session.sceneRecords('learn'))).toMatchObject(EXPECTED.sceneRecords)
  } finally {
    await session.close()
  }
}

function refusal(code: string): unknown {
  return expect.objectContaining({ name: GraphConversionError.name, code })
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-convert-'))
  older = join(directory, 'learn.jsonl')
  target = join(directory, 'learn.db')
  await copyFile(join(FIXTURE, 'learn.jsonl'), older)
  await copyCompanions(older)
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('the fixture itself', () => {
  it('has something of everything the conversion has to carry', () => {
    expect(EXPECTED.nodes.length).toBeGreaterThan(1)
    expect(EXPECTED.sources).toHaveLength(1)
    expect(EXPECTED.threads).toHaveLength(1)
    expect(EXPECTED.pending.length).toBeGreaterThan(0)
    expect(EXPECTED.reviews.length).toBeGreaterThan(0)
    expect(EXPECTED.delegations).toHaveLength(1)
    expect(EXPECTED.sceneRecords).toHaveLength(1)
    const kinds = new Set(
      recordLines().map((line) => (JSON.parse(line) as { readonly kind: string }).kind),
    )
    for (const kind of ['node', 'edge', 'branch', 'event']) expect(kinds).toContain(kind)
  })
})

describe('a JSONL graph', () => {
  it('comes over with its relations, history, sources, drafts, threads and scene records', async () => {
    const done = await convertGraph(older, target)

    expect(done.sourceFormat).toBe('jsonl')
    const kinds = recordLines().map((line) => (JSON.parse(line) as { readonly kind: string }).kind)
    expect(done.records.node).toBe(kinds.filter((kind) => kind === 'node').length)
    expect(done.records.edge).toBe(kinds.filter((kind) => kind === 'edge').length)
    expect(done.records.event).toBe(kinds.filter((kind) => kind === 'event').length)
    expect(Object.keys(done.companions).sort()).toEqual([
      'scene-records',
      'sources',
      'suggestions',
      'threads',
    ])
    await expectTheOlderBuildsReading(target)
  })

  it('keeps every record and companion body exactly as it was', async () => {
    await convertGraph(older, target)

    const db = new Database(target, { readonly: true })
    expect(db.pragma('user_version', { simple: true })).toBe(SQLITE_FORMAT_VERSION)
    const bodies = db.prepare('SELECT body FROM records ORDER BY seq').all() as { body: string }[]
    expect(bodies.map((row) => row.body)).toEqual(recordLines())
    const log = (name: string): string[] =>
      (
        db.prepare('SELECT body FROM companions WHERE name = ? ORDER BY seq').all(name) as {
          body: string
        }[]
      ).map((row) => row.body)
    const lines = (suffix: string): string[] =>
      readFileSync(`${older}${suffix}`, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
    expect(log('suggestions')).toEqual(lines('.suggestions.jsonl'))
    expect(log('sources')).toEqual(lines('.sources.jsonl'))
    expect(log('threads')).toEqual(lines('.threads.jsonl'))
    expect(log('scene-records')).toEqual(lines('.scene.jsonl'))
    db.close()
  })

  it('leaves the older files byte for byte, adds nothing beside them, and leaves one new file', async () => {
    const before = everything()
    const done = await convertGraph(older, target)

    const after = everything()
    expect(after[target.slice(directory.length + 1)]).toBeDefined()
    delete after[target.slice(directory.length + 1)]
    expect(after).toEqual(before)
    expect(Object.values(done.source).sort()).toEqual(Object.values(before).sort())
  })

  it('stays apart from the new graph afterwards', async () => {
    await convertGraph(older, target)
    const before = readFileSync(older)

    const session = await CognitiveSession.open({ filePath: target })
    await session.addNode({ label: '转换之后才学到的', kind: 'claim' })
    await session.close()

    expect(readFileSync(older).equals(before)).toBe(true)
    const again = await CognitiveSession.open({ filePath: target })
    expect(again.listNodes().map(({ label }) => label)).toContain('转换之后才学到的')
    await again.close()
  })

  it('opens under the service once converted, where the older file alone is refused', async () => {
    await expect(startService({ port: 0, graph: target })).rejects.toBeInstanceOf(
      UnreadableGraphError,
    )
    await convertGraph(older, target)
    const service = await startService({ port: 0, graph: target })
    await service.close()
  })

  it('needs only the graph: a graph without companion files converts too', async () => {
    const alone = join(directory, 'alone.jsonl')
    await copyFile(older, alone)
    const done = await convertGraph(alone, join(directory, 'alone.db'))
    expect(done.companions).toEqual({})
  })
})

describe('a format 1 SQLite graph', () => {
  let oldDb: string

  beforeEach(async () => {
    oldDb = join(directory, 'old.db')
    await olderSqliteWithLiveLog(oldDb)
    await copyCompanions(oldDb)
  })

  it('comes over from what its log holds, without folding the log into it', async () => {
    expect(readFileSync(`${oldDb}-wal`).length).toBeGreaterThan(0)
    const before = everything()

    const done = await convertGraph(oldDb, target)

    expect(done.sourceFormat).toBe('sqlite-1')
    await expectTheOlderBuildsReading(target)
    const after = everything()
    delete after['learn.db']
    expect(after).toEqual(before)
    expect(existsSync(`${oldDb}-shm`)).toBe(false)
  })

  it('is refused by the storage with its file and log exactly as they were', async () => {
    const before = everything()

    await expect(openSqliteStorage(oldDb)).rejects.toBeInstanceOf(UnreadableGraphError)
    await expect(openSqliteStorage(oldDb)).rejects.toThrow(/format version 1/)
    await expect(CognitiveSession.open({ filePath: oldDb })).rejects.toThrow(/nothing was changed/)
    await expect(startService({ port: 0, graph: oldDb })).rejects.toThrow(/graph convert/)

    expect(everything()).toEqual(before)
  })
})

describe('what is refused, leaving no target and the older files as they were', () => {
  async function expectRefused(
    from: string,
    to: string,
    code: string,
    run: (from: string, to: string) => Promise<unknown> = convertGraph,
  ): Promise<void> {
    const before = everything()
    await expect(run(from, to)).rejects.toEqual(refusal(code))
    expect(everything()).toEqual(before)
  }

  it('a target that already exists, which keeps what it held', async () => {
    writeFileSync(target, 'held by something else')
    await expectRefused(older, target, 'target_exists')
    expect(readFileSync(target, 'utf8')).toBe('held by something else')
  })

  it('a target with a log beside it', async () => {
    writeFileSync(`${target}-wal`, 'a log of something')
    await expectRefused(older, target, 'target_exists')
  })

  it('a target that appears while the conversion runs, which keeps what it held', async () => {
    const before = everything()
    await expect(
      convertLegacyGraph(older, target, {
        verify: () => {
          writeFileSync(target, 'got there first')
          return Promise.resolve()
        },
      }),
    ).rejects.toEqual(refusal('target_exists'))
    expect(readFileSync(target, 'utf8')).toBe('got there first')
    const after = everything()
    delete after['learn.db']
    expect(after).toEqual(before)
  })

  it('the same file twice', async () => {
    await expectRefused(older, older, 'same_file')
  })

  it('a graph that is not there', async () => {
    await expectRefused(join(directory, 'nothing.jsonl'), target, 'no_source')
  })

  it('a record it cannot read, rather than a shorter history', async () => {
    await appendFile(older, '{"schemaVersion":1,"kind":"nod')
    await expectRefused(older, target, 'unreadable')
  })

  it('a record of a schema this build does not read', async () => {
    await appendFile(older, '{"schemaVersion":99,"kind":"node"}\n')
    await expectRefused(older, target, 'unreadable')
  })

  it('a companion line it cannot read', async () => {
    await appendFile(`${older}.threads.jsonl`, '{"not json\n')
    await expectRefused(older, target, 'unreadable')
  })

  it('a companion record its store does not read, found before anything lands', async () => {
    await appendFile(`${older}.sources.jsonl`, '{"schemaVersion":99}\n')
    await expectRefused(older, target, 'mismatch')
  })

  it('a graph an older process still has open', async () => {
    writeFileSync(`${older}.lock`, `${JSON.stringify({ pid: process.pid })}\n`)
    await expectRefused(older, target, 'source_open')
  })

  it('a graph an older copy did not finish', async () => {
    const copying = new Database(`${older}.copying`)
    copying.exec('CREATE TABLE record (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
    copying.prepare('INSERT INTO record (id, value) VALUES (1, ?)').run('{"files":[]}')
    copying.close()
    await expectRefused(older, target, 'unfinished_copy')
  })

  it('a graph already in this format, which has nothing to convert', async () => {
    const current = join(directory, 'current.db')
    const storage = await openSqliteStorage(current)
    await storage.close()
    await expectRefused(current, target, 'not_older_graph')
  })

  it('a SQLite file of something else', async () => {
    const foreign = join(directory, 'foreign.db')
    const db = new Database(foreign)
    db.exec('CREATE TABLE photos (id INTEGER PRIMARY KEY)')
    db.close()
    await expectRefused(foreign, target, 'not_older_graph')
  })

  it('an older file that changes while it is read', async () => {
    const before = everything()
    await expect(
      convertLegacyGraph(older, target, {
        verify: () => appendFile(`${older}.scene.jsonl`, '\n'),
      }),
    ).rejects.toEqual(refusal('source_changed'))
    expect(existsSync(target)).toBe(false)
    expect(Object.keys(everything())).toEqual(Object.keys(before))
  })
})

describe('a lock left behind by a process that is gone', () => {
  it('does not stop the conversion, is reported, and stays where it was', async () => {
    const lock = `${older}.lock`
    // No process has this id: Windows and Linux both keep process ids far below it.
    writeFileSync(lock, `${JSON.stringify({ pid: 2 ** 30 })}\n`)
    const before = readFileSync(lock)

    const done = await convertGraph(older, target)

    expect(done.notes.join(' ')).toContain('learn.jsonl.lock')
    expect(readFileSync(lock).equals(before)).toBe(true)
  })
})
