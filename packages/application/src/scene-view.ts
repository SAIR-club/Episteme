import type { CognitiveSession } from './session.js'

/**
 * What a scene's own MCP tools and REST routes may do with a session (ADR 0013, scene extensions).
 *
 * Reads (the caller's own threads and the publications anyone may browse and read among them), proposals and
 * distillation, and nothing that decides or writes. A scene extension is reachable by an
 * agent, so handing it the session would hand an agent `decide` and the graph: the one human-decision path
 * would then have a side door. Whatever a scene wants to change goes through `propose` or `distill` and waits
 * for the person, like everything an agent asks for.
 */
export interface SceneView {
  readonly sceneName: string
  readonly recordableDimensions: CognitiveSession['recordableDimensions']
  recall(...args: Parameters<CognitiveSession['recall']>): ReturnType<CognitiveSession['recall']>
  propose(...args: Parameters<CognitiveSession['propose']>): ReturnType<CognitiveSession['propose']>
  distill(...args: Parameters<CognitiveSession['distill']>): ReturnType<CognitiveSession['distill']>
  progress(): ReturnType<CognitiveSession['progress']>
  listNodes(): ReturnType<CognitiveSession['listNodes']>
  understandingOf(
    ...args: Parameters<CognitiveSession['understandingOf']>
  ): ReturnType<CognitiveSession['understandingOf']>
  historyOf(
    ...args: Parameters<CognitiveSession['historyOf']>
  ): ReturnType<CognitiveSession['historyOf']>
  vocabulary(): ReturnType<CognitiveSession['vocabulary']>
  pendingSuggestions(): ReturnType<CognitiveSession['pendingSuggestions']>
  /** The caller's own threads, newest first (ADR 0015). Never another person's. */
  threads(scope?: string): ReturnType<CognitiveSession['threads']>
  /** One of the caller's own threads with its turns, or `undefined` for any thread that is not theirs. */
  threadView(threadId: string): ReturnType<CognitiveSession['threadView']>
  /**
   * Live publications, newest first (ADR 0014): what every signed-in person may browse. A withdrawn
   * publication never appears.
   */
  browsePublications(
    ...args: Parameters<CognitiveSession['browsePublications']>
  ): ReturnType<CognitiveSession['browsePublications']>
  /**
   * One publication's public content (ADR 0014), exactly as `GET /api/v1/publications/:id` returns it to the
   * same caller: its members, the relations it made public, thread summaries and version chain. No one's state
   * and no adopter. `undefined` for an unknown publication, or a withdrawn one the caller did not write.
   */
  publicationView(id: string): ReturnType<CognitiveSession['publicationView']>
  /** The caller's records in this scene's own namespace (ADR 0015, decision 7). Never understanding. */
  readonly records: {
    get(key: string): ReturnType<CognitiveSession['sceneRecord']>
    list(prefix?: string): ReturnType<CognitiveSession['sceneRecords']>
    put(key: string, value: unknown): ReturnType<CognitiveSession['putSceneRecord']>
  }
}

/**
 * The view of `session` a scene extension receives.
 *
 * A frozen object of delegating functions rather than the session cast to a narrower type, so the session's
 * other methods are not reachable at run time either.
 */
export function sceneViewOf(session: CognitiveSession): SceneView {
  return Object.freeze({
    sceneName: session.scene.name,
    recordableDimensions: session.recordableDimensions,
    recall: (...args: Parameters<CognitiveSession['recall']>) => session.recall(...args),
    propose: (...args: Parameters<CognitiveSession['propose']>) => session.propose(...args),
    distill: (...args: Parameters<CognitiveSession['distill']>) => session.distill(...args),
    progress: () => session.progress(),
    listNodes: () => session.listNodes(),
    understandingOf: (...args: Parameters<CognitiveSession['understandingOf']>) =>
      session.understandingOf(...args),
    historyOf: (...args: Parameters<CognitiveSession['historyOf']>) => session.historyOf(...args),
    vocabulary: () => session.vocabulary(),
    pendingSuggestions: () => session.pendingSuggestions(),
    threads: (scope?: string) => session.threads(scope),
    threadView: (threadId: string) => session.threadView(threadId),
    browsePublications: (...args: Parameters<CognitiveSession['browsePublications']>) =>
      session.browsePublications(...args),
    publicationView: (id: string) => session.publicationView(id),
    records: Object.freeze({
      get: (key: string) => session.sceneRecord(session.scene.name, key),
      list: (prefix?: string) => session.sceneRecords(session.scene.name, prefix),
      put: (key: string, value: unknown) => session.putSceneRecord(session.scene.name, key, value),
    }),
  })
}
