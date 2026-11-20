import {
  HttpEmbeddingAdapter,
  type EmbeddingProtocol,
  type HttpEmbeddingOptions,
} from '@episteme/embeddings-http'

/**
 * Semantic recall, off unless an embedding endpoint is configured.
 *
 * Without one, recall ranks by words, links, the person's understanding and recency, plus the deterministic
 * stand-in for meaning it has always used. With one, closeness in meaning comes from that model. When the
 * provider fails, a recall falls back to the other signals and says so (`semanticUnavailable`); it never fails
 * outright, and it never quietly reads as "nothing close in meaning".
 */
export interface EmbeddingSettings {
  readonly baseUrl: string
  readonly model: string
  readonly protocol: EmbeddingProtocol
  readonly apiKey?: string
  readonly timeoutMs: number
}

const PROTOCOLS: readonly EmbeddingProtocol[] = ['openai', 'ollama', 'tei']
const DEFAULT_TIMEOUT_MS = 10_000

/** A setting that names an unknown protocol or a non-numeric timeout: refused at start, not on first recall. */
export class EmbeddingSettingsError extends Error {
  override readonly name = 'EmbeddingSettingsError'
}

/**
 * The embedding endpoint `EPISTEME_EMBEDDINGS_*` configures, or `undefined` for none.
 *
 * Both a URL and a model are needed. Only one of them is a mistake, refused rather than taken as "off", so a typo
 * does not quietly leave semantic recall disabled.
 */
export function embeddingsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): EmbeddingSettings | undefined {
  const read = (name: string): string | undefined => {
    const value = environment[name]?.trim()
    return value === undefined || value === '' ? undefined : value
  }
  const baseUrl = read('EPISTEME_EMBEDDINGS_URL')
  const model = read('EPISTEME_EMBEDDINGS_MODEL')
  if (baseUrl === undefined && model === undefined) return undefined
  if (baseUrl === undefined || model === undefined) {
    throw new EmbeddingSettingsError(
      'EPISTEME_EMBEDDINGS_URL and EPISTEME_EMBEDDINGS_MODEL are set together or not at all',
    )
  }

  const protocol = read('EPISTEME_EMBEDDINGS_PROTOCOL') ?? 'openai'
  if (!(PROTOCOLS as readonly string[]).includes(protocol)) {
    throw new EmbeddingSettingsError(
      `EPISTEME_EMBEDDINGS_PROTOCOL must be one of ${PROTOCOLS.join(', ')}, not "${protocol}"`,
    )
  }

  const timeout = read('EPISTEME_EMBEDDINGS_TIMEOUT_MS')
  const timeoutMs = timeout === undefined ? DEFAULT_TIMEOUT_MS : Number(timeout)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new EmbeddingSettingsError(
      `EPISTEME_EMBEDDINGS_TIMEOUT_MS must be a positive number of milliseconds, not "${timeout}"`,
    )
  }

  const apiKey = read('EPISTEME_EMBEDDINGS_API_KEY')
  return {
    baseUrl,
    model,
    protocol: protocol as EmbeddingProtocol,
    timeoutMs,
    ...(apiKey === undefined ? {} : { apiKey }),
  }
}

/** The adapter for these settings. The key goes only into the adapter, never into a log or an error. */
export function embeddingAdapter(settings: EmbeddingSettings): HttpEmbeddingAdapter {
  const options: HttpEmbeddingOptions = {
    baseUrl: settings.baseUrl,
    model: settings.model,
    protocol: settings.protocol,
    timeoutMs: settings.timeoutMs,
    ...(settings.apiKey === undefined ? {} : { apiKey: settings.apiKey }),
  }
  return new HttpEmbeddingAdapter(options)
}

/** One line for the start-up banner: which model, where, never the key. */
export function describeEmbeddings(
  settings: Pick<EmbeddingSettings, 'model' | 'protocol' | 'baseUrl'> | undefined,
): string {
  return settings === undefined
    ? '语义检索：未开启（设置 EPISTEME_EMBEDDINGS_URL 和 EPISTEME_EMBEDDINGS_MODEL 开启）'
    : `语义检索：${settings.model}（${settings.protocol}，${settings.baseUrl}）`
}
