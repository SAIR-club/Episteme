import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CognitiveSession } from '@episteme/application'
import { EmbeddingError, type EmbeddingAdapter } from '@episteme/core'
import {
  EmbeddingSettingsError,
  embeddingsFromEnvironment,
  startService,
  type EpistemeService,
} from '@episteme/service'
import { afterEach, describe, expect, it } from 'vitest'
import { mcpWire } from './mcp-wire.js'

/**
 * Semantic recall is off unless an embedding endpoint is configured. When the configured provider fails, a recall
 * falls back to words, links, understanding and recency, and says why, rather than failing or reading as "nothing
 * close in meaning".
 */

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'episteme-semantic-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

/** An adapter whose provider is down. */
const unreachable: EmbeddingAdapter = {
  model: 'down-model',
  embed: () =>
    Promise.reject(new EmbeddingError('unavailable', 'embedding provider is unreachable')),
}

describe('a session whose embedding provider fails', () => {
  it('still recalls by words and says that meaning was left out', async () => {
    const session = await CognitiveSession.open({ adapter: unreachable })
    cleanups.push(() => session.close())
    const { nodeId } = await session.addNode({
      label: 'Attention needs position information',
      kind: 'claim',
    })

    const recalled = await session.recall('why does attention need position information')
    expect(recalled.ranked.map((entry) => entry.nodeId)).toContain(nodeId)
    expect(
      recalled.ranked.flatMap((entry) => entry.reasons.map((reason) => reason.signal)),
    ).not.toContain('semantic')
    expect(recalled.semanticUnavailable).toBe('unavailable: embedding provider is unreachable')

    const summary = await session.recallSummary('why does attention need position information')
    expect(summary.semanticUnavailable).toBe(recalled.semanticUnavailable)
    const asked = await session.ask('why does attention need position information')
    expect(asked.semanticUnavailable).toBe(recalled.semanticUnavailable)
  })

  it('reports nothing when the provider works', async () => {
    const session = await CognitiveSession.open()
    cleanups.push(() => session.close())
    await session.addNode({ label: 'Attention needs position information', kind: 'claim' })
    const recalled = await session.recall('why does attention need position information')
    expect(recalled).not.toHaveProperty('semanticUnavailable')
  })
})

describe('the embedding settings in the environment', () => {
  it('are off when neither URL nor model is set', () => {
    expect(embeddingsFromEnvironment({})).toBeUndefined()
    expect(
      embeddingsFromEnvironment({ EPISTEME_EMBEDDINGS_URL: ' ', EPISTEME_EMBEDDINGS_MODEL: '' }),
    ).toBeUndefined()
  })

  it('default to the OpenAI protocol and a ten-second timeout', () => {
    expect(
      embeddingsFromEnvironment({
        EPISTEME_EMBEDDINGS_URL: 'http://127.0.0.1:3425',
        EPISTEME_EMBEDDINGS_MODEL: 'text-embedding',
      }),
    ).toEqual({
      baseUrl: 'http://127.0.0.1:3425',
      model: 'text-embedding',
      protocol: 'openai',
      timeoutMs: 10_000,
    })
  })

  it('are refused when only half set, or with an unknown protocol or a bad timeout', () => {
    const base = { EPISTEME_EMBEDDINGS_URL: 'http://x', EPISTEME_EMBEDDINGS_MODEL: 'm' }
    expect(() => embeddingsFromEnvironment({ EPISTEME_EMBEDDINGS_URL: 'http://x' })).toThrow(
      EmbeddingSettingsError,
    )
    expect(() => embeddingsFromEnvironment({ EPISTEME_EMBEDDINGS_MODEL: 'm' })).toThrow(
      EmbeddingSettingsError,
    )
    expect(() =>
      embeddingsFromEnvironment({ ...base, EPISTEME_EMBEDDINGS_PROTOCOL: 'grpc' }),
    ).toThrow(/openai, ollama, tei/)
    expect(() =>
      embeddingsFromEnvironment({ ...base, EPISTEME_EMBEDDINGS_TIMEOUT_MS: 'soon' }),
    ).toThrow(/positive number/)
  })
})

/**
 * A real OpenAI-compatible endpoint on a socket. Its "meaning" is two axes: whether a text is about order, or not.
 * So a question with no word in common with a node can still land on it, which only the semantic signal can do.
 */
async function embeddingServer(): Promise<{
  url: string
  requests: { model: string; authorization: string | undefined }[]
  close: () => Promise<void>
}> {
  const requests: { model: string; authorization: string | undefined }[] = []
  const vectorOf = (text: string): number[] =>
    /order|顺序|sequence|排列/i.test(text) ? [1, 0] : [0, 1]
  const server: Server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
    })
    request.on('end', () => {
      const parsed = JSON.parse(body) as { model: string; input: string | string[] }
      requests.push({ model: parsed.model, authorization: request.headers.authorization })
      const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input]
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ data: inputs.map((text) => ({ embedding: vectorOf(text) })) }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  let closed = false
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      if (closed) return
      closed = true
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

describe('the service with an embedding endpoint', () => {
  it('ranks by meaning through it, and falls back and says so once it is gone', async () => {
    const directory = await temporaryDirectory()
    const provider = await embeddingServer()
    cleanups.push(provider.close)
    const service: EpistemeService = await startService({
      port: 0,
      graph: join(directory, 'graph.db'),
      embeddings: {
        baseUrl: provider.url,
        model: 'stub-embedding',
        protocol: 'openai',
        apiKey: 'test-key-not-secret',
        timeoutMs: 2_000,
      },
    })
    cleanups.push(() => service.close())
    expect(service.embeddings).toEqual({
      baseUrl: provider.url,
      model: 'stub-embedding',
      protocol: 'openai',
    })
    const agent = mcpWire(() => service.mcpUrl, { name: 'Semantic Test', version: '1.0.0' })

    const recalled = await agent.call('recall', { question: '词的排列为什么要紧' })
    expect(recalled.isError).toBeUndefined()
    expect(provider.requests.length).toBeGreaterThan(0)
    expect(provider.requests.every((request) => request.model === 'stub-embedding')).toBe(true)
    expect(provider.requests[0]?.authorization).toBe('Bearer test-key-not-secret')
    const ranked = recalled.structuredContent?.['ranked'] as readonly {
      nodeId: string
      reasons: readonly { signal: string; value: number }[]
    }[]
    const byMeaning = ranked.filter((entry) =>
      entry.reasons.some((reason) => reason.signal === 'semantic' && reason.value > 0.9),
    )
    expect(byMeaning.length).toBeGreaterThan(0)
    expect(recalled.structuredContent).not.toHaveProperty('semanticUnavailable')

    await provider.close()
    const fallen = await agent.call('recall', {
      question: '为什么 Transformer 必须被告知序列顺序？',
    })
    expect(fallen.isError).toBeUndefined()
    expect(fallen.structuredContent?.['semanticUnavailable']).toMatch(/^unavailable: /)
    expect(fallen.content?.[0]?.text).toContain('The embedding provider failed')
    expect(fallen.content?.[0]?.text).not.toContain('test-key-not-secret')
    expect((fallen.structuredContent?.['ranked'] as readonly unknown[]).length).toBeGreaterThan(0)
  })

  it('is off when the environment configures nothing', async () => {
    const directory = await temporaryDirectory()
    const service = await startService({ port: 0, graph: join(directory, 'graph.db') })
    cleanups.push(() => service.close())
    expect(service.embeddings).toBeUndefined()
  })
})
