# @episteme/embeddings-http

Embedding adapters over HTTP JSON APIs. **No dependency, no native build step** — requests use `fetch`,
which Node has had since 18, for the same reason Phase 1 chose JSONL over SQLite: a learner should not
need a toolchain between them and their own cognition.

## What it supports

| `protocol`         | Endpoint         | Request            | Response                     | Typical server                            |
| ------------------ | ---------------- | ------------------ | ---------------------------- | ----------------------------------------- |
| `ollama` (default) | `/api/embed`     | `{ model, input }` | `{ embeddings: number[][] }` | Ollama                                    |
| `openai`           | `/v1/embeddings` | `{ model, input }` | `{ data: [{ embedding }] }`  | OpenAI, llama.cpp server, LM Studio, vLLM |
| `tei`              | `/embed`         | `{ inputs }`       | `number[][]`                 | Hugging Face text-embeddings-inference    |

## Usage

```ts
import { ollamaEmbeddingAdapter } from '@episteme/embeddings-http'
import { DeterministicEmbeddingAdapter, InMemoryEmbeddingCache, hybridRetriever } from '@episteme/core'

// A local server. The model name is the adapter's identity, because the cache keys on it.
const adapter = ollamaEmbeddingAdapter({
  baseUrl: 'http://127.0.0.1:11434',
  model: 'nomic-embed-text',
})

const retriever = hybridRetriever(graph, log, adapter, new InMemoryEmbeddingCache())
```

For a hosted provider, pass `apiKey`; it becomes a bearer token. The adapter reads no environment
variable of its own, so a secret never appears in configuration this class invents.

## What it deliberately does not do

- **It does not install, start or manage a model server.** Discovering a local runtime is an
  application's job, not a portable adapter's; guessing would make this class depend on one machine's
  configuration.
- **It does not fall back to another provider.** A failure is reported as a typed `EmbeddingError`, never
  as an empty result. An empty result reads as "the learner understands nothing", which is a different
  and much worse claim than "the embedding provider is down".

## Failure behaviour

Every failure is an `EmbeddingError` with a `kind`, because the caller's response differs by cause:

| `kind`               | Meaning                                                           |
| -------------------- | ----------------------------------------------------------------- |
| `unavailable`        | the server could not be reached                                   |
| `timeout`            | the server did not answer within `timeoutMs`                      |
| `provider_error`     | the server answered with an error status; the message includes it |
| `malformed_response` | the body was not usable vectors                                   |

The dangerous case is why `malformed_response` exists: a provider that answers `200` with an error object
would otherwise yield a zero-length vector, and a zero-length vector makes every similarity `0` — which is
indistinguishable from "nothing is relevant".

Other checks worth knowing: a response whose count does not match the request is refused, and a vector
width that changes after the first response is refused, because vectors of different widths cannot be
compared and a silent mismatch returns plausible nonsense.

## Known gap: not verified against a real provider in this environment

The seam is implemented and its contract is tested against a stub `fetch`. **No live provider was
verifiable here**, and that is recorded rather than papered over:

- the locally installed Ollama (0.30.5) rejects `/api/embed` with _"This server does not support
  embeddings. Start it with `--embeddings`"_ — and `ollama serve --help` shows no such flag in this build;
- its five installed models (`qwen3:4b`, `qwen3:14b`, `gemma3:1b`, `gemma4:latest`, `llama3.2:latest`) are
  all chat models, and the machine had roughly 5 GiB free, so pulling an embedding model was not a
  reliable operation to depend on.

So: the request/response shapes, the failure taxonomy and the guards above are tested; an end-to-end run
against a real model is not. A machine with an embedding-capable server should work without code change —
if it does not, the adapter's error will say which of the four kinds it was.

## Note for contributors

Vitest resolves `@episteme/*` through `dist/`, so run `pnpm typecheck` or `pnpm build` before `pnpm test`
after editing this package — or use `pnpm test`, whose `pretest` does it for you.
