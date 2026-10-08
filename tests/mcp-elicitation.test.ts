import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startService, type EpistemeService } from '@episteme/service'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { answer, mcpWire, type ToolResult } from './mcp-wire.js'

/**
 * Asking the learner through the agent's host: MCP 2026-07-28 multi-round-trip elicitation (ADR 0008).
 *
 * `propose` keeps the draft and returns `input_required` with a form and a sealed `requestState`; the host
 * retries with the learner's answer. These tests hold the protocol to the decision semantics: only a valid
 * answer is a decision, the state cannot be forged or redirected, and a client that cannot show a form is not
 * asked at all.
 */

const FORM_CAPABLE = { elicitation: { form: {} } }

let directory: string
let server: EpistemeService
const asking = mcpWire(() => server.mcpUrl, {
  name: 'Form Host',
  version: '1',
  capabilities: FORM_CAPABLE,
})
const silent = mcpWire(() => server.mcpUrl, { name: 'Plain Host', version: '1' })

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-elicit-'))
  server = await startService({ port: 0, graph: join(directory, 'learn.jsonl') })
})

afterEach(async () => {
  await server.close()
  await rm(directory, { recursive: true, force: true })
})

const STATE = {
  kind: 'state',
  target: 'q_why_order',
  dimension: 'confidence',
  level: 'medium',
  rationale: 'they explained it, with some hesitation',
}

async function surface(): Promise<{
  events: number
  suggestions: { id: string }[]
  understanding: Record<string, { id: string; level: string }[]>
}> {
  return (await (await fetch(`${server.url}/api/v1/state`)).json()) as never
}

/** The first round: the tool keeps the draft and asks. */
async function ask(args: Record<string, unknown> = STATE): Promise<ToolResult> {
  const first = await asking.call('propose', args)
  expect(first.resultType).toBe('input_required')
  return first
}

/** The retry a host sends once the learner answered: the original call, the state, and the answer. */
function retry(first: ToolResult, inputResponses: Record<string, unknown>, args = STATE) {
  return asking.call('propose', args, { requestState: first.requestState, inputResponses })
}

describe('the first round', () => {
  it('keeps the draft and asks the learner with a form offering accept, modify and dismiss', async () => {
    const first = await ask()

    const request = first.inputRequests?.['decision']
    expect(request?.method).toBe('elicitation/create')
    const params = request?.params as {
      mode: string
      message: string
      requestedSchema: { properties: Record<string, { oneOf?: { const: string }[] }> }
    }
    expect(params.mode).toBe('form')
    expect(params.message).toContain('理由：they explained it')
    expect(
      params.requestedSchema.properties['decision']?.oneOf?.map((option) => option.const),
    ).toEqual(['accept', 'modify', 'dismiss'])
    expect(
      params.requestedSchema.properties['level']?.oneOf?.map((option) => option.const),
    ).toEqual(['low', 'medium', 'high'])
    expect(typeof first.requestState).toBe('string')
    expect((await surface()).suggestions).toHaveLength(1)
  })

  it('does not ask a client that cannot show a form; the draft waits in the review queue', async () => {
    const result = await silent.call('propose', STATE)
    expect(result.resultType).not.toBe('input_required')
    expect(result.structuredContent?.['status']).toBe('pending')
  })

  it('does not ask over the stateless 2025 leg, which cannot carry the request', async () => {
    const result = await asking.call('propose', STATE, {}, { legacy: true })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent?.['status']).toBe('pending')
  })
})

describe('the learner’s answer', () => {
  it('accept records the agent’s value, confirmed by the learner', async () => {
    const before = (await surface()).events
    const done = await retry(await ask(), answer('accept', { decision: 'accept' }))

    expect(done.structuredContent?.['status']).toBe('accepted')
    const after = await surface()
    expect(after.events).toBe(before + 1)
    expect(after.understanding['q_why_order']).toEqual([{ id: 'confidence', level: 'medium' }])
    expect(after.suggestions).toEqual([])
  })

  it('modify records the learner’s own value instead', async () => {
    const done = await retry(await ask(), answer('accept', { decision: 'modify', level: 'low' }))
    expect(done.structuredContent?.['status']).toBe('modified')
    expect((await surface()).understanding['q_why_order']).toEqual([
      { id: 'confidence', level: 'low' },
    ])
  })

  it('dismiss removes the draft and records nothing', async () => {
    const before = (await surface()).events
    const done = await retry(await ask(), answer('accept', { decision: 'dismiss' }))
    expect(done.structuredContent?.['status']).toBe('dismissed')
    const after = await surface()
    expect(after.events).toBe(before)
    expect(after.suggestions).toEqual([])
  })

  it('declining or cancelling the form is not a decision', async () => {
    for (const action of ['decline', 'cancel'] as const) {
      const done = await retry(await ask(), answer(action))
      expect(done.structuredContent?.['status']).toBe('pending')
    }
    const after = await surface()
    expect(after.suggestions).toHaveLength(2)
    expect(after.understanding['q_why_order']).toEqual([])
  })

  it('treats content that fails the form’s schema as no decision at all', async () => {
    const first = await ask()
    const invalid = await retry(first, answer('accept', { decision: 'accept', level: 'total' }))
    const unknown = await retry(first, answer('accept', { decision: 'approve' }))
    const incomplete = await retry(first, answer('accept', { decision: 'modify' }))

    for (const done of [invalid, unknown, incomplete]) {
      expect(done.structuredContent?.['status']).toBe('pending')
    }
    expect((await surface()).understanding['q_why_order']).toEqual([])
    expect((await surface()).suggestions).toHaveLength(1)
  })

  it('takes the draft from the sealed state, not from the retried arguments', async () => {
    const first = await ask()
    // A retry whose arguments name another node still decides the draft the learner was asked about.
    const done = await retry(first, answer('accept', { decision: 'accept' }), {
      ...STATE,
      target: 'c_rope',
    })
    expect(done.structuredContent?.['status']).toBe('accepted')
    const after = await surface()
    expect(after.understanding['q_why_order']).toEqual([{ id: 'confidence', level: 'medium' }])
    expect(after.understanding['c_rope']).toEqual([])
  })
})

describe('the sealed state', () => {
  it('rejects a forged or altered requestState before the tool runs', async () => {
    const first = await ask()
    const forged = `${first.requestState?.slice(0, -6) ?? ''}AAAAAA`
    const { body } = await asking.rpc('tools/call', {
      name: 'propose',
      arguments: STATE,
      requestState: forged,
      inputResponses: answer('accept', { decision: 'accept' }),
    })

    expect((body['error'] as { code: number } | undefined)?.code).toBe(-32602)
    const after = await surface()
    expect(after.suggestions).toHaveLength(1)
    expect(after.understanding['q_why_order']).toEqual([])
  })

  it('cannot decide a draft twice', async () => {
    const first = await ask()
    await retry(first, answer('accept', { decision: 'accept' }))
    const again = await retry(first, answer('accept', { decision: 'modify', level: 'high' }))

    expect(again.structuredContent?.['status']).toBe('not_pending')
    expect((await surface()).understanding['q_why_order']).toEqual([
      { id: 'confidence', level: 'medium' },
    ])
  })
})
