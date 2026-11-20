import {
  CanonicalJsonError,
  EPI_FORMAT,
  EPI_VERSION,
  EpiFileError,
  canonicalJson,
  detectEpiKind,
  historyDigestOf,
  knowledgeDigestOf,
  ontologyDigestOf,
  readEpiFile,
  sha256Hex,
  type EpiFile,
  type KnowledgeSection,
} from '@episteme/epi-format'
import { describe, expect, it } from 'vitest'

/**
 * The container contract (ADR 0023): a file claims capabilities through `profiles`, and every claim
 * is checked — sections present, checksums true, receipts pointing at what the file carries. A v1
 * portable export stays a v1 file: detected, verifiable, restorable, but never mistaken for a v2
 * envelope.
 */

const TIME = '2026-11-18T00:00:00.000Z'
const SOURCE = { file: 'graph.db', build: 'test-build' }

const ontologyPacks = [
  {
    name: 'default-session-pack',
    revision: 'test-revision',
    definitions: {
      nodeTypes: [{ id: 'concept', label: 'Concept' }],
      stateDimensions: [
        { id: 'confidence', kind: 'ordinal', ordered: true, levels: ['low', 'medium', 'high'] },
      ],
    },
  },
]
const ontology = {
  packs: ontologyPacks,
  sha256: ontologyDigestOf({ packs: ontologyPacks }),
}

const historyBase = {
  format: 'episteme-graph-export',
  version: 1,
  exportedAt: TIME,
  source: SOURCE,
  storedAs: { sqliteFormat: 2, recordSchema: 1 },
  counts: { records: 1, companions: {} },
  records: ['{"schemaVersion":1,"kind":"branch"}'],
  companions: [],
}
const history = { ...historyBase, sha256: historyDigestOf(historyBase) }

const knowledgeBase = {
  derivedFrom: {
    historySha256: history.sha256,
    ontologySha256: ontology.sha256,
    filter: {},
  },
  derivedAt: TIME,
  nodes: [{ id: 'n_1', type: 'concept', label: '位置编码' }],
  edges: [],
  branches: [],
  state: [{ target: 'n_1', actor: 'actor_human', dimensions: { confidence: { level: 'medium' } } }],
  publications: [],
  sources: [],
}
const knowledge: KnowledgeSection = {
  ...knowledgeBase,
  sha256: knowledgeDigestOf(knowledgeBase),
}

const full: EpiFile = {
  format: EPI_FORMAT,
  version: EPI_VERSION,
  exportedAt: TIME,
  source: SOURCE,
  profiles: ['archive', 'knowledge'],
  archive: { history },
  ontology,
  knowledge,
}

const write = (file: unknown): string => JSON.stringify(file)

/** Refusal codes are first-class values: the test reads the code, like any reader would. */
const code = (text: string): string => {
  try {
    readEpiFile(text)
  } catch (error) {
    expect(error).toBeInstanceOf(EpiFileError)
    return (error as EpiFileError).code
  }
  throw new Error('expected a refusal')
}

describe('the .epi v2 container', () => {
  it('reads a file that carries both capabilities, and each section checks out', () => {
    const file = readEpiFile(write(full))
    expect(file.profiles).toEqual(['archive', 'knowledge'])
    expect(file.archive?.history.records).toEqual(history.records)
    expect(file.ontology?.packs[0]?.name).toBe('default-session-pack')
    expect(file.knowledge?.nodes[0]).toMatchObject({ id: 'n_1', type: 'concept' })
  })

  it('reads a knowledge-only file, which is readable and claims no restorability', () => {
    const derivedFrom = { ontologySha256: ontology.sha256, filter: {} }
    const knowledgeOnly = {
      format: EPI_FORMAT,
      version: EPI_VERSION,
      exportedAt: TIME,
      source: SOURCE,
      profiles: ['knowledge'],
      ontology,
      knowledge: {
        ...knowledgeBase,
        derivedFrom,
        sha256: knowledgeDigestOf({ ...knowledgeBase, derivedFrom }),
      },
    }
    const file = readEpiFile(write(knowledgeOnly))
    expect(file.profiles).toEqual(['knowledge'])
    expect(file.archive).toBeUndefined()
    expect(file.knowledge?.sha256).toBe(knowledgeDigestOf({ ...knowledgeBase, derivedFrom }))
    // No history travels, so the receipt names none: it derives from a source graph this file does not carry.
    expect(file.knowledge?.derivedFrom.historySha256).toBeUndefined()
  })

  it('reads a history-only file, which is restorable and claims no readability', () => {
    const file = readEpiFile(
      write({
        format: EPI_FORMAT,
        version: EPI_VERSION,
        exportedAt: TIME,
        source: SOURCE,
        profiles: ['archive'],
        archive: { history },
      }),
    )
    expect(file.profiles).toEqual(['archive'])
    expect(file.ontology).toBeUndefined()
    expect(file.knowledge).toBeUndefined()
  })

  it('keeps views beside knowledge without letting them touch the checksums', () => {
    const withViews = {
      ...full,
      views: [{ name: 'outline', kind: 'outline', over: {}, layout: { groupBy: 'contains' } }],
    }
    const file = readEpiFile(write(withViews))
    expect(file.views?.[0]?.name).toBe('outline')
    expect(readEpiFile(write(full)).knowledge?.sha256).toBe(file.knowledge?.sha256)
  })

  it('detects what a text holds before validating it', () => {
    expect(detectEpiKind(write(full))).toBe('v2')
    expect(detectEpiKind(write(history))).toBe('v1')
    expect(detectEpiKind('not json')).toBe('unknown')
    expect(detectEpiKind(write({ format: 'other' }))).toBe('unknown')
  })

  it('refuses a v1 file as a v2 envelope while still verifying it by the v1 digest rule', () => {
    expect(detectEpiKind(write(history))).toBe('v1')
    expect(historyDigestOf(history)).toBe(history.sha256)
    expect(code(write(history))).toBe('not_an_epi')
  })

  it('refuses what is not an .epi file, and any version it does not read', () => {
    expect(code('not json')).toBe('not_an_epi')
    expect(code(write({ ...full, format: 'something-else' }))).toBe('not_an_epi')
    expect(code(write({ ...full, version: 3 }))).toBe('unsupported_version')
    expect(code(write({ ...full, version: 1 }))).toBe('unsupported_version')
  })

  it('refuses profiles that claim nothing, anything, or the same thing twice', () => {
    expect(code(write({ ...full, profiles: [] }))).toBe('invalid_profiles')
    expect(code(write({ ...full, profiles: ['archive', 'bogus'] }))).toBe('invalid_profiles')
    expect(code(write({ ...full, profiles: ['knowledge', 'knowledge'] }))).toBe('invalid_profiles')
  })

  it('refuses a claimed section that is absent', () => {
    const { archive: _archive, ...withoutArchive } = full
    expect(code(write({ ...withoutArchive, profiles: ['archive', 'knowledge'] }))).toBe(
      'missing_section',
    )
    const { ontology: _ontology, ...withoutOntology } = full
    expect(code(write(withoutOntology))).toBe('missing_section')
    const { knowledge: _knowledge, ...withoutKnowledge } = full
    expect(code(write(withoutKnowledge))).toBe('missing_section')
  })

  it('refuses a section that does not match its checksum', () => {
    expect(
      code(write({ ...full, archive: { history: { ...history, sha256: '0'.repeat(64) } } })),
    ).toBe('damaged')
    expect(code(write({ ...full, ontology: { ...ontology, sha256: '0'.repeat(64) } }))).toBe(
      'damaged',
    )
    expect(code(write({ ...full, knowledge: { ...knowledge, sha256: '0'.repeat(64) } }))).toBe(
      'damaged',
    )
  })

  it('refuses a knowledge projection whose receipt names what the file does not carry', () => {
    // A different, internally valid history: its own checksum holds, so the refusal is the receipt's.
    const otherHistoryBase = { ...historyBase, records: ['{"schemaVersion":1,"kind":"event"}'] }
    const otherHistory = { ...otherHistoryBase, sha256: historyDigestOf(otherHistoryBase) }
    expect(code(write({ ...full, archive: { history: otherHistory } }))).toBe('projection_mismatch')
    // A different, internally valid ontology: same rule.
    const otherOntologyPacks = [{ ...ontologyPacks[0]!, name: 'another-pack' }]
    const otherOntology = {
      packs: otherOntologyPacks,
      sha256: ontologyDigestOf({ packs: otherOntologyPacks }),
    }
    expect(code(write({ ...full, ontology: otherOntology }))).toBe('projection_mismatch')
  })

  it('refuses unreadable envelope fields', () => {
    expect(code(write({ ...full, exportedAt: 'yesterday' }))).toBe('damaged')
    expect(code(write({ ...full, exportedAt: '2026-11-18T00:00:00+08:00' }))).toBe('damaged')
    expect(code(write({ ...full, source: { file: 'graph.db' } }))).toBe('damaged')
    expect(code(write({ ...full, knowledge: { ...knowledge, derivedAt: 'soon' } }))).toBe('damaged')
    expect(code(write({ ...full, knowledge: { ...knowledge, nodes: 'all of them' } }))).toBe(
      'damaged',
    )
  })
})

describe('canonical JSON', () => {
  it('sorts keys recursively, keeps array order, and writes numbers as ECMAScript does', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalJson({ z: { d: 1, c: 2 }, a: [3, 1, 2] })).toBe(
      '{"a":[3,1,2],"z":{"c":2,"d":1}}',
    )
    expect(canonicalJson([2, 1])).toBe('[2,1]')
    expect(canonicalJson({ n: 0.5 })).toBe('{"n":0.5}')
    expect(canonicalJson({ n: -0 })).toBe('{"n":0}')
    expect(canonicalJson({ n: 1700000000000 })).toBe('{"n":1700000000000}')
    expect(canonicalJson({ n: 1e21 })).toBe('{"n":1e+21}')
  })

  it('drops undefined object values but keeps nulls', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}')
    expect(canonicalJson([undefined, 1])).toBe('[null,1]')
  })

  it('refuses what has no canonical form', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(CanonicalJsonError)
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(CanonicalJsonError)
    expect(() => canonicalJson({ a: '\uD800' })).toThrow(CanonicalJsonError)
    expect(() => canonicalJson({ a: 1n })).toThrow(CanonicalJsonError)
  })

  it('gives the same bytes to the same knowledge however the object was built', () => {
    const one = { d: { b: 1, a: 2 }, c: [1, { y: 2, x: 3 }] }
    const two = { c: [1, { x: 3, y: 2 }], d: { a: 2, b: 1 } }
    expect(canonicalJson(one)).toBe(canonicalJson(two))
    expect(sha256Hex(canonicalJson(one))).toBe(sha256Hex(canonicalJson(two)))
  })
})
