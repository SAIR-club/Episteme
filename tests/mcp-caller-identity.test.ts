import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addPerson, addToken, startService, type EpistemeService } from '@episteme/service'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mcpWire, type ToolResult } from './mcp-wire.js'

/**
 * Whose graph an agent works in over MCP, in a shared deployment, spoken over real HTTP (ADR 0012, ADR 0014).
 *
 * An agent token belongs to one person, and the agent acts for that person only: it proposes into their review
 * queue, recalls what they confirmed, and opens, continues and forks their threads. Nothing it does reaches another
 * person, and nothing it says about itself changes whose graph it is in. The SDK clones each POST before serving
 * it, so these run through the HTTP endpoint rather than the session: a caller lost on the way would land in the
 * deployment's own default person, which no one in the shared deployment is.
 */

let directory: string
let users: string
let service: EpistemeService
let lin: { actor: string; human: string; agent: string }
let mei: { actor: string; human: string; agent: string }

async function start(): Promise<void> {
  service = await startService({
    port: 0,
    graph: join(directory, 'shared.db'),
    mode: 'shared',
    users,
    publicOrigin: 'https://episteme.example.edu',
  })
}

async function rest(
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${service.url}${path}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  })
  const text = await response.text()
  return {
    status: response.status,
    body: (text.startsWith('{') ? JSON.parse(text) : {}) as Record<string, unknown>,
  }
}

interface Pending {
  readonly id: string
  readonly owner?: string
  readonly proposedBy: string
  readonly proposal: { readonly label?: string }
}

async function pendingOf(token: string): Promise<readonly Pending[]> {
  return (await rest('/api/v1/suggestions', token)).body['suggestions'] as Pending[]
}

/** An agent host holding `token`, speaking the 2026 envelope or, with `legacy`, the stateless 2025 leg. */
function agent(token: string, name: string, legacy = false) {
  const wire = mcpWire(() => service.mcpUrl, { name, version: '1' })
  const options = { legacy, headers: { authorization: `Bearer ${token}` } }
  return {
    rpc: (method: string, params: Record<string, unknown> = {}) =>
      wire.rpc(method, params, options),
    call: (tool: string, args: Record<string, unknown>) => wire.call(tool, args, {}, options),
  }
}

const textOf = (result: ToolResult): string =>
  result.content?.map((item) => item.text).join('\n') ?? ''
const threadIn = (result: ToolResult): string => /thr_[0-9a-f-]{36}/.exec(textOf(result))![0]
const turnIn = (result: ToolResult): string => /turn_[0-9a-f-]{36}/.exec(textOf(result))![0]

async function propose(token: string, label: string, legacy = false): Promise<ToolResult> {
  return agent(token, 'host', legacy).call('propose', {
    kind: 'claim',
    label,
    rationale: 'the learner said this in the session',
  })
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-mcp-identity-'))
  users = join(directory, 'users.json')
  const linActor = await addPerson(users, 'Lin')
  lin = {
    actor: linActor,
    human: await addToken(users, linActor, 'human', 'workspace'),
    agent: await addToken(users, linActor, 'agent', 'claude-code'),
  }
  const meiActor = await addPerson(users, 'Mei')
  mei = {
    actor: meiActor,
    human: await addToken(users, meiActor, 'human', 'workspace'),
    agent: await addToken(users, meiActor, 'agent', 'codex'),
  }
  await start()
})

afterEach(async () => {
  await service?.close()
  await rm(directory, { recursive: true, force: true })
})

describe('an agent over MCP in a shared deployment', () => {
  it.each([
    ['the 2026 envelope', false],
    ['the stateless 2025 leg', true],
  ])('proposes into its own person’s review queue only, over %s', async (_, legacy) => {
    const proposed = await propose(lin.agent, 'Mitochondria make most of the cell’s ATP.', legacy)
    expect(proposed.isError).not.toBe(true)

    const linPending = await pendingOf(lin.human)
    expect(linPending).toHaveLength(1)
    expect(linPending[0]).toMatchObject({
      owner: lin.actor,
      proposedBy: 'actor_agent_claude-code',
      proposal: { label: 'Mitochondria make most of the cell’s ATP.' },
    })
    expect(await pendingOf(mei.human)).toEqual([])
  })

  it('names the agent by its credential, not by what the client calls itself', async () => {
    // Mei's token, with a client that claims to be Lin's agent: the claim changes nothing.
    const host = mcpWire(() => service.mcpUrl, { name: 'claude-code', version: '1' })
    await host.call(
      'propose',
      { kind: 'claim', label: 'A claim from a host that says it is someone else.', rationale: 'r' },
      {},
      { headers: { authorization: `Bearer ${mei.agent}`, 'x-episteme-actor': lin.actor } },
    )
    expect(await pendingOf(lin.human)).toEqual([])
    expect(await pendingOf(mei.human)).toEqual([
      expect.objectContaining({ owner: mei.actor, proposedBy: 'actor_agent_codex' }),
    ])
  })

  it('recalls what its own person confirmed, and nothing another person confirmed', async () => {
    await propose(lin.agent, 'Chlorophyll absorbs red and blue light.')
    const [linDraft] = await pendingOf(lin.human)
    expect(
      (await rest('/api/v1/suggestions/decide', lin.human, { id: linDraft!.id, action: 'accept' }))
        .status,
    ).toBe(200)

    const question = { question: 'What light does chlorophyll absorb?' }
    const linRecall = await agent(lin.agent, 'host').call('recall', question)
    const meiRecall = await agent(mei.agent, 'host').call('recall', question)
    expect(JSON.stringify(linRecall.structuredContent)).toContain('Chlorophyll absorbs')
    expect(JSON.stringify(meiRecall.structuredContent)).not.toContain('Chlorophyll')
  })

  it('keeps one person’s threads from another person’s agent: no append, no fork', async () => {
    const linHost = agent(lin.agent, 'host')
    const opened = await linHost.call('thread_open', { title: 'Lin’s session' })
    expect(opened.isError).not.toBe(true)
    expect(textOf(opened)).toContain(lin.actor)
    const thread = threadIn(opened)
    const said = await linHost.call('thread_append', {
      thread,
      speaker: 'learner',
      text: 'Light reactions happen in the thylakoid.',
    })
    expect(said.isError).not.toBe(true)
    const turn = turnIn(said)

    const meiHost = agent(mei.agent, 'host')
    const appended = await meiHost.call('thread_append', {
      thread,
      speaker: 'agent',
      text: 'written by another person’s agent',
    })
    expect(appended.isError).toBe(true)
    const forked = await meiHost.call('thread_fork', { thread, turn })
    expect(forked.isError).toBe(true)

    // The person's own agent may still continue and fork it.
    expect((await linHost.call('thread_fork', { thread, turn })).isError).not.toBe(true)
  })

  it('leaves the decision to the person whose queue it is, never to another person or an agent', async () => {
    await propose(lin.agent, 'Stomata regulate gas exchange.')
    const [draft] = await pendingOf(lin.human)

    const byMei = await rest('/api/v1/suggestions/decide', mei.human, {
      id: draft!.id,
      action: 'accept',
    })
    expect(byMei.status).toBe(422)
    const byAgent = await rest('/api/v1/suggestions/decide', lin.agent, {
      id: draft!.id,
      action: 'accept',
    })
    expect(byAgent).toMatchObject({ status: 403, body: { code: 'human_required' } })
    expect(await pendingOf(lin.human)).toHaveLength(1)

    const tools = await agent(lin.agent, 'host').rpc('tools/list')
    const names = ((tools.body['result'] as { tools: { name: string }[] }).tools ?? []).map(
      (tool) => tool.name,
    )
    expect(names).not.toContain('decide')
    expect(names.some((name) => /confirm|accept|decide/.test(name))).toBe(false)
  })

  it('keeps each agent with its own person when requests from both interleave', async () => {
    const rounds = 12
    await Promise.all(
      Array.from({ length: rounds }, (_, index) => [
        propose(lin.agent, `Lin’s claim number ${index}.`, index % 2 === 0),
        propose(mei.agent, `Mei’s claim number ${index}.`, index % 2 === 1),
      ]).flat(),
    )
    const linPending = await pendingOf(lin.human)
    const meiPending = await pendingOf(mei.human)
    expect(linPending).toHaveLength(rounds)
    expect(meiPending).toHaveLength(rounds)
    expect(linPending.every((draft) => draft.owner === lin.actor)).toBe(true)
    expect(meiPending.every((draft) => draft.owner === mei.actor)).toBe(true)
    expect(linPending.every((draft) => draft.proposal.label?.startsWith('Lin’s'))).toBe(true)
    expect(meiPending.every((draft) => draft.proposal.label?.startsWith('Mei’s'))).toBe(true)
  })

  it('still knows whose each draft and thread is after the service restarts', async () => {
    await propose(lin.agent, 'Glucose is made in the Calvin cycle.')
    const opened = await agent(lin.agent, 'host').call('thread_open', { title: 'before restart' })
    const thread = threadIn(opened)

    await service.close()
    await start()

    expect(await pendingOf(lin.human)).toEqual([
      expect.objectContaining({ owner: lin.actor, proposedBy: 'actor_agent_claude-code' }),
    ])
    expect(await pendingOf(mei.human)).toEqual([])
    const continued = await agent(lin.agent, 'host').call('thread_append', {
      thread,
      speaker: 'learner',
      text: 'after restart',
    })
    expect(continued.isError).not.toBe(true)
    const intruded = await agent(mei.agent, 'host').call('thread_append', {
      thread,
      speaker: 'agent',
      text: 'after restart, from someone else',
    })
    expect(intruded.isError).toBe(true)
  })

  it('refuses an MCP request without a valid credential before it reaches any graph', async () => {
    const anonymous = mcpWire(() => service.mcpUrl, { name: 'host', version: '1' })
    expect((await anonymous.rpc('tools/list')).status).toBe(401)
    const forged = await anonymous.rpc(
      'tools/list',
      {},
      { headers: { authorization: 'Bearer ep_000000000000_not-a-real-secret' } },
    )
    expect(forged.status).toBe(401)
  })
})
