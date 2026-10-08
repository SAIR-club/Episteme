import { readFile } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'

/**
 * Serves one prebuilt Workspace as static files (ADR 0010, decision 7).
 *
 * The service imports no Workspace code and starts without one. A Workspace served from here is same-origin,
 * so the boundary needs no exception for it. It reads and changes things only through the API, like any
 * other client.
 */

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/**
 * Where a request path points inside `root`, or `undefined` when it points outside it. `/` is the index.
 * The path is decoded first, so an encoded `..` cannot slip past the check.
 */
export function workspaceFile(root: string, path: string): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return undefined
  }
  if (decoded.includes('\0')) return undefined
  const base = resolve(root)
  const file = resolve(base, `.${decoded.endsWith('/') ? `${decoded}index.html` : decoded}`)
  return file === base || file.startsWith(`${base}${sep}`) ? file : undefined
}

/** Serves a file of the Workspace, or answers 404. Never anything outside the Workspace directory. */
export async function serveWorkspace(
  root: string,
  path: string,
  response: ServerResponse,
): Promise<void> {
  const file = workspaceFile(root, path)
  const type = file === undefined ? undefined : TYPES[extname(file).toLowerCase()]
  if (file === undefined || type === undefined) {
    notFound(response)
    return
  }
  let body: Buffer
  try {
    body = await readFile(file)
  } catch {
    notFound(response)
    return
  }
  response.writeHead(200, {
    'content-type': type,
    'cache-control': 'no-store',
    'content-length': body.length,
  })
  response.end(body)
}

function notFound(response: ServerResponse): void {
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('Not found.')
}

/** What `/` says when the service serves no Workspace: that it is running, and where to connect. */
export function noWorkspaceNotice(apiUrl: string, mcpUrl: string): string {
  return (
    `Episteme 服务正在运行，但没有托管 Workspace。\n` +
    `\n  REST API：${apiUrl}\n  MCP：     ${mcpUrl}\n` +
    `\n用 --workspace <目录> 启动服务，就能在这里打开一个 Workspace。\n`
  )
}
