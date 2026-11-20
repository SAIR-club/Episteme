import { CognitiveSession, type SessionOptions, type SessionScene } from '@episteme/application'
import { testScene } from './test-scene.js'

type TestSessionOptions = Omit<SessionOptions, 'scene'> & { readonly scene?: SessionScene }

/** Opens a session with the explicit test scene; a caller may still override it. */
export function openTestSession(options: TestSessionOptions = {}): Promise<CognitiveSession> {
  const { scene = testScene, ...rest } = options
  return CognitiveSession.open({ scene, ...rest })
}
