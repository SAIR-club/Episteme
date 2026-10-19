#!/usr/bin/env node
/**
 * Smoke test for a shared Episteme deployment (ADR 0012, #45).
 *
 *   node scripts/smoke-shared.mjs <origin> <human token> [agent token]
 *
 * Checks, in order: the service refuses a request without a token; the person's token reads; it opens a
 * Workspace session; an agent token, when given, reads, lists the MCP tools and is refused a decision. Prints one
 * line per check and exits non-zero on the first failure. It changes nothing in the graph.
 */

const [origin, human, agent] = process.argv.slice(2)
if (origin === undefined || human === undefined) {
  process.stderr.write(
    'usage: node scripts/smoke-shared.mjs <origin> <human token> [agent token]\n',
  )
  process.exit(2)
}

const api = `${origin.replace(/\/$/, '')}/api/v1`

async function call(path, { token, body } = {}) {
  const response = await fetch(path.startsWith('http') ? path : `${api}${path}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, json, text }
}

function check(label, ok, detail) {
  process.stdout.write(
    `${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === undefined ? '' : `  (${detail})`}\n`,
  )
  if (!ok) process.exit(1)
}

const anonymous = await call('/vocabulary')
check('refuses a request without a token', anonymous.status === 401, `status ${anonymous.status}`)

const read = await call('/vocabulary', { token: human })
check('reads with the person’s token', read.status === 200, `status ${read.status}`)

const session = await call('/session', { body: { token: human } })
check(
  'opens a Workspace session for the person',
  session.status === 200 && session.json?.actorId !== undefined,
  `status ${session.status}, actor ${session.json?.actorId ?? '?'}`,
)

if (agent !== undefined) {
  const agentRead = await call('/reflect', { token: agent })
  check('reads with the agent token', agentRead.status === 200, `status ${agentRead.status}`)

  const tools = await fetch(`${origin.replace(/\/$/, '')}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${agent}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
  check('lists the MCP tools with the agent token', tools.status === 200, `status ${tools.status}`)

  const decide = await call('/suggestions/decide', {
    token: agent,
    body: { id: 'sug_smoke', action: 'dismiss' },
  })
  check(
    'refuses a decision with the agent token',
    decide.status === 403 && decide.json?.code === 'human_required',
    `status ${decide.status}, code ${decide.json?.code ?? '?'}`,
  )
}

process.stdout.write('all checks passed\n')
