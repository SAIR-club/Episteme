import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CognitiveSession, GraphLockedError, copyGraph } from '@episteme/application'
import { EpistemeError } from '@episteme/core'
import { startService } from '@episteme/service'
import { openLocalStorage } from '@episteme/storage-local'
import { SqliteStorageAdapter, openSqliteStorage } from '@episteme/storage-sqlite'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * The SQLite backend (ADR 0017): the same history as JSONL, held by one owner whose lock the operating system
 * keeps, so a process killed outright leaves nothing behind.
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

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

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
    expect((refusal as GraphLockedError).holderRunning).toBe(true)
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

  it('refuses a file that is not a database, without calling it locked', async () => {
    await writeFile(graph, 'not a database at all, just some text that is long enough', 'utf8')
    const refusal = await openSqliteStorage(graph).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(Error)
    expect(refusal).not.toBeInstanceOf(GraphLockedError)
  })

  it('backs up what was saved into a file that opens as the same graph', async () => {
    await writeClaim(graph, 'Backed up')

    const source = new SqliteStorageAdapter(graph)
    await source.open()
    const backup = join(directory, 'backup.db')
    await source.backUp(backup)
    const records = source.records()
    await source.close()

    const restored = await openSqliteStorage(backup)
    expect(restored.records()).toEqual(records)
    await restored.close()
  })
})

describe('moving a graph between JSONL and SQLite', () => {
  it('imports a JSONL graph with its companion files, and exports it back unchanged', async () => {
    const jsonl = join(directory, 'learn.jsonl')
    const nodeId = await writeClaim(jsonl, 'Order matters to attention')
    const session = await CognitiveSession.open({ filePath: jsonl })
    await session.openThread({ title: 'Position encoding' })
    await session.close()

    const imported = await copyGraph(jsonl, graph)
    expect(imported.records).toBeGreaterThan(0)
    expect(imported.companions).toContain(`${graph}.threads.jsonl`)

    const inSqlite = await CognitiveSession.open({ filePath: graph })
    expect(inSqlite.listNodes().map((node) => node.nodeId)).toContain(nodeId)
    expect(inSqlite.threads().map((thread) => thread.title)).toEqual(['Position encoding'])
    await inSqlite.close()

    const exported = join(directory, 'exported.jsonl')
    expect((await copyGraph(graph, exported)).records).toBe(imported.records)
    const original = await openLocalStorage(jsonl)
    const roundTrip = await openLocalStorage(exported)
    expect(roundTrip.records()).toEqual(original.records())
    await roundTrip.close()
    await original.close()
    expect(await readFile(`${exported}.threads.jsonl`, 'utf8')).toBe(
      await readFile(`${jsonl}.threads.jsonl`, 'utf8'),
    )
  })

  it('never copies into a graph that already has a history or companion files', async () => {
    const jsonl = join(directory, 'learn.jsonl')
    await writeClaim(jsonl, 'First')
    await writeClaim(graph, 'Already here')

    await expect(copyGraph(jsonl, graph)).rejects.toThrow(/already holds a history/)
    const fresh = join(directory, 'fresh.db')
    await writeFile(`${fresh}.threads.jsonl`, '', 'utf8')
    await expect(copyGraph(jsonl, fresh)).rejects.toThrow(/already exists/)
    expect(await exists(fresh)).toBe(false)
  })

  it('refuses a missing source and copying a graph onto itself', async () => {
    await expect(copyGraph(join(directory, 'missing.jsonl'), graph)).rejects.toThrow(/no graph/)
    await writeClaim(graph, 'Here')
    await expect(copyGraph(graph, graph)).rejects.toThrow(/same graph/)
  })

  it('will not copy a graph another process holds', async () => {
    const jsonl = join(directory, 'learn.jsonl')
    await writeClaim(jsonl, 'Held')
    const holder = await CognitiveSession.open({ filePath: jsonl })
    await expect(copyGraph(jsonl, graph)).rejects.toBeInstanceOf(GraphLockedError)
    await holder.close()
  })
})
