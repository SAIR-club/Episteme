# @episteme/hypothesis

A non-learning scene: state a research hypothesis, attach evidence, record how far you believe it, and find it again later. It is one profile, about 140 lines. It changes nothing in Core or the application, and has no page.

```bash
pnpm exec tsc -b
node apps/hypothesis/dist/serve.js --graph ./hypotheses.db
```

The service prints the REST and MCP addresses and a token for this run. An agent connects over MCP without a token, and can propose but not decide.

| Step | Call | Who |
| ---- | ---- | ---- |
| Propose a hypothesis | `POST /api/v1/scene/hypothesis/hypotheses {statement, why}`, or MCP `propose` | person or agent |
| Attach evidence | `POST /api/v1/scene/hypothesis/evidence {hypothesis, statement, relation, why}` (`supports` or `contradicts`) | person or agent |
| Accept | `POST /api/v1/suggestions/decide {id, action: "accept"}` | person only |
| Record belief | `POST /api/v1/record {target, dimensions: {credence: "likely"}, reason}` | person only |
| Search | `GET /api/v1/scene/hypothesis/hypotheses?q=…` | person or agent |
| Reuse in a new session | MCP `recall` | agent |

`tests/hypothesis-scene.test.ts` runs all of this, across a restart and an export and import. The exact field names there are the reference if this table goes stale.
