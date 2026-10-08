import { spawnSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphLockedError, LearnSession } from '@episteme/application'
import { startLearnServer } from '@episteme/app-learn/server'
import { openEpisteme } from '@episteme/sdk'
import { openLocalStorage } from '@episteme/storage-local'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * One graph file, one owner (ADR 0008).
 *
 * Two adapters over one file each resume their own id counter and each rewrite the whole file on save, so
 * they mint the same event ids for different moments and overwrite each other without an error. These tests
 * pin the refusal that prevents it, and the release that lets a surface hand the graph to the next one.
 */

let directory: string
let filePath: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-owner-'))
  filePath = join(directory, 'graph.jsonl')
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

/** The id of a process that has certainly exited: one that was started and waited for. */
function exitedPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''])
  if (child.pid === undefined) throw new Error('could not start a child process')
  return child.pid
}

describe('the storage adapter', () => {
  it('refuses a second owner of the same file, even in the same process', async () => {
    const first = await openLocalStorage(filePath)

    const refusal = await openLocalStorage(filePath).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(GraphLockedError)
    const locked = refusal as GraphLockedError
    expect(locked.holderPid).toBe(process.pid)
    expect(locked.holderRunning).toBe(true)
    expect(locked.message).toContain(String(process.pid))

    await first.close()
  })

  it('hands the graph over once the owner closes, with the history intact', async () => {
    const storage = await openLocalStorage(filePath)
    const episteme = await openEpisteme(storage)
    await episteme.persist()
    await storage.save()
    const written = await readFile(filePath, 'utf8')
    await storage.close()
    expect(await exists(storage.lockPath)).toBe(false)

    const next = await openLocalStorage(filePath)
    expect(await readFile(filePath, 'utf8')).toBe(written)
    await next.close()
  })

  it('cannot be written through after it is closed', async () => {
    const storage = await openLocalStorage(filePath)
    await storage.close()
    await expect(storage.save()).rejects.toThrow(/after close/)
  })

  it('keeps unrelated files independent', async () => {
    const first = await openLocalStorage(filePath)
    const other = await openLocalStorage(join(directory, 'other.jsonl'))
    await other.close()
    await first.close()
  })

  it('does not reclaim a lock left by a process that is gone, and says how to remove it', async () => {
    const pid = exitedPid()
    await writeFile(`${filePath}.lock`, `${JSON.stringify({ pid })}\n`, 'utf8')

    const refusal = await openLocalStorage(filePath).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(GraphLockedError)
    const locked = refusal as GraphLockedError
    expect(locked.holderPid).toBe(pid)
    expect(locked.holderRunning).toBe(false)
    expect(locked.message).toContain(locked.lockPath)

    // Still there: removing it is the learner's decision, because only they know nothing else uses the file.
    expect(await exists(`${filePath}.lock`)).toBe(true)
  })

  it('treats an unreadable lock as held rather than as absent', async () => {
    await writeFile(`${filePath}.lock`, 'not json', 'utf8')
    const refusal = await openLocalStorage(filePath).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(GraphLockedError)
    expect((refusal as GraphLockedError).holderPid).toBeUndefined()
  })

  it('releases the lock when the file cannot be read, so a corrupt graph does not also stay locked', async () => {
    await writeFile(filePath, '{"schemaVersion":1,"kind":"node"\n', 'utf8')
    await expect(openLocalStorage(filePath)).rejects.toThrow(/not valid JSON/)
    expect(await exists(`${filePath}.lock`)).toBe(false)
  })

  it('creates a missing directory, so a fresh default path works on first use', async () => {
    const nested = join(directory, 'not', 'yet', 'there', 'graph.jsonl')
    const storage = await openLocalStorage(nested)
    await storage.save()
    expect(await exists(nested)).toBe(true)
    await storage.close()
  })
})

describe('the surfaces', () => {
  it('lets one session own a graph at a time, and releases it on close', async () => {
    const first = await LearnSession.open({ filePath })
    await expect(LearnSession.open({ filePath })).rejects.toBeInstanceOf(GraphLockedError)

    await first.close()
    const second = await LearnSession.open({ filePath })
    await second.close()
  })

  it('will not start a web surface over a graph another surface owns', async () => {
    const session = await LearnSession.open({ filePath })
    await expect(startLearnServer({ port: 0, filePath })).rejects.toBeInstanceOf(GraphLockedError)
    await session.close()
  })

  it('gives the graph back when the web surface stops', async () => {
    const server = await startLearnServer({ port: 0, filePath })
    await server.close()

    const session = await LearnSession.open({ filePath })
    await session.close()
  })

  it('gives the graph back when the web surface cannot start', async () => {
    const running = await startLearnServer({ port: 0, filePath: join(directory, 'running.jsonl') })

    // The port is taken, so this start fails after its session already owned the file.
    await expect(startLearnServer({ port: running.port, filePath })).rejects.toThrow(/EADDRINUSE/)
    const session = await LearnSession.open({ filePath })
    await session.close()

    await running.close()
  })
})
