import type { CognitiveSession } from './session.js'

/**
 * What a scene's own MCP tools and REST routes may do with a session (ADR 0013, scene extensions).
 *
 * Reads, proposals and distillation, and nothing that decides or writes. A scene extension is reachable by an
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
  })
}
