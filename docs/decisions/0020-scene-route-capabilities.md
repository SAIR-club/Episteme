# 0020 — A scene's routes are the person's unless named otherwise

Status: **proposed** (2026-11-03). Amends [ADR 0012](0012-human-review-security.md) decision 3 and
[ADR 0013](0013-repository-boundary.md) _Scene extensions_ for the routes a scene adds.

## Context

ADR 0012 sorts every request into two: `read`, which covers reading, proposing and distilling, and `decide`, which
needs the person's own credential. The list of `decide` routes is written out by hand and covers the core API.

Scene routes were never on it, so every `POST /api/v1/scene/<name>/…` counted as `read`. The README's claim that they
"cannot decide or record" held for the graph, because they reach it only through the application, but not for the
scene's own data. A real run with the workbench profile showed the gap:

- an agent's token could delete a material, archive a space and rename it, in a shared deployment;
- on one person's machine, a request with no credential at all could do the same.

Treating every `POST` as `decide` would be just as wrong. It would take away what ADR 0012 gives an agent on purpose:
it may add things for the person to look at. Whether a route is safe depends on what it does, not on its method.

## Decision

1. **Closed by default.** A scene's `POST` is `decide` unless its profile names it. That includes a path that matches
   no route, so a variation of a path (a trailing slash, another case) gets a refusal and not a chance. A route added
   later without thought needs the person's credential until someone decides otherwise.

2. **A profile names what only proposes.** `SceneProfile.proposingRoutes` lists the paths, and a named path is the same
   operation as `read` in ADR 0012's table. There is no third operation, because the table has no third answer: in
   local mode proposing needs no credential, in a shared deployment it needs any credential, and an agent may do it.

3. **What may be named.** A route may be named only if all of these hold:
   - it adds something, and removes, replaces and archives nothing;
   - what it adds waits for the person, or can be removed by them;
   - it does not record anything in the person's voice;
   - it settles nothing that the person has to settle.

4. **The workbench names these**, in one place (`WORKBENCH_PROPOSING_ROUTES`, `apps/workbench/src/route-access.ts`):

   | Route                                                  | Why an agent may use it                                 |
   | ------------------------------------------------------ | ------------------------------------------------------- |
   | `/spaces`                                              | a new, empty space; the person can archive it           |
   | `/materials`                                           | a new material; the person can delete it                |
   | `/plans`                                               | a draft that waits for the person                       |
   | `/candidates`, `/candidates/turn`, `/candidates/thread` | a candidate from words already on record, in review     |

   Everything else is left to the person, which includes the following routes that may look harmless:

   | Route                                                    | Why it is the person's                                                             |
   | -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
   | `/spaces/update`, `/materials/delete`, `/materials/replace` | archives, renames, removes or replaces what is there                            |
   | `/ask`                                                   | records the question as the person's own turn, and spends their model budget       |
   | `/plans/update`, `/plans/act`                            | the person's steering and answers                                                  |
   | `/understanding/revise`, `/understanding/relate`         | written as what the person said (`speaker: learner`, `basis: stated`)              |
   | `/understanding/challenge`                               | a challenge with `text` is recorded as the person's own (`by: self`)               |
   | `/understanding/challenge/settle`                        | settles a challenge                                                                |
   | `/sharing/*`                                             | publishes, cites or answers others, under the person's name                        |

5. **MCP is not changed.** MCP tools are checked by the tools themselves, which is how a host agent leads learning
   (ADR 0019). This decision only concerns the routes a scene adds to REST.

6. **Each person's data stays theirs.** A credential is checked first, and the scene then sees only its actor's
   records. A person's token gets no further into someone else's space than an agent's does.

## Consequences

- An agent's token, or no credential on a local machine, can no longer delete, archive, rename, replace, ask, revise
  or publish over REST. Scripts that relied on this need the person's token. The hosted Workspace already sends it.
- A scene that says nothing about its routes keeps working for a person, and its agents can read it but not write. A
  scene that wants its agents to write has to say so.
- The workbench's list names routes that arrive in later layers of the same stack, so that the classification is
  reviewed once and in one place. Until such a route exists, naming it does nothing.
- The local mode's limit stays what ADR 0012 says it is: this prevents mistakes and over-reach, and does not stop an
  agent that runs as the same user and can read the token from the process output.

## Rejected

- **Every `POST` is `decide`.** Simple, and wrong: an agent could no longer propose anything over REST.
- **Listing `decide` routes in each profile.** Forgetting one opens it, which is the failure this decision fixes.
- **A separate `propose` operation.** It would add a word to ADR 0012's table without adding a different answer.
