# 0012 — Who is calling: people, agents and the decisions only people make

Status: **proposed** (2026-10-17). Answers #17 and extends it to a shared, networked service (#35). Amends
[ADR 0008](0008-agent-plugin-surface.md) (_Trust boundaries_) and [ADR 0010](0010-episteme-service.md)
(_Constraints_). [ADR 0014](0014-publication-and-reuse.md) (step S1) and ADR 0016 (delegated confirmation)
depend on it.

## Context

"Agents propose, people confirm" holds structurally: MCP has no decision tool, `confirmedBy` is injected by the
application, and every decision passes one use case. It does not hold against an agent with a shell.
`POST /api/v1/suggestions/decide` answers any local process, and `boundaryRefusal` checks only `Host`, `Origin`,
`Sec-Fetch-Site` and `Content-Type`, which `curl` passes. An agent in Claude Code can propose over MCP and accept
over REST. ADR 0008 and ADR 0010 record this as a known limitation; the First Real Learning Loop puts Episteme
inside exactly such agents.

The product now also needs more than one person (the development plan's D2 and D3): understanding is shared
through one service that a course's students reach over the network, each with several agents. Every request
then has to say who it is for, and whether it comes from the person or from one of their agents. Until it does,
nothing can be scoped to a person (ADR 0014), and no one can hand an agent the right to confirm (ADR 0016).

## Who can reach the service

| actor                                           | what it can do today                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| the person, through the served Workspace        | everything the REST API offers                                             |
| a host agent with MCP only                      | `recall`, `propose`, `distill`, `reflect`; answer an elicitation form       |
| a host agent with a shell, as the same OS user  | everything the person can: read their files, call REST, drive their browser |
| another process of the same OS user             | the same as a shell agent                                                  |
| another OS user on the machine                  | connect to the loopback port                                               |
| a web page the person visits                    | nothing: refused by the boundary (Host, Origin, Sec-Fetch-Site, JSON only) |
| a remote client (shared deployment)             | whatever its credentials allow                                             |
| the network between them (shared deployment)    | read and alter plain HTTP                                                  |

The third row is the one that matters and the one no local measure can close. A secret on the person's machine
(a file, an environment variable, a cookie, a token in a page) is readable by an agent running as the same OS
user. Such a secret prevents accidents and makes bypassing deliberate and visible. It does not separate the
person from their own agent, and nothing in Episteme may say it does.

## Decision

**Every request carries an actor and a kind, taken from a credential and never from the body. Deciding,
recording, writing nodes and edges, publishing, adopting and delegating need a person's credential. An
agent's credential can read, propose and distill, and nothing else.**

### 1. Two deployment modes, one code path

- **`local`** (the default): binds to loopback, serves one person. When no user file is configured, the service
  creates that one person in memory and mints a fresh **human token at every start**. The served Workspace
  receives it as a cookie when its page is loaded; the start-up output prints it for a client that is not the
  Workspace. Only what a person alone may do needs it (decision 3): reading, proposing and distilling need no
  token in this mode, over REST or MCP, so `claude mcp add --transport http …` and every existing client keep
  working, and a caller without a token is identified by its MCP client name as it is today (provenance, not
  authentication).
- **`shared`**: binds to a configured address behind an HTTPS reverse proxy, serves the people in a user file.
  Every request, REST and MCP alike, must carry a token. The service refuses to start in this mode without a
  user file and a configured public origin.

Local mode is therefore shared mode with one person whose token is minted per start. Authorization is written
once.

### 2. People, tokens and kinds

- A **user file** lists people: `{ actorId, displayName, tokens: [{ id, kind, label, hash, createdAt, revokedAt? }] }`.
  Only a salted `scrypt` hash of each token is stored; a token is shown once, when it is created.
- **Kinds.** A `human` token is the person's own, for the Workspace and for anything they do by hand. An `agent`
  token is issued per host (`label: "claude-code"`, `"codex"`). An agent token's actor is
  `actor_agent_<label>` acting for that person, which is what `proposedBy` records.
- **Transport.** `Authorization: Bearer <token>` for API and MCP clients. The Workspace exchanges a human token
  once, at `POST /api/v1/session`, for an `HttpOnly; SameSite=Strict` cookie holding a random session id that the
  service keeps in memory and expires; in local mode the served page receives that cookie directly.
- **Administration** is a CLI on the machine that runs the service: `episteme users add <name>`,
  `episteme tokens add <actor> --kind human|agent --label <label>`, `episteme tokens revoke <id>`. No sign-up,
  email or third-party login in this version.

### 3. What each kind may do

Resolved in one place, before any route or tool runs:

| operation                                                        | human | agent | none (local) | none (shared) |
| ---------------------------------------------------------------- | ----- | ----- | ------------ | ------------- |
| read: state, recall, reflect, history, vocabulary, suggestions   | yes   | yes   | yes          | no            |
| propose, distill                                                 | yes   | yes   | yes          | no            |
| decide a suggestion, record, add a node or edge                  | yes   | **no** | **no**      | no            |
| publish, adopt, withdraw (ADR 0014)                              | yes   | **no** | **no**      | no            |
| grant or revoke delegation (ADR 0016)                            | yes   | **no** | **no**      | no            |
| scene routes and scene MCP tools (ADR 0013)                      | yes   | yes   | yes          | no            |

A request without a credential where one is needed is refused with `401 unauthenticated`. A credential of the
wrong kind is refused with `403 human_required`. Both change nothing.

### 4. Elicitation

An answer to an MCP elicitation form stays an accepted decision channel **in local mode only**, as a
trusted-host boundary (ADR 0008): the host is the person's own program on the person's own machine. In shared
mode the service cannot know whether a remote host showed the form to anyone, so elicitation decisions are
refused unless the service is started with `--trust-elicitation`, and the start-up output says so.

### 5. Review records, for detection after the fact

Every decision, including a dismissal, records the channel, the credential's id and label, and the
`User-Agent` it arrived with, beside the suggestion's resolution and outside the understanding events (target.md,
constraint 3). A self-confirmation by a shell agent cannot be prevented locally, but it can be found and revoked.
Recording dismissals also settles #25's `not_pending` ambiguity.

## What is guaranteed, and what is not

| claim                                                                          | local          | shared      |
| ------------------------------------------------------------------------------ | -------------- | ----------- |
| a web page cannot read or write through the service                            | yes (boundary) | yes (boundary, origin list) |
| an agent with MCP only cannot decide                                           | yes            | yes         |
| an agent token cannot decide, over any protocol                                | yes            | yes         |
| an actor cannot be named in a request body                                     | yes            | yes         |
| one person cannot read another's private understanding                         | n/a            | with ADR 0014 S2–S3 |
| an agent with a shell, as the same OS user, cannot decide                      | **no**         | **no**, on that person's machine |
| an elicitation answer came from a person                                       | **no** (trusted host) | refused by default |
| a decision can be traced to its channel and credential                         | yes            | yes         |

**Not guaranteed**, and to be stated wherever the subject comes up:

- A token, cookie or file on the person's machine does not isolate the person from an agent running as their
  OS user. Such an agent can decide in their name, in either mode.
- Episteme does not encrypt the graph at rest (roadmap, Phase 4).
- In shared mode, transport security is the reverse proxy's. The service speaks plain HTTP behind it.

The wording for the service README, the MCP README, target.md constraint 1 and the Claude Code plugin:

> Agents can only propose. Deciding needs the person's own token, which an agent's token cannot replace. This
> stops accidents and makes a bypass deliberate and visible. It does not stop an agent that runs as you, with a
> shell, from using your token: run such agents with a host policy that forbids calling the decision routes.

## Testing (binding on the implementation, #38)

- Replace `it.todo('keeps an agent from deciding its own proposal over REST, …')` in
  `tests/cross-agent-loop.test.ts` with a passing test that a decision with an agent token, or with no token,
  is refused with its code and changes nothing; its name or a comment says it does **not** show that a
  same-user shell agent is prevented from deciding. The existing human decision path in that file keeps
  passing.
- Every row of the table in decision 3, over REST and MCP, in both modes.
- An actor or `confirmedBy` in a request body is ignored.
- Shared mode refuses to start without a user file and a public origin.
- A revoked token is refused at once.
- A dismissal leaves a review record naming its channel and credential.

## Consequences

- ADR 0008's _Trust boundaries_ and ADR 0010's first two _Constraints_ are amended: the missing enforcement is
  replaced by the table in decision 3, and the limitation that remains is narrowed to same-user agents.
- `LearnSession`'s single hard-coded `HUMAN` becomes the actor resolved per request. ADR 0014 S3 turns that into
  one session per actor.
- A Workspace must send a cookie or a token. The served Workspace gets one without the person doing anything.
- In local mode, reads, proposals and distillation stay token-free, so the one-line host setup and existing
  clients do not change; only deciding, recording and writing need the person's token. Shared mode needs a token
  for everything, and an agent token in the host's configuration.
- Tokens are bearer secrets. Losing one means revoking it with the CLI.

## Alternatives considered

- **Status quo plus documentation.** Leaves an agent token and no token indistinguishable from the person, and
  gives ADR 0014 and ADR 0016 nothing to stand on.
- **User-presence verification (WebAuthn with user verification) for each decision.** The only measure that
  separates a person from their own shell agent. Rejected for now: a learner reviewing a dozen suggestions would
  touch a key a dozen times, and it needs a secure context the local service does not have. Worth revisiting
  for delegation grants and publishing, which are rare.
- **OS-level separation** (the service as another OS user, or in a container, with the token readable only by
  the Workspace). Effective, but it turns installing Episteme into system administration.
- **Host-side policy only** (for example Claude Code permission rules that deny the decision routes). Useful as
  defence in depth, and recommended in the wording above, but enforced by the host, not by Episteme.
- **OAuth or email sign-up.** Not needed for one course's pilot; the CLI covers it, and the token model does
  not preclude adding a login later.
