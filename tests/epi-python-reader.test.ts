import { execFile, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { openEpi } from '@episteme/epi-reader'
import { exportEpiFile } from '@episteme/storage-sqlite'
import { expect, it } from 'vitest'
import { BUILD, HUMAN, NOW, PACKS, learningGraph } from './epi-fixtures.js'

const python = ['python3', 'python'].find((command) => {
  const probe = spawnSync(command, [
    '-c',
    'import sys; sys.exit(0 if sys.version_info.major == 3 and sys.version_info >= (3, 10) else 1)',
  ])
  if (probe.error && (probe.error as NodeJS.ErrnoException).code !== 'ENOENT') throw probe.error
  return probe.status === 0
})

const reader = join(import.meta.dirname, '..', 'docs', 'epi', 'reference', 'read_epi.py')

it.skipIf(python === undefined)(
  `reads the same .epi knowledge in Python and TypeScript${python ? '' : ' (requires Python 3.10+ on PATH: python3 or python)'}`,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'episteme-epi-python-'))
    try {
      const graph = join(directory, 'graph.db')
      const file = join(directory, 'graph.epi')
      await learningGraph(graph, { publish: true })
      await exportEpiFile(graph, file, { build: BUILD, packs: PACKS, now: NOW })

      const epi = openEpi(await readFile(file, 'utf8'))
      const types = new Set(epi.nodes().map((node) => node.type))
      expect(types.size).toBeGreaterThanOrEqual(2)
      expect(epi.edges().length).toBeGreaterThan(0)
      expect(epi.actors()).toContain(HUMAN)
      expect(epi.publications()).toHaveLength(1)

      const { stdout } = await promisify(execFile)(python!, [reader, file], { encoding: 'utf8' })
      expect(JSON.parse(stdout)).toEqual({
        nodesByType: Object.fromEntries(
          [...types].map((type) => [type, epi.nodesByType(type).map((node) => node.id)]),
        ),
        relations: epi.edges().map(({ from, to, type }) => ({ from, to, type })),
        states: Object.fromEntries(
          epi.actors().map((actor) => [
            actor,
            epi
              .state()
              .filter((entry) => entry.actor === actor)
              .map(({ target, dimensions }) => ({
                target,
                dimensions,
              })),
          ]),
        ),
        publications: epi.publications(),
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)
