import {
  CANONICAL_STREAMS,
  DEFAULT_HYBRID_WEIGHTS,
  applyDomainPacks,
  createRegistries,
  defineDomainPack,
  type EpistemeError,
} from '@episteme/core'
import { describe, expect, it } from 'vitest'

const pack = defineDomainPack('second-scene', {
  streams: [{ id: 'forum', label: 'Forum', reducesUnderstanding: false }],
  projections: [{ id: 'forum-thread', label: 'Forum thread', filter: { scene: ['scene:forum'] } }],
  retrievalWeights: [{ id: 'forum', weights: { ...DEFAULT_HYBRID_WEIGHTS, lexical: 0.3 } }],
})

describe('the generalized substrate registries', () => {
  it('registers a second scene without changing Core', () => {
    const registries = createRegistries()
    applyDomainPacks([pack], { registries })

    expect(registries.streams.find('forum')?.reducesUnderstanding).toBe(false)
    expect(registries.projections.find('forum-thread')?.filter.scene).toEqual(['scene:forum'])
    expect(registries.retrievalWeights.find('forum')?.weights.lexical).toBe(0.3)
  })

  it('registers the canonical streams once and refuses a conflicting redefinition', () => {
    const registries = createRegistries()
    expect(registries.streams.list().map((stream) => stream.id)).toEqual(
      CANONICAL_STREAMS.map((stream) => stream.id),
    )

    let refusal: EpistemeError | undefined
    try {
      registries.streams.register({
        id: 'understanding',
        label: 'Understanding',
        reducesUnderstanding: false,
      })
    } catch (error) {
      refusal = error as EpistemeError
    }
    expect(refusal?.code).toBe('duplicate_registration')
  })
})
