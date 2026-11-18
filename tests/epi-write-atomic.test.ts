import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEpiFile } from '@episteme/epi-format'
import { GraphExportError, exportEpiFile, exportGraph } from '@episteme/storage-sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILD, NOW, learningGraph } from './epi-fixtures.js'

/**
 * A `.epi` file is published the way a graph file must be (hardening): staged beside the target,
 * linked into place only once the whole file exists, never replacing what is already there, and
 * leaving no staging residue on any failure — so a crash or a full disk can never leave a partial
 * file wearing the target's name, and a reader never mistakes a half-written file for an archive.
 *
 * The mock below simulates a crash between the staged write and the publish, the moment a direct
 * write would have left its partial bytes at the target.
 */
const failure = vi.hoisted(() => ({ crashBeforePublish: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      if (failure.crashBeforePublish) throw new Error('simulated crash before publish')
      return actual.link(...args)
    },
  }
})

let directory: string

beforeEach(async () => {
  directory = await mkdir(join(tmpdir(), 'episteme-epi-write-'), { recursive: true })
})

afterEach(async () => {
  failure.crashBeforePublish = false
  await rm(directory, { recursive: true, force: true })
})

async function graphFile(): Promise<string> {
  const graph = join(directory, `graph-${crypto.randomUUID()}.db`)
  await learningGraph(graph, { publish: true })
  return graph
}

/** No file left behind that is not the target itself. */
async function residue(): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.includes('.writing'))
}

describe('an .epi file is published atomically', () => {
  it('refuses an existing target, leaves it byte-identical, and leaves no staging residue', async () => {
    const graph = await graphFile()
    const target = join(directory, 'existing.epi')
    await writeFile(target, 'not a graph', 'utf8')

    await expect(
      exportEpiFile(graph, target, { build: BUILD, packs: [], now: NOW }),
    ).rejects.toMatchObject({ code: 'target_exists' })
    expect(await readFile(target, 'utf8')).toBe('not a graph')
    expect(await residue()).toEqual([])
  })

  it('publishes a complete readable file and leaves no staging residue', async () => {
    const graph = await graphFile()
    const target = join(directory, 'published.epi')

    const epi = await exportEpiFile(graph, target, { build: BUILD, packs: [], now: NOW })
    const checked = readEpiFile(await readFile(target, 'utf8'))
    expect(checked.knowledge?.sha256).toBe(epi.knowledge.sha256)
    expect(await residue()).toEqual([])
  })

  it('a crash before publish leaves no target and no partial file behind', async () => {
    const graph = await graphFile()
    const target = join(directory, 'crashed.epi')
    failure.crashBeforePublish = true

    await expect(
      exportEpiFile(graph, target, { build: BUILD, packs: [], now: NOW }),
    ).rejects.toThrow(/simulated crash/)
    expect(
      await readFile(target, 'utf8').then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    expect(await residue()).toEqual([])
  })

  it('the v1 export follows the same rules', async () => {
    const graph = await graphFile()
    const target = join(directory, 'whole.epi')
    await writeFile(target, 'not a graph', 'utf8')

    await expect(exportGraph(graph, target, { build: BUILD, now: NOW })).rejects.toThrow(
      GraphExportError,
    )
    expect(await readFile(target, 'utf8')).toBe('not a graph')
    expect(await residue()).toEqual([])
  })
})
