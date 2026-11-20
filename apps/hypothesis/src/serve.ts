#!/usr/bin/env node
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { startService } from '@episteme/service'
import { hypothesisProfile } from './index.js'

/** Serves the hypothesis scene: REST and MCP on one graph file. There is no page. */

const { values } = parseArgs({
  options: {
    graph: { type: 'string', short: 'g' },
    port: { type: 'string', short: 'p' },
  },
})

const service = await startService({
  graph: values.graph ?? join(homedir(), '.episteme', 'hypothesis.db'),
  port: Number.parseInt(values.port ?? '4325', 10),
  profile: hypothesisProfile,
})

process.stdout.write(
  `\nEPISTEME: hypothesis scene\n\n  REST:  ${service.apiUrl}/scene/hypothesis/hypotheses\n` +
    `  MCP:   ${service.mcpUrl}\n  Graph: ${service.graph}\n  Your token for this run: ${service.humanToken ?? ''}\n\n`,
)
const stop = (): void => {
  service
    .close()
    .then(() => process.exit(0))
    .catch(() => process.exit(1))
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
