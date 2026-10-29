import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CognitiveSession, GraphLockedError } from '@episteme/application'
import { EpistemeError } from '@episteme/core'
import { startService } from '@episteme/service'
import {
  SQLITE_FORMAT_VERSION,
  SqliteStorageAdapter,
  openSqliteStorage,
} from '@episteme/storage-sqlite'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * The SQLite backend (ADR 0017, ADR 0018): a graph and the logs kept with it in one file, held by one owner whose
 * lock the operating system keeps, so a process killed outright leaves nothing behind.
 */

let directory: string
let graph: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-sqlite-'))
  graph = join(directory, 'graph.db')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** Opens a session over `path`, adds one claim and records it, then closes. Returns the claim's id. */
async function writeClaim(path: string, label: string): Promise<string> {
  const session = await CognitiveSession.open({ filePath: path })
  const node = await session.addNode({ label, kind: 'claim' })
  await session.record(node.nodeId, { confidence: 'medium' })
  await session.close()
  return node.nodeId
}

describe('a graph kept in SQLite', () => {
  it('survives a restart: what was recorded is read back by a new session', async () => {
    const nodeId = await writeClaim(graph, 'Attention needs position information')

    const reopened = await CognitiveSession.open({ filePath: graph })
    expect(reopened.listNodes().map((node) => node.nodeId)).toContain(nodeId)
    expect(reopened.progress().items.find((item) => item.nodeId === nodeId)?.dimensions).toEqual([
      { id: 'confidence', level: 'medium' },
    ])
    await reopened.close()
  })

  it('has one owner: a second session, or a service, over the same file is refused', async () => {
    const first = await CognitiveSession.open({ filePath: graph })

    const refusal = await CognitiveSession.open({ filePath: graph }).catch(
      (error: unknown) => error,
    )
    expect(refusal).toBeInstanceOf(GraphLockedError)
    expect((refusal as GraphLockedError).graphPath).toBe(graph)
    await expect(startService({ port: 0, graph })).rejects.toBeInstanceOf(GraphLockedError)

    await first.close()
    const second = await CognitiveSession.open({ filePath: graph })
    await second.close()
  })

  it('is given up by a process killed outright, keeping what that process saved', async () => {
    const tests = fileURLToPath(new URL('.', import.meta.url))
    const script = [
      "import { CognitiveSession } from '@episteme/application'",
      `const session = await CognitiveSession.open({ filePath: ${JSON.stringify(graph)} })`,
      "const node = await session.addNode({ label: 'Saved before the kill', kind: 'claim' })",
      'process.stdout.write(`ready ${node.nodeId}\\n`)',
      'setInterval(() => {}, 1000)',
    ].join('\n')
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: tests,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const nodeId = await new Promise<string>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        const match = /ready (\S+)/.exec(chunk.toString())
        if (match?.[1] !== undefined) resolve(match[1])
      })
      child.on('exit', (code) => reject(new Error(`the child exited early with ${String(code)}`)))
    })
    // While it runs, it owns the graph.
    await expect(CognitiveSession.open({ filePath: graph })).rejects.toBeInstanceOf(
      GraphLockedError,
    )

    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGKILL')
    await exited

    const session = await CognitiveSession.open({ filePath: graph })
    expect(session.listNodes().map((node) => node.nodeId)).toContain(nodeId)
    await session.close()
  })

  it('refuses a file in a layout it does not read, and leaves it free', async () => {
    const db = new Database(graph)
    db.pragma('user_version = 7')
    db.close()

    const refusal = await openSqliteStorage(graph).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(EpistemeError)
    expect((refusal as Error).message).toContain('format version 7')
    // Nothing was left open: the file can be opened again at once.
    const again = new Database(graph, { timeout: 0 })
    again.exec('BEGIN EXCLUSIVE; COMMIT')
    again.close()
  })

  it('refuses a file of the earlier layout, which kept no companion logs, rather than misreading it', async () => {
    const db = new Database(graph)
    db.exec('CREATE TABLE records (seq INTEGER PRIMARY KEY, body TEXT NOT NULL)')
    db.pragma('user_version = 1')
    db.close()

    const refusal = await openSqliteStorage(graph).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(EpistemeError)
    expect((refusal as Error).message).toContain('format version 1')
    expect((refusal as Error).message).toContain(`version ${SQLITE_FORMAT_VERSION}`)
  })

  it('refuses a file that is not a database, without calling it locked', async () => {
    await writeFile(graph, 'not a database at all, just some text that is long enough', 'utf8')
    const refusal = await openSqliteStorage(graph).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(Error)
    expect(refusal).not.toBeInstanceOf(GraphLockedError)
  })

  it('backs up what was saved, companion logs included, into a file that opens as the same graph', async () => {
    await writeClaim(graph, 'Backed up')

    const source = new SqliteStorageAdapter(graph)
    await source.open()
    await source.companion('drafts').append('{"draft":1}')
    const backup = join(directory, 'backup.db')
    await source.backUp(backup)
    const records = source.records()
    await source.close()

    const restored = await openSqliteStorage(backup)
    expect(restored.records()).toEqual(records)
    expect(await restored.companion('drafts').read()).toEqual(['{"draft":1}'])
    await restored.close()
  })
})

describe('a companion log', () => {
  it('keeps what is appended in the order it was appended', async () => {
    const storage = await openSqliteStorage(graph)
    const log = storage.companion('drafts')
    expect(await log.read()).toEqual([])

    for (const body of ['b', 'a', 'c']) await log.append(body)

    expect(await log.read()).toEqual(['b', 'a', 'c'])
    await storage.close()
  })

  it('replaces every body at once, or none of them', async () => {
    const storage = await openSqliteStorage(graph)
    const log = storage.companion('drafts')
    await log.append('one')
    await log.append('two')

    await log.replace(['x', 'y'])
    expect(await log.read()).toEqual(['x', 'y'])

    // The second body cannot be stored, after the first already was: the log is as it was before.
    await expect(log.replace(['z', null as unknown as string])).rejects.toThrow()
    expect(await log.read()).toEqual(['x', 'y'])

    await log.replace([])
    expect(await log.read()).toEqual([])
    await storage.close()
  })

  it('keeps each log apart from the others, and from the graph history', async () => {
    const storage = await openSqliteStorage(graph)
    const drafts = storage.companion('drafts')
    const sources = storage.companion('sources')
    await drafts.append('d1')
    await sources.append('s1')
    await drafts.append('d2')
    await drafts.replace(['d3'])

    expect(await drafts.read()).toEqual(['d3'])
    expect(await sources.read()).toEqual(['s1'])
    // Saving the history writes the records alone.
    await storage.save()
    expect(await drafts.read()).toEqual(['d3'])
    expect(storage.records()).toEqual([])
    await storage.close()
  })

  it('is still there when the graph is opened again', async () => {
    const first = await openSqliteStorage(graph)
    await first.companion('drafts').append('kept')
    await first.companion('sources').append('also kept')
    await first.close()

    const second = await openSqliteStorage(graph)
    expect(await second.companion('drafts').read()).toEqual(['kept'])
    expect(await second.companion('sources').read()).toEqual(['also kept'])
    await second.close()
  })

  it('cannot be used once the graph is closed, nor asked for', async () => {
    const storage = await openSqliteStorage(graph)
    const log = storage.companion('drafts')
    await log.append('before')
    await storage.close()

    await expect(log.read()).rejects.toThrow(/after its graph was closed/)
    await expect(log.append('after')).rejects.toThrow(/after its graph was closed/)
    await expect(log.replace([])).rejects.toThrow(/after its graph was closed/)
    expect(() => storage.companion('drafts')).toThrow(/after close/)
  })

  it('has a name of lowercase words, so a store cannot ask for any other', async () => {
    const storage = await openSqliteStorage(graph)
    expect(() => storage.companion('Drafts')).toThrow(/not a companion log name/)
    expect(() => storage.companion('')).toThrow(/not a companion log name/)
    await storage.close()
  })
})
