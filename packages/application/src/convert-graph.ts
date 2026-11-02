import { convertLegacyGraph, type GraphConversion } from '@episteme/storage-sqlite'
import { CognitiveSession } from './session.js'

/**
 * Carries an older graph into a new file (`convertLegacyGraph`), and refuses to keep the result unless a session
 * opens it: every store, not only the history, has to read what came over.
 */
export function convertGraph(from: string, to: string): Promise<GraphConversion> {
  return convertLegacyGraph(from, to, {
    verify: async (graph) => {
      const session = await CognitiveSession.open({ filePath: graph })
      await session.close()
    },
  })
}
