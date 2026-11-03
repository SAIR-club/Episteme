import { mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startService } from '@episteme/service'
import { it } from 'vitest'

it('closes without waiting for a connection that never asked anything', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'episteme-service-close-'))
  const service = await startService({ port: 0, graph: join(directory, 'learn.db') })
  const socket = connect(service.port, '127.0.0.1')
  socket.on('error', () => undefined)
  await new Promise((resolve) => socket.once('connect', resolve))
  const hungUp = new Promise((resolve) => socket.once('close', resolve))

  await service.close()

  await hungUp
  await rm(directory, { recursive: true, force: true, maxRetries: 5 })
})
