import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asId, createRegistries, type DimensionId, type EpistemeError } from '@episteme/core'
import { startService, type EpistemeService } from '@episteme/service'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Only registered, current levels are offered, and the vocabulary is served rather than written into a page
 * (ADR 0013, step M2).
 *
 * A level a surface offers must be one Core accepts, or the person is shown a button that fails. A legacy
 * level stays registered so old events still reduce, but is never offered for new input.
 */

interface VocabularyLevel {
  readonly id: string
  readonly legacy: boolean
}

interface VocabularyDimension {
  readonly id: string
  readonly label: string
  readonly kind: string
  readonly recordable: boolean
  readonly levels: readonly VocabularyLevel[]
}

interface RecordableDimension {
  readonly id: string
  readonly levels: readonly string[]
}

let directory: string
let service: EpistemeService

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${service.apiUrl}${path}`)
  expect(response.status).toBe(200)
  return (await response.json()) as T
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${service.apiUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${service.humanToken ?? ''}`,
    },
    body: JSON.stringify(body),
  })
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-vocabulary-'))
  service = await startService({ port: 0, graph: join(directory, 'learn.db') })
})

afterEach(async () => {
  await service.close()
  await rm(directory, { recursive: true, force: true })
})

describe('GET /api/v1/vocabulary', () => {
  it('lists every registered dimension with its levels and which of them are legacy', async () => {
    const { dimensions } = await get<{ dimensions: readonly VocabularyDimension[] }>('/vocabulary')
    const byId = new Map(dimensions.map((dimension) => [dimension.id, dimension]))

    expect([...byId.keys()].sort()).toEqual(
      [
        'articulation',
        'confidence',
        'conflict',
        'evidence',
        'exposure',
        'source',
        'transfer',
      ].sort(),
    )
    const legacyOf = (id: string) =>
      byId
        .get(id)
        ?.levels.filter((level) => level.legacy)
        .map((level) => level.id)
    expect(legacyOf('evidence')).toEqual(['weak', 'derived'])
    expect(legacyOf('transfer')).toEqual(['none', 'near', 'far'])
    expect(legacyOf('confidence')).toEqual([])

    expect(
      dimensions
        .filter((dimension) => dimension.recordable)
        .map((dimension) => dimension.id)
        .sort(),
    ).toEqual(['articulation', 'confidence', 'conflict', 'evidence'])
  })

  it('offers exactly the current levels of each recordable dimension', async () => {
    const { dimensions } = await get<{ dimensions: readonly VocabularyDimension[] }>('/vocabulary')
    const state = await get<{ dimensions: readonly RecordableDimension[] }>('/state')

    for (const offered of state.dimensions) {
      const registered = dimensions.find((dimension) => dimension.id === offered.id)
      expect(registered?.recordable).toBe(true)
      expect(offered.levels).toEqual(
        registered?.levels.filter((level) => !level.legacy).map((level) => level.id),
      )
    }
  })
})

describe('recording what is offered', () => {
  it('accepts every offered level through REST', async () => {
    const state = await get<{ dimensions: readonly RecordableDimension[] }>('/state')
    expect(state.dimensions.length).toBeGreaterThan(0)

    for (const dimension of state.dimensions) {
      for (const level of dimension.levels) {
        const response = await post('/record', {
          target: 'q_why_order',
          dimensions: { [dimension.id]: level },
        })
        expect({ dimension: dimension.id, level, status: response.status }).toEqual({
          dimension: dimension.id,
          level,
          status: 200,
        })
      }
    }
  })

  it('refuses a legacy level for new input and records nothing', async () => {
    const before = await get<{ events: number }>('/state')
    const response = await post('/record', {
      target: 'q_why_order',
      dimensions: { evidence: 'weak' },
    })
    expect(response.status).toBe(422)
    expect(((await response.json()) as { code: string }).code).toBe('invalid_dimension_value')
    const after = await get<{ events: number }>('/state')
    expect(after.events).toBe(before.events)
  })
})

describe('legacy levels in a dimension definition', () => {
  it('refuses a legacy level that is not one of the registered levels', () => {
    const registries = createRegistries()
    let refusal: EpistemeError | undefined
    try {
      registries.stateDimensions.register({
        id: asId<DimensionId>('certainty'),
        label: 'Certainty',
        kind: 'ordinal',
        levels: ['low', 'high'],
        legacyLevels: ['medium'],
      })
    } catch (error) {
      refusal = error as EpistemeError
    }
    expect(refusal?.code).toBe('invalid_definition')
    expect(registries.stateDimensions.has('certainty')).toBe(false)
  })
})
