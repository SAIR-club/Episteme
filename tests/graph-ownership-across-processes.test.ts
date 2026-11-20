import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GraphLockedError, openSqliteStorage } from '@episteme/storage-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const tests = dirname(fileURLToPath(import.meta.url))

/** A process that owns the graph after several saves and companion writes, until it is killed. */
async function ownerProcess(path: string): Promise<ChildProcess> {
  const script = [
    "const { openSqliteStorage } = await import('@episteme/storage-sqlite')",
    'setInterval(() => {}, 1000)',
    `const storage = await openSqliteStorage(${JSON.stringify(path)})`,
    'await storage.save()',
    "const log = storage.companion('drafts')",
    'for (let i = 0; i < 3; i++) await log.append(JSON.stringify({ i }))',
    'await storage.save()',
    "process.stdout.write('held\\n')",
  ].join('\n')
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: tests,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('held')) resolve()
    })
    child.once('exit', (code) => reject(new Error(`the owner exited early with ${String(code)}`)))
  })
  child.removeAllListeners('exit')
  return child
}

describe('one owner across processes', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'episteme-ownership-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 })
  })

  it('refuses every other opener while the owner lives, and hands over what it saved once it is killed', async () => {
    for (let round = 0; round < 5; round++) {
      const path = join(directory, `graph-${String(round)}.db`)
      const owner = await ownerProcess(path)
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(openSqliteStorage(path)).rejects.toBeInstanceOf(GraphLockedError)
      }
      const exited = new Promise((resolve) => owner.once('exit', resolve))
      owner.kill('SIGKILL')
      await exited

      const next = await openSqliteStorage(path)
      expect(await next.companion('drafts').read()).toHaveLength(3)
      await next.close()
    }
  }, 60_000)
})
