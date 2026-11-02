import { readdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { exportGraph, importGraph } from '@episteme/application'
import { asId, type DimensionId, type NodeId } from '@episteme/core'
import { hypothesisProfile } from '@episteme/hypothesis'
import { openEpisteme } from '@episteme/sdk'
import { startService, type EpistemeService } from '@episteme/service'
import { openSqliteStorage } from '@episteme/storage-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mcpWire, type McpWire } from './mcp-wire.js'

/**
 * PRD G5: a scene that is not about learning reviews, keeps, finds and reuses understanding with no change to Core,
 * and REST, MCP and the SDK all say the same thing about the same graph.
 */

const STATEMENT = 'Sleep deprivation lowers working memory span in adults'
const EVIDENCE = 'A controlled study found shorter digit spans after one night awake'

interface Listed {
  readonly nodeId: string
  readonly label: string
  readonly credence?: string
  readonly evidence: readonly { readonly nodeId: string; readonly relation: string }[]
}

describe('a hypothesis scene on the same engine', () => {
  let directory: string
  let graph: string
  let service: EpistemeService
  let agent: McpWire

  const open = async (file: string): Promise<void> => {
    service = await startService({ graph: file, port: 0, profile: hypothesisProfile })
    agent = mcpWire(() => service.mcpUrl, { name: 'Research host', version: '1.0' })
  }

  const api = async <T>(path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const response = await fetch(`${service.apiUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${service.humanToken ?? ''}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: (await response.json()) as T }
  }

  const listed = async (query = ''): Promise<readonly Listed[]> =>
    (await api<{ hypotheses: readonly Listed[] }>(`/scene/hypothesis/hypotheses${query}`)).body
      .hypotheses

  const accept = async (ids: readonly string[]): Promise<void> => {
    for (const id of ids) {
      expect((await api('/suggestions/decide', { id, action: 'accept' })).status).toBe(200)
    }
  }

  /** Through the whole path: proposed, accepted by the person, supported, believed to a degree. */
  const weighed = async (): Promise<Listed> => {
    const stated = await api<{ suggestions: readonly string[] }>('/scene/hypothesis/hypotheses', {
      statement: STATEMENT,
      why: 'From reading about sleep',
    })
    expect(await listed()).toEqual([])
    await accept(stated.body.suggestions)
    const [held] = await listed()
    if (held === undefined) throw new Error('the accepted hypothesis is not held')

    const supported = await api<{ suggestions: readonly string[] }>('/scene/hypothesis/evidence', {
      hypothesis: held.nodeId,
      statement: EVIDENCE,
      relation: 'supports',
      why: 'The study measures it directly',
    })
    await accept(supported.body.suggestions)
    const recorded = await api('/record', {
      target: held.nodeId,
      dimensions: { credence: 'likely' },
      reason: 'One controlled study so far',
    })
    expect(recorded.status).toBe(200)
    const found = (await listed()).find((node) => node.nodeId === held.nodeId)
    if (found === undefined) throw new Error('the hypothesis went missing')
    return found
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'episteme-hypothesis-'))
    graph = join(directory, 'hypotheses.db')
    await open(graph)
  })

  afterEach(async () => {
    await service.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('reviews, keeps and finds a hypothesis, with evidence and a level of belief', async () => {
    const held = await weighed()
    expect(held).toMatchObject({
      label: STATEMENT,
      credence: 'likely',
      evidence: [{ relation: 'supports' }],
    })
    expect((await listed('?q=working%20memory')).map((node) => node.label)).toEqual([STATEMENT])
    expect(await listed('?q=photosynthesis')).toEqual([])

    // The scene's own dimension, and only that: nothing of the learning scene comes with it.
    const refused = await api('/record', {
      target: held.nodeId,
      dimensions: { confidence: 'high' },
    })
    expect(refused.status).toBe(422)
  })

  it('lets an agent propose over MCP but never decide', async () => {
    const proposed = await agent.call('propose', {
      kind: 'claim',
      label: STATEMENT,
      rationale: 'The researcher said so in this session',
    })
    expect(proposed.structuredContent?.['status']).toBeDefined()
    expect(await listed()).toEqual([])
    const tools = await agent.rpc('tools/list')
    const names = (
      (tools.body['result'] as { tools: readonly { name: string }[] }).tools ?? []
    ).map((tool) => tool.name)
    expect(names).toContain('recall')
    for (const forbidden of ['decide', 'accept', 'record']) expect(names).not.toContain(forbidden)
  })

  // Found by a real host: told only "nothing recorded", it treated an accepted claim as stray text and would not use it.
  it('tells a new session what the person accepted, even with no level recorded', async () => {
    const stated = await api<{ suggestions: readonly string[] }>('/scene/hypothesis/hypotheses', {
      statement: STATEMENT,
      why: 'From reading about sleep',
    })
    await api('/scene/hypothesis/hypotheses', { statement: EVIDENCE, why: 'Still undecided' })
    await accept(stated.body.suggestions)

    const recalled = await agent.call('recall', { question: 'working memory after sleep loss' })
    const ranked = recalled.structuredContent?.['ranked'] as readonly {
      label: string
      kept: boolean
    }[]
    expect(ranked.find((entry) => entry.label === STATEMENT)?.kept).toBe(true)
    // Undecided words are not in the graph at all, so they cannot be mistaken for kept ones.
    expect(ranked.map((entry) => entry.label)).not.toContain(EVIDENCE)
    expect(recalled.content?.[0]?.text).toContain('kept')
    expect(recalled.structuredContent?.['summary']).not.toContain('还没有记录过任何东西')
  })

  it('says the same thing through REST, MCP and the SDK', async () => {
    const held = await weighed()

    const recalled = await agent.call('recall', { question: 'working memory after sleep loss' })
    const known = recalled.structuredContent?.['known'] as readonly {
      nodeId: string
      label: string
      dimensions: readonly { id: string; level: string }[]
    }[]
    const fromMcp = known.find((entry) => entry.nodeId === held.nodeId)
    expect(fromMcp?.label).toBe(STATEMENT)
    expect(fromMcp?.dimensions).toContainEqual({ id: 'credence', level: 'likely' })

    await service.close()

    // The SDK reads the same file once the service has let go of it.
    const storage = await openSqliteStorage(graph)
    const episteme = await openEpisteme(storage, { packs: hypothesisProfile.scene.packs })
    const node = episteme.graph.getNode(held.nodeId)
    expect(node?.label).toBe(STATEMENT)
    const state = episteme.log.stateOf(asId<NodeId>(held.nodeId), episteme.actorId)
    expect(state.get(asId<DimensionId>('credence'))).toMatchObject({ level: 'likely' })
    await storage.close()
    await open(graph)
  })

  it('comes back in a new session, and from an export, with where it came from', async () => {
    const held = await weighed()
    await service.close()

    await open(graph)
    expect((await listed()).find((node) => node.nodeId === held.nodeId)?.credence).toBe('likely')
    const before = await api<{ events: unknown }>(`/nodes/${held.nodeId}/history`)
    await service.close()

    const archive = join(directory, 'hypotheses.episteme.json')
    const exported = await exportGraph(graph, archive, { build: 'test-build' })
    expect(exported.source).toEqual({ file: 'hypotheses.db', build: 'test-build' })

    const restored = join(directory, 'restored.db')
    await importGraph(archive, restored)
    await open(restored)
    const again = (await listed()).find((node) => node.nodeId === held.nodeId)
    expect(again).toMatchObject({ label: STATEMENT, credence: 'likely' })
    expect(again?.evidence).toEqual(held.evidence)
    // The events themselves; the epoch names a run of the service, and this is a new one.
    const history = await api<{ events: unknown }>(`/nodes/${held.nodeId}/history`)
    expect(history.body.events).toEqual(before.body.events)
  })

  it('needed no change to Core or the application', async () => {
    // A scene that reached for learning would import it. This one's source says so plainly.
    const source = resolve(import.meta.dirname, '../apps/hypothesis/src')
    for (const file of await readdir(source)) {
      const text = await readFile(join(source, file), 'utf8')
      expect(text).not.toMatch(/learnScene|learnProfile|LearnSession|@episteme\/workbench/)
    }
  })
})
