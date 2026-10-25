# Deploying a shared service

How to run one Episteme service that a course's students share (ADR 0012, shared mode), with publishing on
(ADR 0014). For a single person on their own machine, `pnpm serve` is all there is; nothing here applies.

**What has been verified and what has not.** The service in shared mode, the user and token commands and the
smoke test below were run end to end on a developer machine (2026-10-18): all six smoke checks passed. The
reverse proxy, HTTPS, the systemd unit and the Codex configuration are written from their documentation and
have **not** yet been run on a server. Mark them verified here once they are.

## 1. Build

On the server, with Node 22.13 or later and pnpm:

```bash
git clone -c core.autocrlf=false https://github.com/SAIR-club/Episteme.git /opt/episteme
cd /opt/episteme
pnpm install --frozen-lockfile
pnpm build
```

## 2. People and tokens

Keep the user file and the graph outside the checkout, readable only by the service's user:

```bash
mkdir -p /srv/episteme && chmod 700 /srv/episteme
cd /opt/episteme
node apps/service/dist/serve.js users add "Lin" --users /srv/episteme/users.json
node apps/service/dist/serve.js tokens add actor_human_lin --kind human --label workspace --users /srv/episteme/users.json
node apps/service/dist/serve.js tokens add actor_human_lin --kind agent --label claude-code --users /srv/episteme/users.json
```

Each token is printed once. Give a student their `human` token for the Workspace and one `agent` token per host
they use. Revoke one with `tokens revoke <id>`; the running service refuses it from the next request, because it
reads the user file again when it changes.

A student can also manage their own agent tokens over REST with their `human` token (or the Workspace's
session cookie), for example from a web front end, so they do not need you for each new host:

```bash
# list my tokens: id, kind, label, createdAt, revokedAt if revoked, and which one this request used
curl -H "Authorization: Bearer <human token>" https://episteme.example.edu/api/v1/tokens
# issue an agent token for one host; the secret is in this response only
curl -X POST -H "Authorization: Bearer <human token>" -H "content-type: application/json"   -d '{"label":"codex"}' https://episteme.example.edu/api/v1/tokens
# revoke one of my tokens by its id
curl -X POST -H "Authorization: Bearer <human token>" -H "content-type: application/json"   -d '{}' https://episteme.example.edu/api/v1/tokens/<token id>/revoke
```

An agent token is refused all three (`403 human_required`). A person sees and revokes only their own tokens; a
token of someone else's is answered `404 unknown_token`, as if it did not exist. Human tokens are issued only with
the CLI, and the token a request is made with cannot revoke itself (`422 current_credential`): revoke a lost
human token from another one, or with `tokens revoke`. These writes go to the same user file as the CLI's, in
the same format; the service makes its own one at a time, but does not lock out a CLI command run at the very
same moment.

For a class, run `users add` and the two `tokens add` once per student from a list, and hand out the tokens by a
private channel. The user file stores only salted hashes; a lost token cannot be recovered, only revoked and
reissued.

## 3. Run

```bash
node apps/service/dist/serve.js \
  --mode shared \
  --users /srv/episteme/users.json \
  --public-origin https://episteme.example.edu \
  --graph /srv/episteme/graph.jsonl \
  --host 127.0.0.1 --port 4321 \
  --sharing
```

- `--host 127.0.0.1`: the service speaks plain HTTP and must only be reached through the proxy.
- `--public-origin`: the address students use; the boundary accepts it beside the loopback names.
- `--sharing`: allows publishing. The graph is copied to `graph.jsonl.before-sharing` before its first
  publication, because no earlier build can open a graph that holds one.
- `--trust-elicitation` is left off: in shared mode a form answered in some host is not taken as the student's
  decision (ADR 0012, decision 4).

A systemd unit (not yet verified on a server):

```ini
[Unit]
Description=Episteme shared service
After=network.target

[Service]
User=episteme
WorkingDirectory=/opt/episteme
ExecStart=/usr/bin/node apps/service/dist/serve.js --mode shared --users /srv/episteme/users.json --public-origin https://episteme.example.edu --graph /srv/episteme/graph.jsonl --host 127.0.0.1 --port 4321 --sharing
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

`Restart=on-failure` is safe: the service releases the graph's lock on exit, and a lock left by a killed process
names its PID so it can be removed by hand.

## 4. HTTPS in front

Any reverse proxy that terminates TLS and forwards to `127.0.0.1:4321` works. With Caddy (not yet verified):

```text
episteme.example.edu {
  reverse_proxy 127.0.0.1:4321
}
```

Forward the `Host` header unchanged (Caddy does by default) and allow long-lived responses, which the MCP
endpoint uses.

## 5. Backups

Everything the service owns is a set of files beside the graph:

| file                                | holds                                              |
| ----------------------------------- | -------------------------------------------------- |
| `graph.jsonl`                       | nodes, edges, state history, publications          |
| `graph.jsonl.suggestions.jsonl`     | pending drafts, reviews, delegations               |
| `graph.jsonl.sources.jsonl`         | material that was distilled                        |
| `graph.jsonl.threads.jsonl`         | conversations: raw turns and summaries             |
| `graph.jsonl.scene.jsonl`           | scene records, such as MindLink projects           |
| `users.json`                        | people and token hashes                            |

The first three are rewritten whole through a temporary file and a rename, so a copy never sees half a write.
Threads and scene records are appended to; a copy taken mid-append may end in a partial line, which the service
refuses to read. Copy them while it is stopped, or keep several generations:

```bash
# /etc/cron.d/episteme-backup, nightly
15 3 * * * episteme tar -czf /srv/backup/episteme-$(date +\%F).tgz -C /srv episteme
```

These files hold students' conversations and understanding in plain text (roadmap, Phase 4). Keep backups as
private as the server.

## 6. Connect a host

Claude Code, with the student's agent token:

```bash
claude mcp add --transport http mindlink https://episteme.example.edu/mcp --header "Authorization: Bearer <agent token>"
```

Other hosts that speak MCP over Streamable HTTP need the same two things: the `/mcp` address and the
`Authorization` header. Check each host's own documentation for where a header goes; this has not been verified
for Codex or WorkBuddy yet.

The Workspace signs in with the student's `human` token at `POST /api/v1/session`, which sets a session cookie.

## 7. Smoke test

From any machine that can reach the service:

```bash
node scripts/smoke-shared.mjs https://episteme.example.edu <human token> <agent token>
```

It checks that a request without a token is refused, that the human token reads and opens a session, and that
the agent token reads, lists the MCP tools and is refused a decision. It changes nothing in the graph.

## Not covered

One process serves one graph; there is no scaling out, no database and no migration tooling. Two people on one
deployment see each other only through what they publish (ADR 0014).
