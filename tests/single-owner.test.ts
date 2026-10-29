import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphLockedError, LearnSession } from '@episteme/application'
import { startService } from '@episteme/service'
import { openEpisteme } from '@episteme/sdk'
import { openSqliteStorage } from '@episteme/storage-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { storedRecords, writeStoredRecords } from './stored.js'

/**
 * One graph file, one owner (ADR 0008).
 *
 * Two adapters over one file each resume their own id counter and each rewrite the whole history on save, so
 * they mint the same event ids for different moments and overwrite each other without an error. These tests
 * pin the refusal that prevents it, and the release that lets a surface hand the graph to the next one.
 */

let directory: string
let filePath: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-owner-'))
  filePath = join(directory, 'graph.db')
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

describe('the storage adapter', () => {
  it('refuses a second owner of the same file, even in the same process', async () => {
    const first = await openSqliteStorage(filePath)

    const refusal = await openSqliteStorage(filePath).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(GraphLockedError)
    const locked = refusal as GraphLockedError
    expect(locked.graphPath).toBe(filePath)
    expect(locked.message).toContain(filePath)

    await first.close()
  })

  it('hands the graph over once the owner closes, with the history intact', async () => {
    const storage = await openSqliteStorage(filePath)
    const episteme = await openEpisteme(storage)
    await episteme.persist()
    await storage.save()
    await storage.close()
    const written = storedRecords(filePath)
    expect(written.length).toBeGreaterThan(0)
    // The operating system held the file, not a marker beside it, so there is nothing to clear.
    expect(await exists(`${filePath}.lock`)).toBe(false)

    const next = await openSqliteStorage(filePath)
    expect(next.records()).toHaveLength(written.length)
    await next.close()
    expect(storedRecords(filePath)).toEqual(written)
  })

  it('cannot be written through after it is closed', async () => {
    const storage = await openSqliteStorage(filePath)
    await storage.close()
    await expect(storage.save()).rejects.toThrow(/after close/)
  })

  it('keeps unrelated files independent', async () => {
    const first = await openSqliteStorage(filePath)
    const other = await openSqliteStorage(join(directory, 'other.db'))
    await other.close()
    await first.close()
  })

  it('does not stay held when the file cannot be read, so a corrupt graph is not also locked', async () => {
    await writeStoredRecords(filePath, { records: ['{"schemaVersion":1,"kind":"node"'] })
    await expect(openSqliteStorage(filePath)).rejects.toThrow(/not valid JSON/)

    // Opening it again, to put the history right, is not refused as held.
    await writeStoredRecords(filePath, { records: [] })
    await (await openSqliteStorage(filePath)).close()
  })

  it('creates a missing directory, so a fresh default path works on first use', async () => {
    const nested = join(directory, 'not', 'yet', 'there', 'graph.db')
    const storage = await openSqliteStorage(nested)
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
    await expect(startService({ port: 0, graph: filePath })).rejects.toBeInstanceOf(
      GraphLockedError,
    )
    await session.close()
  })

  it('gives the graph back when the web surface stops', async () => {
    const server = await startService({ port: 0, graph: filePath })
    await server.close()

    const session = await LearnSession.open({ filePath })
    await session.close()
  })

  it('gives the graph back when the web surface cannot start', async () => {
    const running = await startService({ port: 0, graph: join(directory, 'running.db') })

    // The port is taken, so this start fails after its session already owned the file.
    await expect(startService({ port: running.port, graph: filePath })).rejects.toThrow(
      /EADDRINUSE/,
    )
    const session = await LearnSession.open({ filePath })
    await session.close()

    await running.close()
  })
})
