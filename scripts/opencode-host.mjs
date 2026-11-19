/**
 * One non-interactive OpenCode turn, as the agent host of an end-to-end script.
 *
 * The MCP server is given in an `opencode.json` written into the host's own empty directory, so the person's global
 * OpenCode configuration (where their model provider lives) is read but never changed. Built-in tools that could touch
 * the machine are denied there.
 *
 * OpenCode has no spending limit of its own, so this one stops the process: after `maxSteps` model steps, once the cost
 * OpenCode reports passes `budgetUsd`, or at `timeoutMs`. That cost is OpenCode's estimate from its price table, not the
 * provider's bill, and a step already under way still finishes its own call, so a cap can be passed by one step.
 */
import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** What the MCP calls inside one `execute` tool use were, by OpenCode's own account. */
const callsOf = (part) =>
  (part.state?.metadata?.metadata?.toolCalls ?? []).map((call) => ({
    tool: call.tool,
    status: call.status,
  }))

/** With no `mcpUrl`, the host gets no MCP server at all, as a baseline without Episteme needs. */
export function writeOpenCodeConfig(directory, mcpUrl) {
  writeFileSync(
    join(directory, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        ...(mcpUrl === undefined
          ? {}
          : { mcp: { servers: { episteme: { type: 'remote', url: mcpUrl } } } }),
        permission: { bash: 'deny', edit: 'deny', webfetch: 'deny' },
      },
      null,
      2,
    ),
  )
}

/**
 * @param options.session an OpenCode session id to continue; omitted, a new session starts and its id is returned
 */
export function openCodeTurn({ cwd, model, prompt, session, maxSteps, budgetUsd, timeoutMs, env }) {
  return new Promise((done, failed) => {
    const child = spawn(
      'opencode',
      [
        'run',
        '--standalone',
        '--format',
        'json',
        '--archived',
        '--auto',
        '-m',
        model,
        ...(session === undefined ? [] : ['--session', session]),
        prompt,
      ],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    )
    const turn = {
      host: 'opencode',
      model,
      session,
      steps: 0,
      costUsd: 0,
      tokens: { input: 0, output: 0, reasoning: 0 },
      toolUses: [],
      mcpCalls: [],
      texts: [],
      stopped: undefined,
    }
    const stop = (why) => {
      if (turn.stopped !== undefined) return
      turn.stopped = why
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/T', '/F', '/PID', `${child.pid}`], { stdio: 'ignore' })
      } else {
        child.kill()
      }
    }
    const timer = setTimeout(() => stop(`timeout after ${timeoutMs} ms`), timeoutMs)
    let out = ''
    let pending = ''
    let err = ''
    const read = (line) => {
      let event
      try {
        event = JSON.parse(line)
      } catch {
        return
      }
      turn.session ??= event.sessionID
      const part = event.part ?? {}
      if (event.type === 'tool_use') {
        turn.toolUses.push({ tool: part.tool, status: part.state?.status })
        turn.mcpCalls.push(...callsOf(part))
      } else if (event.type === 'text' && typeof part.text === 'string') {
        turn.texts.push(part.text)
      } else if (event.type === 'step_finish') {
        turn.steps += 1
        turn.costUsd += part.cost ?? 0
        turn.tokens.input += part.tokens?.input ?? 0
        turn.tokens.output += part.tokens?.output ?? 0
        turn.tokens.reasoning += part.tokens?.reasoning ?? 0
        if (turn.costUsd > budgetUsd) stop(`over the budget of ${budgetUsd} USD`)
        else if (turn.steps >= maxSteps && part.reason === 'tool-calls') {
          stop(`over the limit of ${maxSteps} steps`)
        }
      } else if (event.type === 'error') {
        turn.error = JSON.stringify(event.error ?? event).slice(0, 1000)
      }
    }
    child.stdout.on('data', (chunk) => {
      out += chunk
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) read(line)
    })
    child.stderr.on('data', (chunk) => (err += chunk))
    child.on('error', failed)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (pending !== '') read(pending)
      done({
        ...turn,
        code,
        text: turn.texts.at(-1),
        costUsd: Number(turn.costUsd.toFixed(6)),
        stderr: err.slice(0, 2000),
        raw: out,
      })
    })
  })
}
