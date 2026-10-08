# 0010 — The Episteme service: one host that no surface owns

Status: **accepted** (2026-10-08). Amends [ADR 0008](0008-agent-plugin-surface.md).

## Context

[ADR 0008](0008-agent-plugin-surface.md) made one local process the single owner of a learner's graph, and
put that process inside the Learn application. `apps/learn` opens the graph and holds its lock. It serves the
Learn page, the review queue, a set of unversioned `/api/*` routes and the `/mcp` endpoint, and it seeds the
demonstration topic when it starts. That was the shortest path to a working host, and it has three costs.

- **The host lives inside one surface.** Every other surface the [target architecture](../architecture/target.md)
  plans needs the host but not the Learn page: a Workspace with its own views, an Obsidian plugin, a Claude
  Code plugin, the terminal. Each would either depend on an app, which the layering forbids, or open the
  graph itself, which the single owner forbids.
- **The Learn application cannot move.** Moving `apps/learn` to a repository of its own (SAIR-club/learner)
  would take the host, the review queue and the MCP endpoint with it, and Episteme would no longer contain
  the thing agents connect to.
- **The HTTP routes are an accident of one page.** They are shaped by what `index.html` needs, carry no
  version, and mix operations the service should offer with ones it should not. `/api/ask` produces an answer
  with Learn's scripted responder, and Episteme is not an agent (ADR 0008).

The target architecture draws the host as a service of its own, reached through one gateway that serves MCP
and REST, with the Workspace and every agent as its clients. This ADR decides that boundary. It changes where
the host runs and how it is reached. It does not change what the host does.

## Decision

**The host becomes the Episteme service, an application of its own. It exclusively owns the storage it is
configured with, and every surface, including Learn, reaches that storage only through its API.**

1. **One process, one owner, now in `apps/service`.** The service opens the storage it is configured with and
   holds its lock: today one learner's graph, with the drafts and sources files beside it. It is the only
   process that writes any of them. ADR 0008's single-owner rules carry over unchanged: a second opener fails
   and names the holder, and nothing falls back to a private copy. It is started with `pnpm serve` (`--graph`,
   `--port`), and it prints the MCP and REST addresses, and the Workspace address when one is served.
2. **One gateway, two protocols, one boundary.** The service serves MCP at `/mcp` and REST under `/api/v1`.
   Both sit behind the boundary that protects the Learn host today (`boundaryRefusal`: loopback `Host`, own
   `Origin`, no cross-site fetch, JSON for anything that changes state), which moves into the service. MCP
   keeps the tools of ADRs 0008 and 0009.
3. **REST serves human-facing clients; MCP serves agent-facing clients.** REST offers what a Workspace needs:
   reading the graph, a node's history and the pending suggestions; `recall`; deciding a suggestion;
   distilling material; and recording what the person states themselves. MCP offers no decision tool. Over MCP
   an agent may create, retrieve and explain review candidates, and link to them; it never decides one. This
   separates purposes. It does not establish who is calling (see _Constraints_).
4. **One set of commands and queries behind both protocols.** Every REST route and every MCP tool calls the
   same commands and queries in `@episteme/application`, so the two cannot drift apart. Where several
   projections must describe the same state, as the graph, the pending suggestions and a node's history do on
   one screen, the API returns the graph revision they were read at. Contract tests check that REST and MCP
   give the same answer to the same question.
5. **The service never answers.** It recalls, validates, records and projects. Producing an answer from the
   recalled understanding belongs to the agent, or to a surface that has one. `/api/ask` does not move into the
   service. Learn's scripted responder stays with Learn as a demonstration, in front of `recall`.
6. **The REST contract is versioned and documented.** Routes live under `/api/v1`. Requests and results are
   JSON, refusals come back as values with a code, as they do over MCP, and the contract is written down in the
   service's README. A breaking change gets `/api/v2`, not an edit in place.
7. **A Workspace is a deployable client, not a dependency of the service.** It reads and changes things only
   through the documented API, never opens a storage file, and imports no Episteme package beyond the types
   of the contract. The service can serve one prebuilt Workspace as static files from a directory named at
   start (`--workspace`). It is then same-origin, so the boundary needs no exception. The service imports no
   Workspace code and starts without a Workspace build. Until a Workspace of its own exists, the existing
   Learn page is that build. Where the Workspace's source lives, in this repository or in SAIR-club/learner,
   is a team decision. The boundary is the same either way.
8. **The scene is configured, not assumed.** The service is composed with a scene profile: the domain packs,
   the dimensions a person may record, the distillation policy, and what to seed on first start. The only
   profile now is Learn's, so behaviour does not change. Making `@episteme/application` itself scene-neutral
   is the existing _Splitting `LearnSession`_ item in the roadmap, and this decision does not wait for it.
9. **Direct terminal access is transitional.** The terminal surface (`pnpm learn`) still opens the graph
   directly, and the lock refuses it while the service runs. That is kept only for compatibility while
   surfaces migrate. Ordinary terminal use is to go through the service, and direct file access is to be
   reserved for explicit offline maintenance. The stdio shim, when it is built, forwards to the service
   instead of to the Learn host.

### Constraints

These hold for the service from its first version, including the parts this ADR does not yet build.

- **Protocol separation is not authorization.** The protocol a request arrives on says nothing about who sent
  it or what they may do. In the first, local-only deployment, any process that can reach the REST endpoint
  can attempt a review decision. That is a known limitation, and nothing may describe it as a security
  guarantee. Before the service supports untrusted local agents, remote access or more than one user, it must
  enforce the caller's identity and per-operation permissions. An agent must not gain the authority to decide
  by calling REST instead of MCP.
- **Review decisions remain the person's.** Agents never receive an authoritative decision tool. Once identity
  and permissions exist, a decision is committed only through an authenticated channel the person controls.
  Until then, the missing enforcement stays a documented trust limitation (ADR 0008, _Trust boundaries_).
- **Ownership is distinct from scope.** The service owns its configured storage, not a learner's identity. One
  learner's graph per service instance is the current deployment, not part of the boundary. Scopes to come,
  for a learner, a course or shared subject knowledge, must fit behind the same service boundary.
- **Conversation structure is Episteme data.** Conversation turns, their parent-child relationships, branches
  and source references belong to Episteme's data model, held authoritatively by the service. They are kept
  beside the understanding graph, not in it, as material is ([ADR 0009](0009-distillation.md)). A Workspace
  may project them as a tree; it never owns them. A conversation imported from a host keeps its source
  provenance, and is not stored as a complete tree when the host did not supply its branches.

What moves, concretely:

| from                                                   | to                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------- |
| `startLearnServer`, the route table, `boundaryRefusal` | `apps/service`                                             |
| `/api/state`, `/api/suggestions`, `/api/distill`, …    | `/api/v1/…`, documented                                    |
| seeding on start                                       | the Learn scene profile                                    |
| `/api/ask` and the scripted responder                  | stays with Learn, in front of `recall`                     |
| `public/index.html`                                    | the default Workspace build, served by `--workspace`       |
| `pnpm learn:web`                                       | `pnpm serve`, which serves the Learn page as its Workspace |

## Alternatives

**Keep the host inside Learn (ADR 0008 as it stands).** This is the cheapest option, and it was right for one
surface. Rejected because every planned surface would then depend on an application, and the Learn
application could never leave this repository.

**Embed the service as a library in each surface.** Each surface would open the graph through the same
package. Rejected for the reasons ADR 0008 rejected one process per client: two owners of one file diverge,
and no lock makes their in-memory graphs agree.

**Give the Workspace MCP only.** One protocol is simpler. Rejected because MCP is the agent surface and
deliberately has no confirm operation. A Workspace needs exactly the human operations that MCP must not
offer. Adding them as tools would put a confirm tool back within every agent's reach.

**Run MCP and REST as two processes.** Rejected because both read and write the same graph, and the single
owner is what keeps them consistent.

**Serve the Workspace from its own origin and allow it through CORS.** This lets a Workspace's development
server talk to the service directly. Deferred, not rejected: it widens the boundary by an allowlist of
origins, and that list then needs its own protection. Same-origin static serving needs no change to the
boundary and comes first.

**Move `apps/learn` out of the repository first and build the service afterwards.** This is the order the
pending extraction proposes. Rejected as an order, not as a goal: moving Learn first takes the only host with
it. Once the service exists, Learn can move without taking anything else.

## Consequences

- ADR 0008 is amended, not replaced. Its single owner, its tools, its decision path and its trust boundaries
  all hold. What changes is the process they live in: _the existing Learn web surface becomes the place
  suggestions are reviewed_ now reads _the Workspace the service serves is where suggestions are reviewed_.
- New surfaces become possible without new owners: a Workspace of its own, an Obsidian plugin, and the
  Claude Code plugin's commands all reach the same graph through the same API.
- The Learn application can then leave this repository. Its page becomes a Workspace build, and its CLI and
  responder become a client and a demonstration. What stays in Episteme is everything agents and Workspaces
  connect to.
- **Breaking for anyone using the HTTP routes.** `/api/*` becomes `/api/v1/*`, `/api/ask` leaves the service,
  and `pnpm learn:web` becomes `pnpm serve`. The tests that start the Learn server start the service instead.
  No data format changes: the graph, drafts and sources files are read exactly as before.
- **Trust is unchanged, and is said to be.** Any local process can still call `/api/v1` and decide a
  suggestion, as it can call the Learn routes today (ADR 0008, _Trust boundaries_). The service's README and
  the MCP package's _Trust_ section state this limitation in the same terms as _Constraints_. Identity and
  per-operation permissions are a later ADR, together with scoped recall, and they gate untrusted local
  agents, remote access and more than one user.
- **A graph revision is new.** Nothing counts the service's writes today. The application layer gains a
  revision that advances with every committed change to the graph, the history or the drafts, and reads
  return it. The contract tests that compare REST with MCP are new as well.
- **The conversation constraint binds future work.** This ADR builds no conversation store. Whoever builds
  one, and the import of host conversations, starts from _Conversation structure is Episteme data_. The
  target architecture's constraint on conversations is updated to say the same.
- **The terminal becomes a client later.** Until it does, `pnpm learn` and `pnpm serve` cannot run on the same
  graph at once, as today.
- The service is Learn-shaped until `LearnSession` is split. The scene profile names where that dependency
  sits, so a second scene has one place to plug in rather than many.
- Documentation to update with the implementation: ADR 0008's status line (_amended by 0010_), the MCP
  package README (_Connecting_), the roadmap, and the tiers in the target architecture.
