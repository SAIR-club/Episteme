import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CognitiveSession, sceneViewOf } from '@episteme/application'
import {
  GraphExportError,
  exportGraph,
  importGraph,
  openSqliteStorage,
  readGraphExport,
} from '@episteme/storage-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testScene } from './test-scene.js'

/**
 * Backing up means nothing until coming back works, so these go all the way: a conversation written through a
 * session, out to a file, into a new graph, and read back through a session again. An application's own records
 * travel the same way; MindLink's workbench tests its spaces and material end to end.
 */

const NOTES = '# 位置编码\n\n位置编码把序列的顺序告诉模型。\n'
const OPTIONS = { build: 'test-build' }

describe('exporting and importing a graph', () => {
  let directory: string
  let graph: string
  let archive: string

  /** What a person has after a short session: a conversation with one turn. */
  const session = async (): Promise<void> => {
    const opened = await CognitiveSession.open({ filePath: graph, scene: testScene })
    try {
      const thread = await opened.openThread({ title: '位置编码' })
      await opened.appendTurn(thread.id, { speaker: 'learner', text: NOTES })
    } finally {
      await opened.close()
    }
  }

  const conversations = async (file: string): Promise<unknown> => {
    const opened = await CognitiveSession.open({ filePath: file, scene: testScene })
    try {
      const view = sceneViewOf(opened)
      return view
        .threads()
        .map((thread) => view.threadView(thread.id)?.turns.map((turn) => turn.text))
    } finally {
      await opened.close()
    }
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'episteme-export-'))
    graph = join(directory, 'graph.db')
    archive = join(directory, 'graph.epi')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 })
  })

  it('brings a person’s conversations back into a new graph, and leaves the original as it was', async () => {
    await session()
    const before = await conversations(graph)
    expect(JSON.stringify(before)).toContain('位置编码')
    await exportGraph(graph, archive, OPTIONS)
    const restored = join(directory, 'restored.db')
    await importGraph(archive, restored)
    expect(await conversations(restored)).toEqual(before)
    expect(await conversations(graph)).toEqual(before)
  }, 60_000)

  it('gives the same file back for the same graph, so a round trip loses nothing', async () => {
    await session()
    await exportGraph(graph, archive, { ...OPTIONS, now: () => new Date(0) })
    const restored = join(directory, 'restored.db')
    await importGraph(archive, restored)
    const second = join(directory, 'second.epi')
    await exportGraph(restored, second, { ...OPTIONS, now: () => new Date(0) })
    const first = await readGraphExport(archive)
    const again = await readGraphExport(second)
    expect(again.sha256).toBe(first.sha256)
  }, 60_000)

  it('writes a large graph a piece at a time, as the same file serializing it whole would give', async () => {
    // Several megabytes of conversation, so the file is written over many pieces.
    const opened = await CognitiveSession.open({ filePath: graph, scene: testScene })
    try {
      const thread = await opened.openThread({ title: '长对话' })
      const line = '位置编码把序列的顺序告诉模型，没有它注意力看不出词的先后。'.repeat(60)
      for (let turn = 0; turn < 2_000; turn += 1) {
        await opened.appendTurn(thread.id, { speaker: 'learner', text: `第 ${turn} 轮：${line}` })
      }
    } finally {
      await opened.close()
    }
    const head = await exportGraph(graph, archive, OPTIONS)
    const text = await readFile(archive, 'utf8')
    expect(text.length).toBeGreaterThan(3 * (1 << 20))
    expect(text).toBe(JSON.stringify(JSON.parse(text)))
    // What it returns is the file's own head, without carrying the graph back in memory.
    const read = await readGraphExport(archive)
    expect(head).toEqual({ ...read, records: undefined, companions: undefined })
    expect(Object.keys(head)).not.toContain('records')

    const restored = join(directory, 'restored.db')
    await importGraph(archive, restored)
    const again = join(directory, 'again.episteme.json')
    await exportGraph(restored, again, { ...OPTIONS, now: () => new Date(head.exportedAt) })
    expect((await readGraphExport(again)).sha256).toBe(head.sha256)
  }, 120_000)

  // Windows ignores the mode, and CI's Linux runners are what check it.
  it.skipIf(process.platform === 'win32')(
    'writes a file only its owner can read, whatever the umask allows',
    async () => {
      await session()
      const before = process.umask(0)
      try {
        await exportGraph(graph, archive, OPTIONS)
      } finally {
        process.umask(before)
      }
      expect((await stat(archive)).mode & 0o777).toBe(0o600)
    },
    60_000,
  )

  it('takes an edited file whose checksum was recomputed, so the checksum proves no authorship', async () => {
    await session()
    await exportGraph(graph, archive, OPTIONS)
    const original = await readGraphExport(archive)
    const { records } = original
    const companions = original.companions.map((each) => ({
      ...each,
      body: each.body.replaceAll('位置编码', '换过的词'),
    }))
    expect(JSON.stringify(companions)).toContain('换过的词')
    const edited = join(directory, 'edited.epi')
    await writeFile(
      edited,
      JSON.stringify({
        ...original,
        companions,
        sha256: createHash('sha256').update(JSON.stringify({ records, companions })).digest('hex'),
      }),
    )
    const restored = join(directory, 'restored.db')
    await importGraph(edited, restored)
    const again = join(directory, 'again.epi')
    await exportGraph(restored, again, OPTIONS)
    expect(JSON.stringify((await readGraphExport(again)).companions)).toContain('换过的词')
  }, 60_000)

  it('refuses a graph someone is using', async () => {
    const storage = await openSqliteStorage(graph)
    try {
      await expect(exportGraph(graph, archive, OPTIONS)).rejects.toThrow(/already open/)
      expect(existsSync(archive)).toBe(false)
    } finally {
      await storage.close()
    }
  })

  const refusal = async (work: Promise<unknown>): Promise<string> => {
    const error = await work.then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(error).toBeInstanceOf(GraphExportError)
    return (error as GraphExportError).code
  }

  it('never replaces anything', async () => {
    await session()
    await writeFile(archive, 'keep me')
    expect(await refusal(exportGraph(graph, archive, OPTIONS))).toBe('target_exists')
    expect(await readFile(archive, 'utf8')).toBe('keep me')

    const good = join(directory, 'good.json')
    await exportGraph(graph, good, OPTIONS)
    const before = await readFile(graph)
    expect(await refusal(importGraph(good, graph))).toBe('target_exists')
    expect((await readFile(graph)).equals(before)).toBe(true)
  }, 60_000)

  it('refuses what is damaged, edited, foreign or newer, and leaves nothing behind', async () => {
    await session()
    await exportGraph(graph, archive, OPTIONS)
    const original = JSON.parse(await readFile(archive, 'utf8')) as {
      version: number
      records: string[]
      storedAs: { sqliteFormat: number }
    }
    const target = join(directory, 'restored.db')

    const attempt = async (content: string): Promise<string> => {
      const file = join(directory, 'attempt.json')
      await writeFile(file, content)
      const code = await refusal(importGraph(file, target))
      expect(existsSync(target)).toBe(false)
      return code
    }

    const edited = structuredClone(original)
    edited.records[0] = `${edited.records[0]} `
    expect(await attempt(JSON.stringify(edited))).toBe('damaged')
    expect(await attempt('{"format":"something-else"}')).toBe('not_an_export')
    expect(await attempt('not json')).toBe('not_an_export')
    expect(await attempt(JSON.stringify({ ...original, version: 2 }))).toBe('unsupported_version')
    expect(
      await attempt(
        JSON.stringify({ ...original, storedAs: { ...original.storedAs, sqliteFormat: 99 } }),
      ),
    ).toBe('unsupported_version')
  }, 60_000)

  // ADR 0022: the name is a convention for people and their operating systems; identity is the format field.
  it('judges by content, not by file name', async () => {
    const target = join(directory, 'restored.db')
    const plain = join(directory, 'backup')
    await session()
    await exportGraph(graph, plain, OPTIONS)
    expect((await readGraphExport(plain)).format).toBe('episteme-graph-export')
    await importGraph(plain, target)
    expect(existsSync(target)).toBe(true)
  }, 60_000)
})
