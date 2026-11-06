# @episteme/service

The Episteme service: the single owner of a graph, serving MCP to agents and a versioned REST API to
human-facing clients, behind one boundary. See [ADR 0010](../../docs/decisions/0010-episteme-service.md).

It is an application because it is a process, and it depends on no other application. A Workspace, the Learn
page included, is a client of it.

## Starting it

```bash
pnpm --filter @episteme/service serve -- --graph ~/.episteme/learn.db
```

| option                  | meaning                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `-g, --graph <path>`    | the graph to own, a SQLite file (`--file`, `-f` and `EPISTEME_FILE` also work); default `~/.episteme/learn.db` |
| `-p, --port <port>`     | the port on `127.0.0.1` (`PORT` also works); default `4321`                                        |
| `-t, --topic <path>`    | a topic file to seed on first start, instead of the demonstration topic                            |
| `--blank`               | seed nothing                                                                                       |
| `-w, --workspace <dir>` | serve a prebuilt Workspace from this directory at `/`                                              |
| `--mode shared`         | serve the people in a user file, over the network, behind an HTTPS proxy (ADR 0012)                |
| `--users <path>`        | the user file (`EPISTEME_USERS` also works); default `~/.episteme/users.json`                      |
| `--public-origin <url>` | where people reach a shared deployment, such as `https://episteme.example.edu`; required to share  |
| `--host <address>`      | the address to bind; default `127.0.0.1`                                                           |
| `--trust-elicitation`   | in shared mode, still take an elicitation form answer as the person's decision                     |

It prints the MCP address, the REST address, the graph it owns, and the Workspace address when it serves one.
In local mode it also prints the person's token for this run (see _Trust_).
While it runs it holds the graph's lock, so a second service or the Learn terminal on the same graph is refused
with the holder's process id.

`startService(options)` starts the same service from code, and `close()` releases the graph.

To run one service that a course shares, over the network, see [docs/deployment.md](../../docs/deployment.md).

People and tokens of a shared deployment are managed on the machine that runs it:

```bash
pnpm serve users add "Lin"                                        # prints the person's actorId
pnpm serve tokens add <actorId> --kind human --label workspace    # the person's own token, shown once
pnpm serve tokens add <actorId> --kind agent --label claude-code  # one per host the person uses
pnpm serve tokens revoke <token id>                               # refused from the next request
```

The user file holds only a salted `scrypt` hash of each token. A person can also list their own tokens, issue
agent tokens and revoke them over REST (`/api/v1/tokens`, below), with their own credential.

## Trust

Read this before connecting anything.

- **Agents can only propose. Deciding needs the person's own token, which an agent's token cannot replace.**
  This stops accidents and makes a bypass deliberate and visible. It does not stop an agent that runs as you,
  with a shell, from using your token: run such agents with a host policy that forbids calling the decision
  routes ([ADR 0012](../../docs/decisions/0012-human-review-security.md)).
- **Who a request is for comes from its credential**, `Authorization: Bearer <token>` or the Workspace's session
  cookie, never from its body. Deciding a suggestion, recording understanding and adding a node need a `human`
  credential; an `agent` credential can read, propose and distill.
- **Local mode** serves one person on loopback. Their token is minted at each start and printed; the served
  Workspace receives a session cookie for it without the person doing anything. Reading, proposing and
  distilling need no token, so hosts connect with `claude mcp add --transport http …` as before.
- **Shared mode** needs a token for every request, REST and MCP alike, and refuses to start without a user file
  and a public origin. An elicitation form answer is not taken as a decision unless `--trust-elicitation` is
  given, because the service cannot know whether a remote host showed the form to anyone.
- **Every decision is recorded** with its channel, credential and user agent, dismissals included
  (`GET /api/v1/reviews`), so a decision made in the person's name can be found and revoked.
- **The boundary is a network boundary.** Every request passes `boundaryRefusal` first: `Host` must be a
  loopback name with this port, a browser's `Origin` must be the service's own, `Sec-Fetch-Site` must not be
  cross-site, and anything that changes state must be sent as `application/json`. This keeps other web pages
  out. It does not tell local processes apart; credentials do. In shared mode the public origin is accepted
  beside the loopback names.

## REST API, version 1

Everything lives under `/api/v1`. Requests and results are JSON. A breaking change gets `/api/v2` rather than
an edit in place.

### Revisions

Reads, and the results of changes, carry an `epoch` and a `revision`: which state of the graph, the history and
the drafts they describe. The revision is even while nothing changes and odd while a change is in progress.
Two results with the same `epoch` and the same even `revision` describe the same state, so a client that drew
one screen from several reads can tell whether they agree. An odd revision promises nothing; read again. The
revision may advance without a visible change and never stays put across one. It counts from zero each time
the service starts, and each start has a new `epoch`, so compare the pair, never the revision alone.

### Errors

Every error has the same shape: `{ "error": "<message>", "code": "<code>" }`.

| status | meaning                                               | `code`                         |
| ------ | ----------------------------------------------------- | ------------------------------ |
| 400    | the request does not have the shape the route needs   | `invalid_request`              |
| 401    | no credential where one is needed, or an invalid one  | `unauthenticated`              |
| 403    | an agent's credential where only the person may act   | `human_required`               |
| 403    | the request comes from outside the boundary           | `outside_boundary`             |
| 404    | no such route, or no such node                        | `no_route`, `unknown_node`     |
| 404    | no such token of the caller's, whether or not it exists | `unknown_token`              |
| 415    | a change not sent as `application/json`               | `outside_boundary`             |
| 422    | understood, and refused: the application's own reason | the application's refusal code |
| 500    | a defect in the service                               | `internal`                     |

### Routes

| route                             | does                                                                                                                               | changes anything |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `GET /api/v1/state`               | everything a Workspace draws in one read: nodes, understanding, open ends, progress, pending suggestions, dimensions, scene, topic | no               |
| `GET /api/v1/vocabulary`          | every registered dimension with its levels, which levels are legacy, and whether the scene lets a person record it                 | no               |
| `GET /api/v1/suggestions`         | the pending suggestions                                                                                                            | no               |
| `GET /api/v1/reviews`             | every decision on a suggestion, dismissals included, with its channel and credential                                               | no               |
| `POST /api/v1/session`            | `{ token }` → a Workspace session cookie, for the person's own `human` token only                                                  | no               |
| `GET /api/v1/tokens`              | the caller's own tokens: `{ tokens: [{ id, kind, label, createdAt, revokedAt?, current }] }`, never a secret; shared mode only | no               |
| `POST /api/v1/tokens`             | `{ label }` → `{ token: { id, kind: agent, label, createdAt }, secret }`: a new agent token, its secret shown this once            | users file       |
| `POST …/tokens/:id/revoke`        | `{ token }` with `revokedAt`: refused from the next request, REST and MCP; not the token the request is made with                | users file       |
| `GET /api/v1/delegations`         | the caller's delegations, live and revoked (ADR 0016)                                                                              | no               |
| `POST /api/v1/delegations`        | `{ scope? }` → the service confirms agent proposals in that scope for the person                                                   | yes              |
| `POST …/delegations/:id/revoke`   | stops it from the next proposal on                                                                                                 | yes              |
| `POST …/reviews/:suggestion/undo` | revokes what a delegated decision committed; `GET /reviews?channel=delegation` lists them                                          | yes              |
| `POST /api/v1/publications/preview` | `{ root, include?, threads?, supersedes?, note? }` → what becomes public and what stays private (ADR 0014)                         | no               |
| `POST /api/v1/publications`       | the same body → the publication; needs `--sharing` and the person's own token                                                      | yes              |
| `GET /api/v1/publications`        | live publications, newest first (`?author=`, `?scope=`, `?q=`)                                                                     | no               |
| `GET /api/v1/publications/:id`    | members, relations, thread summaries (never raw turns), author and version chain                                                   | no               |
| `POST …/publications/:id/withdraw` | the author withdraws it; others stop reading it                                                                                    | yes              |
| `POST …/publications/:id/adopt`   | `{ node, dimensions, reason? }` → the caller's own state event naming the publication                                              | yes              |
| `GET /api/v1/updates`             | adopted publications that have a newer live version, with what changed                                                             | no               |
| `GET /api/v1/threads`             | the caller's conversation threads, newest first (`?scope=` narrows); ADR 0015                                                      | no               |
| `POST /api/v1/threads`            | `{ title, scope?, hostSession? }` → a new thread                                                                                   | archive only     |
| `GET /api/v1/threads/:id`         | the thread, its turns raw (owner only) and their current summaries                                                                 | no               |
| `POST /api/v1/threads/:id/turns`  | `{ speaker: learner | agent, text }` → the turn, kept raw                                                                          | archive only     |
| `POST …/turns/:turn/summary`      | `{ text, quotes }` → the summary; a learner turn needs a verbatim quote                                                            | archive only     |
| `POST /api/v1/threads/:id/fork`   | `{ turn, title? }` → a new line from that turn                                                                                     | archive only     |
| `GET /api/v1/scene-records/:ns`   | the caller's latest records in a scene's namespace (`?prefix=`)                                                                    | no               |
| `GET/PUT …/scene-records/:ns/:key` | one record; `PUT { value }` writes the next version, `null` removes it                                                             | scene data only  |
| `POST /api/v1/recall`             | `{ question, scope?, depth?: summary | full, budget? }` → what is understood that bears on it, and why; same as MCP `recall`       | no               |
| `GET /api/v1/reflect`             | progress and the number of pending suggestions. Same result as MCP `reflect`                                                       | no               |
| `GET /api/v1/nodes/:id/history`   | every recorded change of understanding of one node, in the persisted form                                                          | no               |
| `GET /api/v1/nodes/:id`           | one node in full: its words, your state, visible neighbours, origin; same as MCP `expand`                                          | no               |
| `POST /api/v1/suggestions/decide` | `{ id, action: accept \| modify \| dismiss, proposal? }` → the person's decision on one suggestion                                 | yes              |
| `POST /api/v1/distill`            | `{ text, title? }` → pending suggestions distilled from material. Same result as MCP `distill`                                     | drafts only      |
| `POST /api/v1/record`             | `{ target, dimensions, reason? }` → what the person states about their own understanding                                           | yes              |
| `POST /api/v1/nodes`              | `{ label, kind?: claim \| concept }` → a node of the person's own                                                                  | yes              |

The three token routes need the person's own credential (`403 human_required` for an agent's). A `kind` other
than `agent` is refused with `422 agent_tokens_only`, revoking the token in use with `422 current_credential`,
and in local mode, which has no user file, all three answer `422 not_available_in_local_mode`.

A scene may add routes of its own under `/api/v1/scene/<profile name>/…` (ADR 0013, _Scene extensions_). They
answer with the same revision fields and error format, and cannot decide or record.

There is no route that answers a question. The service recalls, validates, records and projects. Writing an
answer from what was recalled belongs to the agent, or to a client that has one.

`suggestions/decide` takes `modify` with a full replacement proposal of the same kinds MCP `propose` accepts:
`node` (`nodeType`, `label`, `properties?`), `claim` (`label`, `about?`), `link` (`from`, `to`, `relation`) and
`state` (`target`, `dimension`, `level`).

## Layout

| File               | Contents                                                 |
| ------------------ | -------------------------------------------------------- |
| `src/server.ts`    | `startService`: ownership, seeding, routing, closing     |
| `src/api.ts`       | the REST API, version 1                                  |
| `src/boundary.ts`  | `boundaryRefusal`, in front of everything served         |
| `src/profile.ts`   | the scene profile the service is composed with           |
| `src/workspace.ts` | serving a prebuilt Workspace, and only what is inside it |
| `src/serve.ts`     | the command line                                         |
