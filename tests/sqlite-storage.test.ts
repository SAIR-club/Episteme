import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CognitiveSession,
  GraphCopyInProgressError,
  GraphLockedError,
  UnfinishedGraphCopyError,
  copyGraph,
} from '@episteme/application'
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

  it('never copies over an existing graph or companion file, and leaves them as they were', async () => {
    const jsonl = join(directory, 'learn.jsonl')
    await writeClaim(jsonl, 'First')
    const kept = await writeClaim(graph, 'Already here')

    await expect(copyGraph(jsonl, graph)).rejects.toThrow(/already exists/)
    const untouched = await CognitiveSession.open({ filePath: graph })
    expect(untouched.listNodes().map((node) => node.nodeId)).toEqual([kept])
    await untouched.close()
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

  it('will not copy a graph another process holds, and leaves the target as if it had not tried', async () => {
    const jsonl = join(directory, 'learn.jsonl')
    await writeClaim(jsonl, 'Held')
    const holder = await CognitiveSession.open({ filePath: jsonl })
    await expect(copyGraph(jsonl, graph)).rejects.toBeInstanceOf(GraphLockedError)
    await holder.close()
    expect(await exists(graph)).toBe(false)
    expect((await copyGraph(jsonl, graph)).records).toBeGreaterThan(0)
  })

  it('removes only what it wrote when copying a companion file fails, so the copy can simply be run again', async () => {
    const jsonl = join(directory, 'learn.jsonl')
    const nodeId = await sourceWithThread(jsonl)

    // The threads file cannot be copied: a directory stands where it should be, so copying it is an I/O error
    // raised after the graph itself has been saved into the target.
    const threads = `${jsonl}.threads.jsonl`
    await rename(threads, `${threads}.aside`)
    await mkdir(threads)
    await expect(copyGraph(jsonl, graph)).rejects.toThrow()

    for (const path of [graph, `${graph}-wal`, `${graph}.threads.jsonl`]) {
      expect(await exists(path)).toBe(false)
    }
    await rm(threads, { recursive: true })
    await rename(`${threads}.aside`, threads)
    // The source was released again.
    const reopened = await CognitiveSession.open({ filePath: jsonl })
    await reopened.close()
    await copyGraph(jsonl, graph)
    await expectCopyOf(graph, nodeId)
  })

  for (const [which, otherSource] of [
    ['the same source', false],
    ['another source', true],
  ] as const) {
    it(`refuses a second copy into a target a copy is writing now, from ${which}, and touches nothing`, async () => {
      const jsonl = join(directory, 'learn.jsonl')
      const nodeId = await sourceWithThread(jsonl)
      const other = join(directory, 'other.jsonl')
      if (otherSource) await writeClaim(other, 'From the other source')

      let resume = (): void => undefined
      let paused = (): void => undefined
      const pause = new Promise<void>((resolve) => (paused = resolve))
      const first = copyGraph(jsonl, graph, {
        afterGraph: () => {
          paused()
          return new Promise<void>((resolve) => (resume = resolve))
        },
      })
      await pause

      // Halfway through the first copy: the graph is saved, its companion files are not yet copied.
      await expect(copyGraph(otherSource ? other : jsonl, graph)).rejects.toBeInstanceOf(
        GraphCopyInProgressError,
      )
      await expect(CognitiveSession.open({ filePath: graph })).rejects.toBeInstanceOf(
        GraphCopyInProgressError,
      )
      expect(await exists(graph)).toBe(true)

      resume()
      await first
      await expectCopyOf(graph, nodeId)
      await expect(copyGraph(otherSource ? other : jsonl, graph)).rejects.toThrow(/already exists/)
      await expectCopyOf(graph, nodeId)
    })
  }

  it('lets a failing copy remove only its own files, after the other copy was refused', async () => {
    const jsonl = join(directory, 'learn.jsonl')
    const nodeId = await sourceWithThread(jsonl)
    let fail = (): void => undefined
    let paused = (): void => undefined
    const pause = new Promise<void>((resolve) => (paused = resolve))
    const first = copyGraph(jsonl, graph, {
      afterGraph: () => {
        paused()
        return new Promise<void>((_, reject) => (fail = () => reject(new Error('disk full'))))
      },
    })
    await pause
    await expect(copyGraph(jsonl, graph)).rejects.toBeInstanceOf(GraphCopyInProgressError)

    fail()
    await expect(first).rejects.toThrow('disk full')
    expect(await exists(graph)).toBe(false)
    // Free again: a new copy runs to the end.
    await copyGraph(jsonl, graph)
    await expectCopyOf(graph, nodeId)
  })

  it('recovers from an export whose process was killed part way: refused until rerun, then started over', async () => {
    const nodeId = await sourceWithThread(graph)
    const out = join(directory, 'out.jsonl')
    await killCopyAfterGraph(graph, out)

    // The graph is saved, the companion files are not: refused as unfinished, not opened as whole. The killed
    // copy also left the target's own lock file, which is on its record.
    expect(await exists(out)).toBe(true)
    expect(await exists(`${out}.lock`)).toBe(true)
    expect(await exists(`${out}.threads.jsonl`)).toBe(false)
    await expect(CognitiveSession.open({ filePath: out })).rejects.toBeInstanceOf(
      UnfinishedGraphCopyError,
    )
    await expect(copyGraph(out, join(directory, 'onward.db'))).rejects.toBeInstanceOf(
      UnfinishedGraphCopyError,
    )

    const rerun = await copyGraph(graph, out)
    expect(rerun.recoveredFrom).toBe(resolve(graph))
    await expectCopyOf(out, nodeId)
  })

  it('recovers from an import killed part way once the JSONL source’s own stale lock is removed by hand', async () => {
    const jsonl = join(directory, 'learn.jsonl')
    const nodeId = await sourceWithThread(jsonl)
    await killCopyAfterGraph(jsonl, graph)
    await expect(CognitiveSession.open({ filePath: graph })).rejects.toBeInstanceOf(
      UnfinishedGraphCopyError,
    )

    // A JSONL graph's lock is a file, so the killed copy left the source locked, as any killed JSONL owner does.
    // The rerun still clears what the killed copy wrote into the target before it reaches the locked source.
    await expect(copyGraph(jsonl, graph)).rejects.toBeInstanceOf(GraphLockedError)
    expect(await exists(graph)).toBe(false)
    await rm(`${jsonl}.lock`)

    await copyGraph(jsonl, graph)
    await expectCopyOf(graph, nodeId)
  })

  it('starts over from another source after a killed copy, removing only what the killed copy wrote', async () => {
    await sourceWithThread(graph)
    const out = join(directory, 'out.jsonl')
    const other = join(directory, 'other.db')
    const otherId = await writeClaim(other, 'From the other source')
    await killCopyAfterGraph(graph, out)

    const rerun = await copyGraph(other, out)
    expect(rerun.recoveredFrom).toBe(resolve(graph))
    const session = await CognitiveSession.open({ filePath: out })
    expect(session.listNodes().map((node) => node.nodeId)).toEqual([otherId])
    expect(session.threads()).toEqual([])
    await session.close()
  })

  it('removes nothing when the record of a killed copy names a file outside its target', async () => {
    await sourceWithThread(graph)
    const out = join(directory, 'out.jsonl')
    await killCopyAfterGraph(graph, out)
    const bystander = join(directory, 'bystander.txt')
    await writeFile(bystander, 'not the copy’s', 'utf8')

    const record = new Database(`${out}.copying`)
    const value = JSON.parse(
      (record.prepare('SELECT value FROM record WHERE id = 1').get() as { value: string }).value,
    ) as { files: string[] }
    value.files.push(resolve(bystander))
    record.prepare('UPDATE record SET value = ? WHERE id = 1').run(JSON.stringify(value))
    record.close()

    await expect(copyGraph(graph, out)).rejects.toThrow(/cannot be checked/)
    expect(await exists(bystander)).toBe(true)
    expect(await exists(out)).toBe(true)
  })
})

/** A graph with one claim and one thread, so it has a companion file. Returns the claim’s id. */
async function sourceWithThread(path: string): Promise<string> {
  const nodeId = await writeClaim(path, 'Order matters to attention')
  const session = await CognitiveSession.open({ filePath: path })
  await session.openThread({ title: 'Position encoding' })
  await session.close()
  return nodeId
}

/** Opens the copy and checks it is the whole source: its claim, its thread, and nothing it should not have. */
async function expectCopyOf(path: string, nodeId: string): Promise<void> {
  const session = await CognitiveSession.open({ filePath: path })
  expect(session.listNodes().map((node) => node.nodeId)).toEqual([nodeId])
  expect(session.threads().map((thread) => thread.title)).toEqual(['Position encoding'])
  await session.close()
}

/**
 * Runs a real copy in a child process and kills it outright (`SIGKILL`) once the graph is saved into the target
 * and before the companion files are copied.
 */
async function killCopyAfterGraph(from: string, to: string): Promise<void> {
  const tests = fileURLToPath(new URL('.', import.meta.url))
  const script = [
    "import { copyGraph } from '@episteme/application'",
    // A pending promise alone would let the child exit; this keeps it running until it is killed.
    'setInterval(() => {}, 1000)',
    `await copyGraph(${JSON.stringify(from)}, ${JSON.stringify(to)}, {`,
    "  afterGraph: () => { process.stdout.write('paused\\n'); return new Promise(() => {}) },",
    '})',
  ].join('\n')
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: tests,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('paused')) resolve()
    })
    child.on('exit', (code) => reject(new Error(`the copy exited early with ${String(code)}`)))
  })
  // While it runs, the target is a copy in progress.
  await expect(copyGraph(from, to)).rejects.toBeInstanceOf(GraphCopyInProgressError)
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGKILL')
  await exited
}
