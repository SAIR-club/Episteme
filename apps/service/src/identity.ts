import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'

/**
 * Who a request is for, and whether it comes from the person or from one of their agents (ADR 0012).
 *
 * Everything here is resolved from a credential the service issued. Nothing a request body says can change it.
 */

/** A person's own credential, or one issued to one of their agents. */
export type CredentialKind = 'human' | 'agent'

/** The caller of one request, as its credential establishes it. */
export interface Caller {
  /** The person the request is for. */
  readonly actorId: string
  readonly kind: CredentialKind
  readonly credentialId: string
  /** What the credential was issued for, such as `workspace` or `claude-code`. */
  readonly label: string
}

/** `local` serves one person on loopback; `shared` serves the people in a user file, behind a proxy. */
export type DeploymentMode = 'local' | 'shared'

/** What a request asks to do. `decide` covers everything only a person may do (ADR 0012, decision 3). */
export type Operation = 'read' | 'decide'

export interface AccessRefusal {
  readonly status: 401 | 403
  readonly code: 'unauthenticated' | 'human_required'
  readonly message: string
}

/**
 * Whether `caller` may perform `operation`: the one place ADR 0012's table is written down.
 *
 * In local mode, reading, proposing and distilling need no credential, so hosts and existing clients keep
 * working. Deciding needs the person's own credential in either mode, and an agent's credential never stands in
 * for it.
 */
export function accessRefusal(
  mode: DeploymentMode,
  caller: Caller | undefined,
  operation: Operation,
): AccessRefusal | undefined {
  if (caller === undefined) {
    if (mode === 'local' && operation === 'read') return undefined
    return {
      status: 401,
      code: 'unauthenticated',
      message:
        operation === 'decide'
          ? 'this needs the person’s own token: the Workspace sends it, or pass it as a Bearer token'
          : 'this service needs a token: pass it as a Bearer token',
    }
  }
  if (operation === 'decide' && caller.kind !== 'human') {
    return {
      status: 403,
      code: 'human_required',
      message: `only the person can do this; the "${caller.label}" agent token cannot`,
    }
  }
  return undefined
}

interface TokenRecord {
  readonly id: string
  readonly kind: CredentialKind
  readonly label: string
  readonly salt: string
  readonly hash: string
  readonly createdAt: string
  readonly revokedAt?: string
}

/** What a person may see of one of their tokens: never its secret, salt or hash. */
export interface TokenSummary {
  readonly id: string
  readonly kind: CredentialKind
  readonly label: string
  readonly createdAt: string
  readonly revokedAt?: string
}

function summaryOf(record: TokenRecord): TokenSummary {
  return {
    id: record.id,
    kind: record.kind,
    label: record.label,
    createdAt: record.createdAt,
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
  }
}

interface PersonRecord {
  readonly actorId: string
  readonly displayName: string
  readonly tokens: readonly TokenRecord[]
}

interface UserFile {
  readonly schemaVersion: 1
  readonly people: readonly PersonRecord[]
}

const TOKEN = /^ep_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/

function digest(secret: string, salt: string): string {
  return scryptSync(secret, salt, 32).toString('hex')
}

/** A new token and the record that verifies it. The token itself is never stored. */
function issue(kind: CredentialKind, label: string): { token: string; record: TokenRecord } {
  const id = randomBytes(6).toString('hex')
  const secret = randomBytes(32).toString('base64url')
  const salt = randomBytes(16).toString('hex')
  return {
    token: `ep_${id}_${secret}`,
    record: {
      id,
      kind,
      label,
      salt,
      hash: digest(secret, salt),
      createdAt: new Date().toISOString(),
    },
  }
}

function parseUserFile(text: string, path: string): UserFile {
  const parsed = JSON.parse(text) as Partial<UserFile> | null
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.people)) {
    throw new Error(`"${path}" is not an Episteme user file (schemaVersion 1 with a people list)`)
  }
  return parsed as UserFile
}

/**
 * The people a service knows and their tokens.
 *
 * Backed by a user file in shared mode, re-read whenever the file changes, so a token revoked with the CLI is
 * refused at the next request. In local mode it holds one person in memory, whose human token is minted at
 * start.
 */
export class Directory {
  readonly #path: string | undefined
  #modified = 0
  #people: readonly PersonRecord[]
  /** Tokens already verified, so a request does not pay for `scrypt` twice. Cleared when the file changes. */
  readonly #verified = new Map<string, Caller>()
  /** The service's own writes to the user file, one at a time, so two requests cannot lose each other's change. */
  #writes: Promise<unknown> = Promise.resolve()

  private constructor(path: string | undefined, people: readonly PersonRecord[], modified: number) {
    this.#path = path
    this.#people = people
    this.#modified = modified
  }

  /** The people in the user file at `path`. A missing or unreadable file stops the service at start. */
  static async open(path: string): Promise<Directory> {
    const text = await readFile(path, 'utf8')
    return new Directory(path, parseUserFile(text, path).people, statSync(path).mtimeMs)
  }

  /** One person, in memory, with a human token minted now: local mode (ADR 0012, decision 1). */
  static single(actorId: string, displayName: string): { directory: Directory; token: string } {
    const { token, record } = issue('human', 'local')
    return {
      directory: new Directory(undefined, [{ actorId, displayName, tokens: [record] }], 0),
      token,
    }
  }

  /** The caller a token stands for, or `undefined` when it is unknown, malformed or revoked. */
  resolve(token: string): Caller | undefined {
    this.#reloadIfChanged()
    const known = this.#verified.get(token)
    if (known !== undefined) return known

    const match = TOKEN.exec(token)
    if (match === null) return undefined
    const [, id, secret] = match as unknown as [string, string, string]
    for (const person of this.#people) {
      const record = person.tokens.find((candidate) => candidate.id === id)
      if (record === undefined) continue
      if (record.revokedAt !== undefined) return undefined
      const expected = Buffer.from(record.hash, 'hex')
      const actual = Buffer.from(digest(secret, record.salt), 'hex')
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined
      const caller: Caller = {
        actorId: person.actorId,
        kind: record.kind,
        credentialId: record.id,
        label: record.label,
      }
      this.#verified.set(token, caller)
      return caller
    }
    return undefined
  }

  /** Whether people manage their own tokens here: only with a user file, that is, in shared mode. */
  get selfService(): boolean {
    return this.#path !== undefined
  }

  /** Whether the credential with this id exists and is not revoked, for a session opened with it earlier. */
  isLive(credentialId: string): boolean {
    this.#reloadIfChanged()
    return this.#people.some((person) =>
      person.tokens.some((token) => token.id === credentialId && token.revokedAt === undefined),
    )
  }

  /** A person's own tokens, revoked ones included, oldest first. */
  tokensOf(actorId: string): readonly TokenSummary[] {
    this.#reloadIfChanged()
    const person = this.#people.find((candidate) => candidate.actorId === actorId)
    return (person?.tokens ?? []).map(summaryOf)
  }

  /** Issues an agent token for a person. The secret is returned here and nowhere else, ever. */
  async issueAgentToken(
    actorId: string,
    label: string,
  ): Promise<{ readonly token: string; readonly summary: TokenSummary }> {
    return this.#change((file) => {
      if (!file.people.some((person) => person.actorId === actorId)) {
        throw new Error(`there is no person "${actorId}" in the user file`)
      }
      const { token, record } = issue('agent', label)
      return {
        file: withToken(file, actorId, record),
        result: { token, summary: summaryOf(record) },
      }
    })
  }

  /**
   * Revokes one of a person's own tokens, and returns it; `undefined` when the person has no token with that id,
   * whether or not someone else does. Revoking a revoked token changes nothing and returns it as it is.
   */
  async revokeOwnToken(actorId: string, tokenId: string): Promise<TokenSummary | undefined> {
    return this.#change((file) => {
      const record = file.people
        .find((person) => person.actorId === actorId)
        ?.tokens.find((token) => token.id === tokenId)
      if (record === undefined) return { result: undefined }
      if (record.revokedAt !== undefined) return { result: summaryOf(record) }
      const revokedAt = new Date().toISOString()
      return {
        file: withRevoked(file, tokenId, revokedAt),
        result: summaryOf({ ...record, revokedAt }),
      }
    })
  }

  /**
   * Applies one change to the user file as it is on disk now, so a change made with the CLI meanwhile is kept,
   * and makes it this directory's view at once. Changes run one after another.
   */
  async #change<T>(
    edit: (file: UserFile) => { readonly file?: UserFile; readonly result: T },
  ): Promise<T> {
    const path = this.#path
    if (path === undefined) throw new Error('there is no user file to change in local mode')
    const run = this.#writes.then(async () => {
      const { file, result } = edit(await readUsers(path))
      if (file !== undefined) {
        await writeUsers(path, file)
        this.#people = file.people
        this.#modified = statSync(path).mtimeMs
        this.#verified.clear()
      }
      return result
    })
    // The queue carries on after a failed change; the failure itself goes to the request that made it.
    this.#writes = run.catch(() => undefined)
    return run
  }

  #reloadIfChanged(): void {
    if (this.#path === undefined) return
    const modified = statSync(this.#path).mtimeMs
    if (modified === this.#modified) return
    this.#people = parseUserFile(readFileSync(this.#path, 'utf8'), this.#path).people
    this.#modified = modified
    this.#verified.clear()
  }
}

async function readUsers(path: string): Promise<UserFile> {
  try {
    return parseUserFile(await readFile(path, 'utf8'), path)
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { schemaVersion: 1, people: [] }
    throw error
  }
}

async function writeUsers(path: string, file: UserFile): Promise<void> {
  // A temporary file of its own, so the CLI and a running service never write into the same one.
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await rename(temporary, path)
}

/** Adds a person to the user file, creating it if needed, and returns their actor id. */
export async function addPerson(path: string, displayName: string): Promise<string> {
  const file = await readUsers(path)
  const slug = displayName
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  const base = `actor_human_${slug === '' ? 'person' : slug}`
  let actorId = base
  for (let index = 2; file.people.some((person) => person.actorId === actorId); index += 1) {
    actorId = `${base}-${index}`
  }
  await writeUsers(path, {
    ...file,
    people: [...file.people, { actorId, displayName, tokens: [] }],
  })
  return actorId
}

/** Issues a token for a person and returns it. It is shown once and cannot be read back later. */
export async function addToken(
  path: string,
  actorId: string,
  kind: CredentialKind,
  label: string,
): Promise<string> {
  const file = await readUsers(path)
  if (!file.people.some((person) => person.actorId === actorId)) {
    throw new Error(`there is no person "${actorId}" in "${path}"`)
  }
  const { token, record } = issue(kind, label)
  await writeUsers(path, withToken(file, actorId, record))
  return token
}

function withToken(file: UserFile, actorId: string, record: TokenRecord): UserFile {
  return {
    ...file,
    people: file.people.map((person) =>
      person.actorId === actorId ? { ...person, tokens: [...person.tokens, record] } : person,
    ),
  }
}

function withRevoked(file: UserFile, tokenId: string, revokedAt: string): UserFile {
  return {
    ...file,
    people: file.people.map((person) => ({
      ...person,
      tokens: person.tokens.map((token) =>
        token.id === tokenId && token.revokedAt === undefined ? { ...token, revokedAt } : token,
      ),
    })),
  }
}

/** Revokes a token by its id. A running service refuses it at the next request. */
export async function revokeToken(path: string, tokenId: string): Promise<void> {
  const file = await readUsers(path)
  if (!file.people.some((person) => person.tokens.some((token) => token.id === tokenId))) {
    throw new Error(`there is no token "${tokenId}" in "${path}"`)
  }
  await writeUsers(path, withRevoked(file, tokenId, new Date().toISOString()))
}

/** The cookie a Workspace holds instead of the person's token. */
export const SESSION_COOKIE = 'episteme_session'
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000

/**
 * Browser sessions: a random id in an `HttpOnly; SameSite=Strict` cookie, mapped in memory to a human caller.
 * They end when the service stops or after twelve hours.
 */
export class BrowserSessions {
  readonly #sessions = new Map<string, { readonly caller: Caller; readonly expiresAt: number }>()

  /** A new session for a human caller, and the `Set-Cookie` value that carries it. */
  open(caller: Caller): string {
    const id = randomBytes(32).toString('base64url')
    this.#sessions.set(id, { caller, expiresAt: Date.now() + SESSION_LIFETIME_MS })
    return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_LIFETIME_MS / 1000}`
  }

  resolve(id: string): Caller | undefined {
    const session = this.#sessions.get(id)
    if (session === undefined) return undefined
    if (session.expiresAt <= Date.now()) {
      this.#sessions.delete(id)
      return undefined
    }
    return session.caller
  }
}

/** The credential a request carries: a Bearer token, or else a session cookie. */
export function credentialOf(headers: {
  readonly authorization?: string | undefined
  readonly cookie?: string | undefined
}): { readonly token: string } | { readonly session: string } | undefined {
  const authorization = headers.authorization
  if (authorization !== undefined) {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim())
    return { token: match?.[1] ?? '' }
  }
  for (const part of (headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=')
    if (name === SESSION_COOKIE) return { session: value.join('=') }
  }
  return undefined
}
