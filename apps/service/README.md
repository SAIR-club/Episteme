# @episteme/service

The Episteme service: the single owner of a graph, serving MCP to agents and a versioned REST API to
human-facing clients, behind one boundary. See [ADR 0010](../../docs/decisions/0010-episteme-service.md).

It is an application because it is a process, and it depends on no other application. A Workspace, the Learn
page included, is a client of it.

## Starting it

```bash
pnpm --filter @episteme/service serve -- --graph ~/.episteme/learn.jsonl
```

| option                  | meaning                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `-g, --graph <path>`    | the graph to own (`--file`, `-f` and `EPISTEME_FILE` also work); default `~/.episteme/learn.jsonl` |
| `-p, --port <port>`     | the port on `127.0.0.1` (`PORT` also works); default `4321`                                        |
| `-t, --topic <path>`    | a topic file to seed on first start, instead of the demonstration topic                            |
| `--blank`               | seed nothing                                                                                       |
| `-w, --workspace <dir>` | serve a prebuilt Workspace from this directory at `/`                                              |

It prints the MCP address, the REST address, the graph it owns, and the Workspace address when it serves one.
While it runs it holds the graph's lock, so a second service or the Learn terminal on the same graph is refused
with the holder's process id.

`startService(options)` starts the same service from code, and `close()` releases the graph.

## Trust

Read this before connecting anything.

- **Protocol separation is not authorization.** REST serves human-facing clients and MCP serves agents, but the
  protocol a request uses says nothing about who sent it. Any process that can reach `127.0.0.1` on this port
  can call the REST API, including the route that decides a suggestion. That is a known limitation of the
  local-only deployment, not a guarantee.
- **Review decisions remain the person's.** MCP offers no decision tool. Once identity and per-operation
  permissions exist, a decision will be committed only through an authenticated channel the person controls.
  Until then, only connect clients you trust, and do not expose the port beyond the machine.
- **The boundary is a network boundary.** Every request passes `boundaryRefusal` first: `Host` must be a
  loopback name with this port, a browser's `Origin` must be the service's own, `Sec-Fetch-Site` must not be
  cross-site, and anything that changes state must be sent as `application/json`. This keeps other web pages
  out. It does not tell local processes apart.

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
| 403    | the request comes from outside the boundary           | `outside_boundary`             |
| 404    | no such route, or no such node                        | `no_route`, `unknown_node`     |
| 415    | a change not sent as `application/json`               | `outside_boundary`             |
| 422    | understood, and refused: the application's own reason | the application's refusal code |
| 500    | a defect in the service                               | `internal`                     |

### Routes

| route                             | does                                                                                                                               | changes anything |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `GET /api/v1/state`               | everything a Workspace draws in one read: nodes, understanding, open ends, progress, pending suggestions, dimensions, scene, topic | no               |
| `GET /api/v1/suggestions`         | the pending suggestions                                                                                                            | no               |
| `POST /api/v1/recall`             | `{ question }` → what is already understood that bears on it, and why. Same result as MCP `recall`                                 | no               |
| `GET /api/v1/reflect`             | progress and the number of pending suggestions. Same result as MCP `reflect`                                                       | no               |
| `GET /api/v1/nodes/:id/history`   | every recorded change of understanding of one node, in the persisted form                                                          | no               |
| `POST /api/v1/suggestions/decide` | `{ id, action: accept \| modify \| dismiss, proposal? }` → the person's decision on one suggestion                                 | yes              |
| `POST /api/v1/distill`            | `{ text, title? }` → pending suggestions distilled from material. Same result as MCP `distill`                                     | drafts only      |
| `POST /api/v1/record`             | `{ target, dimensions, reason? }` → what the person states about their own understanding                                           | yes              |
| `POST /api/v1/nodes`              | `{ label, kind?: claim \| concept }` → a node of the person's own                                                                  | yes              |

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
