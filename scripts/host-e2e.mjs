#!/usr/bin/env node
/**
 * A real agent host against a real Episteme service, on an empty graph outside the repo.
 *
 * Two separate host sessions with a person's decision between them: the first proposes, the person accepts over REST,
 * and the second has to find it again with nothing but MCP. A small proxy sits between host and service and writes down
 * what the host actually sends, because what a client declares (elicitation, its name) is the question being asked.
 *
 *   pnpm exec tsc -b && node scripts/host-e2e.mjs --scene service
 *   pnpm exec tsc -b && node scripts/host-e2e.mjs --scene hypothesis
 *   pnpm exec tsc -b && node scripts/host-e2e.mjs --host opencode --model magpie/auto/deepseek-v4.1-flash
 *
 * The host is Claude Code (`claude -p`) by default, or OpenCode with `--host opencode`, which takes its model provider
 * from the person's own OpenCode configuration; nothing about a gateway is written here (scripts/opencode-host.mjs).
 *
 * Spends real model budget: at most --budget dollars per session (default 0.3), with a time limit on each. Content is
 * synthetic. Prints a JSON report; the transcript of MCP calls goes to the temporary directory it names.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { hypothesisProfile } from '../apps/hypothesis/dist/index.js'
import { defaultProfile, startService } from '../apps/service/dist/index.js'
import { openCodeTurn, writeOpenCodeConfig } from './opencode-host.mjs'

const { values } = parseArgs({
  options: {
    scene: { type: 'string', default: 'service' },
    host: { type: 'string', default: 'claude' },
    model: { type: 'string' },
    budget: { type: 'string', default: '0.3' },
    'timeout-ms': { type: 'string', default: '240000' },
  },
})

const SCENES = {
  service: {
    profile: defaultProfile,
    said: 'A hash map lookup is O(1) on average but O(n) in the worst case, because of collisions.',
    asked: 'what is the cost of a hash map lookup?',
    expect: 'hash map',
  },
  hypothesis: {
    profile: hypothesisProfile,
    said: 'Sleep deprivation lowers working memory span in adults.',
    asked: 'what is the effect of sleep deprivation on working memory?',
    expect: 'working memory',
  },
}
const scene = SCENES[values.scene]
if (scene === undefined) throw new Error(`unknown scene "${values.scene}"`)
if (values.host !== 'claude' && values.host !== 'opencode') {
  throw new Error(`unknown host "${values.host}": claude or opencode`)
}
if (values.host === 'opencode' && values.model === undefined) {
  throw new Error('--host opencode needs --model provider/model from your OpenCode configuration')
}
const model = values.model ?? 'haiku'
const MAX_TURNS = 8

const directory = mkdtempSync(join(tmpdir(), 'episteme-host-e2e-'))
const transcript = join(directory, 'mcp-calls.jsonl')
const service = await startService({
  graph: join(directory, 'graph.db'),
  port: 0,
  profile: scene.profile,
})
const target = new URL(service.mcpUrl)

const seen = { client: undefined, tools: [], results: [], methods: new Set() }

/** Passes everything through with the Host the service expects, and notes what the client said. */
const proxy = createServer((incoming, outgoing) => {
  const chunks = []
  incoming.on('data', (chunk) => chunks.push(chunk))
  incoming.on('end', () => {
    const body = Buffer.concat(chunks)
    let call
    try {
      call = JSON.parse(body.toString('utf8'))
    } catch {
      call = undefined
    }
    if (call?.method !== undefined) {
      seen.methods.add(call.method)
      appendFileSync(
        transcript,
        `${JSON.stringify({ method: call.method, params: call.params })}\n`,
      )
      // The 2026-07-28 revision has no initialize: every request carries who is asking and what it can do.
      seen.client = call.params?._meta ?? (call.method === 'initialize' ? call.params : seen.client)
      if (call.method === 'tools/call') seen.tools.push(call.params?.name)
    }
    const forwarded = request(
      {
        host: target.hostname,
        port: target.port,
        path: incoming.url,
        method: incoming.method,
        headers: { ...incoming.headers, host: target.host },
      },
      (answer) => {
        outgoing.writeHead(answer.statusCode ?? 502, answer.headers)
        // What each tool call answered, so "it called recall" and "recall returned it" can be told apart.
        const parts = []
        answer.on('data', (part) => {
          parts.push(part)
          outgoing.write(part)
        })
        answer.on('end', () => {
          outgoing.end()
          if (call?.method !== 'tools/call') return
          const text = Buffer.concat(parts).toString('utf8')
          seen.results.push({
            tool: call.params?.name,
            status: answer.statusCode,
            isError: /"isError":\s*true/.test(text),
            mentionsExpected: text.toLowerCase().includes(scene.expect),
          })
          appendFileSync(transcript, `${JSON.stringify({ answered: call.params?.name, text })}\n`)
        })
      },
    )
    forwarded.on('error', () => outgoing.destroy())
    forwarded.end(body)
  })
})
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
const proxied = `http://127.0.0.1:${proxy.address().port}${target.pathname}`
const config = join(directory, 'mcp.json')
writeFileSync(config, JSON.stringify({ mcpServers: { episteme: { type: 'http', url: proxied } } }))
if (values.host === 'opencode') writeOpenCodeConfig(directory, proxied)

const person = async (path, body) => {
  const response = await fetch(`${service.apiUrl}${path}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: {
      authorization: `Bearer ${service.humanToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  })
  return response.json()
}

// Run from inside another Claude Code, this process carries that session's identity. The host must not inherit it.
const hostEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !/^(CLAUDECODE$|CLAUDE_PID$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_)/.test(name),
  ),
)

/** One OpenCode turn, with the same step limit and budget, stopped from here (see opencode-host.mjs). */
const openCodeSession = async (prompt) => {
  const turn = await openCodeTurn({
    cwd: directory,
    model,
    prompt,
    maxSteps: MAX_TURNS,
    budgetUsd: Number(values.budget),
    timeoutMs: Number(values['timeout-ms']),
    env: hostEnvironment,
  })
  const { texts: _texts, ...kept } = turn
  return { ...kept, costBasis: 'opencode-estimate' }
}

const claudeSession = (prompt) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      [
        '-p',
        '--model',
        model,
        '--max-budget-usd',
        values.budget,
        '--output-format',
        'stream-json',
        '--verbose',
        '--no-session-persistence',
        '--setting-sources',
        'project',
        '--strict-mcp-config',
        '--mcp-config',
        config,
        '--tools',
        '""',
        '--allowedTools',
        'mcp__episteme',
        '--max-turns',
        String(MAX_TURNS),
      ],
      { cwd: directory, shell: true, env: hostEnvironment, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const timer = setTimeout(() => child.kill(), Number(values['timeout-ms']))
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (err += chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      const events = out
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line))
      const init = events.find((event) => event.type === 'system' && event.subtype === 'init')
      const result = events.find((event) => event.type === 'result')
      resolve({
        code,
        stderr: err.slice(0, 2000),
        mcpServers: init?.mcp_servers,
        tools: init?.tools,
        text: result?.result,
        costUsd: result?.total_cost_usd,
        turns: result?.num_turns,
      })
    })
    child.stdin.end(prompt)
  })

/** One whole host session in an empty directory, so nothing but MCP can tell it anything. */
const hostSession = (prompt) =>
  values.host === 'opencode' ? openCodeSession(prompt) : claudeSession(prompt)

const report = { scene: values.scene, host: values.host, model, directory }
try {
  report.first = await hostSession(
    [
      'You are helping someone keep track of what they understand, through the Episteme MCP tools.',
      `They just said: "${scene.said}"`,
      'First call recall with a question about it. Then call propose with kind "claim", the label as they would say it, and a rationale.',
      'Then call reflect. Finish by telling them plainly what is and is not recorded now.',
    ].join('\n'),
  )
  const waiting = await person('/suggestions')
  report.pendingAfterFirst = waiting.suggestions?.map((suggestion) => ({
    id: suggestion.id,
    proposedBy: suggestion.proposedBy,
    origin: suggestion.origin,
    label: suggestion.proposal?.label,
  }))

  for (const { id } of waiting.suggestions ?? []) {
    await person('/suggestions/decide', { id, action: 'accept' })
  }
  report.second = await hostSession(
    [
      'Use the Episteme MCP tool recall to find what this person already understands.',
      `Their question: ${scene.asked}`,
      'Answer only from what recall returned, and say so if it returned nothing.',
    ].join('\n'),
  )
  report.recalled = report.second.text?.toLowerCase().includes(scene.expect) === true
  report.client = seen.client
  report.toolCalls = seen.tools
  report.toolResults = seen.results
  report.methods = [...seen.methods]
} finally {
  await service.close()
  proxy.close()
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
process.exit(0)
