import type { IncomingMessage } from 'node:http'

/** The host names the service answers to. It binds to the loopback address and to nothing else. */
const LOCAL_HOSTNAMES: readonly string[] = ['127.0.0.1', 'localhost', '[::1]']

/**
 * Why a request must not reach the service, or `undefined` when it may.
 *
 * The service has no authentication, so what keeps another web page from using it is that the page is not
 * one it serves. Without these checks, a site the learner visits could write their understanding with a
 * cross-site POST, accept a pending suggestion in their name, or, by rebinding its own host name to
 * 127.0.0.1, read everything the learner has recorded.
 *
 * - **Host** must be a loopback name with the service's port. A rebound host name arrives with the
 *   attacker's name in it.
 * - **Origin**, when a browser sends one, must be the service's own origin. A client that is not a browser,
 *   such as an MCP host, sends none.
 * - **Sec-Fetch-Site**, when present, must be `same-origin` or `none`. It covers cross-site reads a browser
 *   sends without an Origin, such as an image or a script tag pointed at the API.
 * - **Content-Type** must be JSON on anything that is not a read. A cross-site page can only send a
 *   form or text body without asking first, and the browser's preflight for JSON is never answered.
 *
 * This is a network boundary, not authorization: any local process can still connect, and which protocol it
 * uses says nothing about who it is (ADR 0010, _Constraints_).
 */
export function boundaryRefusal(
  request: IncomingMessage,
  port: number,
): { readonly status: number; readonly error: string } | undefined {
  const allowedHosts = LOCAL_HOSTNAMES.map((name) => `${name}:${port}`)
  const host = request.headers.host?.toLowerCase()
  if (host === undefined || !allowedHosts.includes(host)) {
    return { status: 403, error: `host "${host ?? ''}" is not this local service` }
  }

  const origin = request.headers.origin
  if (
    origin !== undefined &&
    !allowedHosts.map((name) => `http://${name}`).includes(origin.toLowerCase())
  ) {
    return { status: 403, error: `requests from "${origin}" are not accepted` }
  }

  const site = request.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    return { status: 403, error: `${site} requests are not accepted` }
  }

  const method = request.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') {
    const type = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
    if (type !== 'application/json') {
      return {
        status: 415,
        error: 'a request that changes anything must be sent as application/json',
      }
    }
  }
  return undefined
}
