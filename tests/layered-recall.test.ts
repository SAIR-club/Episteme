import { CognitiveSession, SCOPE_BOOST } from '@episteme/application'
import { startService, type EpistemeService } from '@episteme/service'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mcpWire } from './mcp-wire.js'

/**
 * Layered recall (#44): a scope is a preference that shows as a reason in the ranking, a compact layer keeps to a
 * budget and says what it left out, and `expand` gives one node in full, only if the person can see it.
 */

let session: CognitiveSession

beforeEach(async () => {
  session = await CognitiveSession.open({})
  await session.addNode({
    id: 'k_general',
    label: 'Attention needs position information',
    kind: 'claim',
  })
  await session.addNode({
    id: 'k_course',
    label: 'Attention needs position information in this course',
    kind: 'claim',
    scope: 'ml-2026',
  })
  for (let index = 0; index < 6; index += 1) {
    await session.addNode({ label: `Attention head note ${index}`, kind: 'claim' })
  }
})

afterEach(async () => {
  await session.close()
})

describe('a scope', () => {
  it('lifts what lies in it, as a reason of its own, without hiding the rest', async () => {
    const question = 'why does attention need position information'
    const plain = await session.recall(question)
    const scoped = await session.recall(question, { scope: 'ml-2026' })

    expect(scoped.ranked[0]?.nodeId).toBe('k_course')
    expect(scoped.ranked[0]?.reasons.map((reason) => reason.signal)).toContain('scope')
    const before = plain.ranked.find((entry) => entry.nodeId === 'k_course')?.score ?? 0
    expect(scoped.ranked[0]?.score).toBeCloseTo(before + SCOPE_BOOST, 5)
    expect(scoped.ranked.map((entry) => entry.nodeId)).toContain('k_general')
  })
})

describe('the compact layer', () => {
  it('keeps to its budget and says how much it left out', async () => {
    const roomy = await session.recallSummary('attention', { budget: 5000 })
    const tight = await session.recallSummary('attention', { budget: 150 })
    expect(roomy.entries.length).toBeGreaterThan(tight.entries.length)
    expect(tight.truncated).toBe(roomy.entries.length + roomy.truncated - tight.entries.length)
    expect(JSON.stringify(tight.entries).length).toBeLessThanOrEqual(150 + tight.entries.length * 2)
  })

  it('marks what is in scope and what the person recorded', async () => {
    await session.record('k_course', { confidence: 'high' })
    const summary = await session.recallSummary('attention position', { scope: 'ml-2026' })
    expect(summary.entries.find((entry) => entry.nodeId === 'k_course')).toMatchObject({
      inScope: true,
      state: 'confidence=high',
    })
  })
})

describe('expand', () => {
  it('gives one node in full, and nothing of a node the person cannot see', async () => {
    await session.addNode({ id: 'q_position', label: 'Why positions?', kind: 'question' })
    await session.link('k_course', 'q_position')
    await session.record('k_course', { confidence: 'medium' })
    expect(session.expand('k_course')?.tags).toContain('scope:ml-2026')
    expect(session.expand('k_course')).toMatchObject({
      nodeId: 'k_course',
      understanding: [{ id: 'confidence', level: 'medium' }],
      neighbours: [{ nodeId: 'q_position', direction: 'out' }],
    })
    const other = session.forActor('actor_human_other', 'Other')
    expect(other.expand('k_course')).toBeUndefined()
  })
})

describe('over MCP', () => {
  let directory: string
  let service: EpistemeService

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'episteme-layered-'))
    service = await startService({ port: 0, graph: join(directory, 'graph.jsonl') })
  })

  afterEach(async () => {
    await service.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('answers recall in its compact layer, and expands one item', async () => {
    const agent = mcpWire(() => service.mcpUrl, { name: 'Plain Host', version: '1' })
    const summary = await agent.call('recall', {
      question: 'why does a transformer need order',
      depth: 'summary',
    })
    const entries = summary.structuredContent?.['entries'] as { nodeId: string }[]
    expect(entries.length).toBeGreaterThan(0)
    const expanded = await agent.call('expand', { node: entries[0]?.nodeId ?? '' })
    expect(expanded.structuredContent).toMatchObject({ nodeId: entries[0]?.nodeId })
    const missing = await agent.call('expand', { node: 'no_such_node' })
    expect(missing.isError).toBe(true)
  })
})
