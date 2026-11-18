import { canonicalJson, sha256Hex } from './canonical.js'
import { EpiFileError, type EpiFileProblem } from './errors.js'

/**
 * The `.epi` container (ADR 0023).
 *
 * One file type, two capabilities, never confused:
 *
 * - **`archive`** — the v1 portable export carried byte-for-byte under `history`. Restorable: the
 *   whole graph comes back. Its integrity rule is v1's own, so a v1 file and the history section of
 *   a v2 file verify identically.
 * - **`knowledge`** — an ontology manifest plus a derived knowledge projection. Readable without
 *   Episteme; restorable it is not, and it never claims to be.
 *
 * A file may carry both. Which sections a file names in `profiles` is what it claims; a claimed
 * section that is absent, or a checksum that fails, is a refusal, never a warning.
 */

export const EPI_FORMAT = 'episteme-knowledge'
export const EPI_VERSION = 2
export const EPI_PROFILES = ['archive', 'knowledge'] as const
export type EpiProfile = (typeof EPI_PROFILES)[number]

/** The v1 portable export's identity, kept here so the archive section can be checked on its own. */
export const V1_FORMAT = 'episteme-graph-export'
export const V1_VERSION = 1

export interface EpiSource {
  /** The file's name only: where it sat on someone's disk does not travel. */
  readonly file: string
  readonly build: string
}

/** The v1 portable export, unchanged: what `@episteme/storage-sqlite` writes today. */
export interface HistorySection {
  readonly format: string
  readonly version: number
  readonly exportedAt: string
  readonly source: EpiSource
  readonly storedAs: { readonly sqliteFormat: number; readonly recordSchema: number }
  readonly sha256: string
  readonly counts: {
    readonly records: number
    readonly companions: Readonly<Record<string, number>>
  }
  readonly records: readonly string[]
  readonly companions: readonly {
    readonly name: string
    readonly seq: number
    readonly body: string
  }[]
}

/** One pack's registered vocabulary, as data. Behaviour never travels; definitions do. */
export interface OntologyPackDefinitions {
  readonly nodeTypes?: readonly { readonly id: string; readonly label: string }[]
  readonly edgeTypes?: readonly {
    readonly id: string
    readonly label: string
    readonly category?: string
    readonly from?: readonly string[]
    readonly to?: readonly string[]
  }[]
  readonly stateDimensions?: readonly {
    readonly id: string
    readonly label?: string
    readonly kind: string
    readonly ordered?: boolean
    readonly levels?: readonly string[]
    readonly legacyLevels?: readonly string[]
  }[]
  readonly tagNamespaces?: readonly { readonly namespace: string; readonly label?: string }[]
}

export interface OntologyPack {
  readonly name: string
  /** A hash the writer chose to identify the definitions it registered; opaque here. */
  readonly revision: string
  readonly definitions: OntologyPackDefinitions
}

export interface OntologyManifest {
  readonly packs: readonly OntologyPack[]
  /** sha256 over the canonical JSON of `packs`, so a changed manifest is detectable. */
  readonly sha256: string
}

/** What the knowledge projection was derived from, so a reader can tell derived from authoritative. */
export interface DerivedFrom {
  /** The history the projection was derived from, when that history travels in the same file. */
  readonly historySha256?: string
  readonly ontologySha256: string
  /** The projection filter that selected what the projection holds. */
  readonly filter: Readonly<Record<string, unknown>>
}

/**
 * The derived knowledge projection: nodes, edges, branch lineage, per-actor understanding state,
 * publications and source references, canonically serialized and checksummed.
 *
 * It is a cache with a receipt. Import never needs it, staleness is detectable through `derivedFrom`,
 * and nothing may claim to be verified that a refold of the named inputs contradicts.
 */
export interface KnowledgeSection {
  readonly derivedFrom: DerivedFrom
  readonly derivedAt: string
  readonly nodes: readonly unknown[]
  readonly edges: readonly unknown[]
  readonly branches: readonly unknown[]
  readonly state: readonly unknown[]
  readonly publications: readonly unknown[]
  readonly sources: readonly unknown[]
  /** sha256 over the canonical JSON of the section without this field. */
  readonly sha256: string
}

/**
 * A named presentation over the knowledge section: outline, map, timeline. Layout and organization
 * only — never a second copy of knowledge, so a damaged or missing view cannot touch what is true.
 */
export interface ViewSection {
  readonly name: string
  readonly kind: string
  /** The projection filter this view presents, as recorded in `derivedFrom.filter` form. */
  readonly over: Readonly<Record<string, unknown>>
  readonly layout: Readonly<Record<string, unknown>>
}

export interface EpiFile {
  readonly format: typeof EPI_FORMAT
  readonly version: typeof EPI_VERSION
  readonly exportedAt: string
  readonly source: EpiSource
  readonly profiles: readonly EpiProfile[]
  readonly archive?: { readonly history: HistorySection }
  readonly ontology?: OntologyManifest
  readonly knowledge?: KnowledgeSection
  readonly views?: readonly ViewSection[]
}

/** What kind of `.epi` file a text holds, decided by content before any validation. */
export type EpiKind = 'v1' | 'v2' | 'unknown'

/** Which file family a text belongs to: a v1 portable export, a v2 knowledge file, or neither. */
export function detectEpiKind(text: string): EpiKind {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return 'unknown'
  }
  if (typeof parsed !== 'object' || parsed === null) return 'unknown'
  const format = (parsed as { format?: unknown }).format
  if (format === EPI_FORMAT) return 'v2'
  if (format === V1_FORMAT) return 'v1'
  return 'unknown'
}

/** The v1 integrity rule, byte-compatible with `@episteme/storage-sqlite`'s own, so the archive section of a v2 file verifies exactly as a v1 file does. */
export function historyDigestOf(history: Pick<HistorySection, 'records' | 'companions'>): string {
  return sha256Hex(JSON.stringify({ records: history.records, companions: history.companions }))
}

/** The knowledge section's checksum: sha256 over the canonical JSON of everything but the checksum itself. */
export function knowledgeDigestOf(section: Omit<KnowledgeSection, 'sha256'>): string {
  return sha256Hex(canonicalJson(section))
}

/** The ontology manifest's checksum: sha256 over the canonical JSON of `packs`. */
export function ontologyDigestOf(manifest: Pick<OntologyManifest, 'packs'>): string {
  return sha256Hex(canonicalJson(manifest.packs))
}

/** Reads and fully checks an `.epi` file's text: envelope, profiles, sections, checksums and receipts. */
export function readEpiFile(text: string): EpiFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new EpiFileError('not_an_epi', 'the text is not JSON, so it is not an .epi file')
  }
  return readEpiEnvelope(parsed)
}

/** Checks a parsed envelope and everything the file's profiles claim. */
export function readEpiEnvelope(value: unknown): EpiFile {
  const file = asObject(value, 'not_an_epi', 'an .epi file is a JSON object')
  if (file.format !== EPI_FORMAT) {
    throw new EpiFileError(
      'not_an_epi',
      `expected format "${EPI_FORMAT}", found "${String(file.format)}"`,
    )
  }
  if (file.version !== EPI_VERSION) {
    throw new EpiFileError(
      'unsupported_version',
      `this build reads .epi version ${EPI_VERSION}, found ${String(file.version)}`,
    )
  }
  if (typeof file.exportedAt !== 'string' || !isIsoUtc(file.exportedAt)) {
    throw new EpiFileError(
      'damaged',
      `exportedAt "${String(file.exportedAt)}" is not an ISO 8601 UTC time`,
    )
  }
  const source = asObject(file.source, 'damaged', 'source must name the file and the build')
  if (typeof source.file !== 'string' || typeof source.build !== 'string') {
    throw new EpiFileError('damaged', 'source must name the file and the build')
  }
  const profiles = readProfiles(file.profiles)

  const archive = readArchiveSection(
    profiles.includes('archive') ? file.archive : undefined,
    profiles.includes('archive') ? { file: source.file, build: source.build } : undefined,
  )
  const knowledgeParts = readKnowledgeSections(
    profiles.includes('knowledge') ? file.ontology : undefined,
    profiles.includes('knowledge') ? file.knowledge : undefined,
  )
  const views = readViews(file.views)

  // Receipts must agree with the sections the file carries: a projection derived from a different
  // history or ontology than this file holds is a mismatch, never a warning.
  if (archive !== undefined && knowledgeParts !== undefined) {
    const claimed = knowledgeParts.knowledge.derivedFrom.historySha256
    if (claimed !== archive.history.sha256) {
      throw new EpiFileError(
        'projection_mismatch',
        'the knowledge projection names a history this file does not carry',
      )
    }
  }
  if (knowledgeParts !== undefined) {
    const claimed = knowledgeParts.knowledge.derivedFrom.ontologySha256
    if (claimed !== knowledgeParts.ontology.sha256) {
      throw new EpiFileError(
        'projection_mismatch',
        'the knowledge projection names an ontology this file does not carry',
      )
    }
  }

  const epi: EpiFile = {
    format: EPI_FORMAT,
    version: EPI_VERSION,
    exportedAt: file.exportedAt,
    source: { file: source.file, build: source.build },
    profiles,
    ...(archive === undefined ? {} : { archive }),
    ...(knowledgeParts === undefined
      ? {}
      : { ontology: knowledgeParts.ontology, knowledge: knowledgeParts.knowledge }),
    ...(views === undefined ? {} : { views }),
  }
  return Object.freeze(epi)
}

function readProfiles(value: unknown): readonly EpiProfile[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new EpiFileError('invalid_profiles', 'profiles must be a non-empty array')
  }
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string' || !EPI_PROFILES.includes(entry as EpiProfile)) {
      throw new EpiFileError('invalid_profiles', `"${String(entry)}" is not a known profile`)
    }
    if (seen.has(entry)) {
      throw new EpiFileError('invalid_profiles', `"${entry}" is named twice in profiles`)
    }
    seen.add(entry)
  }
  // Canonical order, whatever the writer wrote, so two files of the same shape hash the same.
  return EPI_PROFILES.filter((profile) => seen.has(profile))
}

function readArchiveSection(
  value: unknown,
  fallbackSource: { readonly file: string; readonly build: string } | undefined,
): { readonly history: HistorySection } | undefined {
  if (value === undefined && fallbackSource === undefined) return undefined
  const archive = asObject(
    value,
    'missing_section',
    'the archive profile names a section this file does not carry',
  )
  const source = fallbackSource ?? { file: '', build: '' }
  const history = asObject(
    archive.history,
    'missing_section',
    'the archive section carries no history',
  )
  if (history.format !== V1_FORMAT || history.version !== V1_VERSION) {
    throw new EpiFileError(
      'damaged',
      `the history section is a "${String(history.format)}" version ${String(history.version)}, not a v1 portable export`,
    )
  }
  if (typeof history.exportedAt !== 'string' || !isIsoUtc(history.exportedAt)) {
    throw new EpiFileError('damaged', 'the history section carries no readable export time')
  }
  if (
    !Array.isArray(history.records) ||
    history.records.some((record) => typeof record !== 'string')
  ) {
    throw new EpiFileError('damaged', 'the history section carries records that are not strings')
  }
  if (!Array.isArray(history.companions) || !history.companions.every(isCompanion)) {
    throw new EpiFileError('damaged', 'the history section carries unreadable companions')
  }
  if (
    typeof history.sha256 !== 'string' ||
    historyDigestOf(history as unknown as HistorySection) !== history.sha256
  ) {
    throw new EpiFileError('damaged', 'the history section does not match its checksum')
  }
  const storedAs = asObject(history.storedAs, 'damaged', 'the history section carries no storedAs')
  const counts = asObject(history.counts, 'damaged', 'the history section carries no counts')
  return {
    history: {
      format: V1_FORMAT,
      version: V1_VERSION,
      exportedAt: history.exportedAt,
      source: {
        file:
          typeof (history.source as EpiSource | undefined)?.file === 'string'
            ? (history.source as EpiSource).file
            : source.file,
        build:
          typeof (history.source as EpiSource | undefined)?.build === 'string'
            ? (history.source as EpiSource).build
            : source.build,
      },
      storedAs: {
        sqliteFormat: Number(storedAs.sqliteFormat),
        recordSchema: Number(storedAs.recordSchema),
      },
      sha256: history.sha256,
      counts: {
        records: Number(counts.records),
        companions: (counts.companions ?? {}) as Readonly<Record<string, number>>,
      },
      records: history.records as readonly string[],
      companions: history.companions as HistorySection['companions'],
    },
  }
}

function readKnowledgeSections(
  ontologyValue: unknown,
  knowledgeValue: unknown,
): { readonly ontology: OntologyManifest; readonly knowledge: KnowledgeSection } | undefined {
  if (ontologyValue === undefined && knowledgeValue === undefined) return undefined
  const ontology = asObject(
    ontologyValue,
    'missing_section',
    'the knowledge profile names an ontology this file does not carry',
  )
  const packs = ontology.packs
  if (!Array.isArray(packs) || !packs.every(isPack)) {
    throw new EpiFileError('damaged', 'the ontology manifest carries unreadable packs')
  }
  const manifest: OntologyManifest = {
    packs: packs as readonly OntologyPack[],
    sha256: typeof ontology.sha256 === 'string' ? ontology.sha256 : '',
  }
  if (manifest.sha256 !== ontologyDigestOf(manifest)) {
    throw new EpiFileError('damaged', 'the ontology manifest does not match its checksum')
  }

  const knowledge = asObject(
    knowledgeValue,
    'missing_section',
    'the knowledge profile names a section this file does not carry',
  )
  const derivedFrom = asObject(
    knowledge.derivedFrom,
    'damaged',
    'the knowledge section carries no derivation receipt',
  )
  if (
    typeof derivedFrom.ontologySha256 !== 'string' ||
    typeof derivedFrom.filter !== 'object' ||
    derivedFrom.filter === null
  ) {
    throw new EpiFileError(
      'damaged',
      'the derivation receipt must name its ontology and its filter',
    )
  }
  if (derivedFrom.historySha256 !== undefined && typeof derivedFrom.historySha256 !== 'string') {
    throw new EpiFileError('damaged', 'the derivation receipt names an unreadable history')
  }
  if (typeof knowledge.derivedAt !== 'string' || !isIsoUtc(knowledge.derivedAt)) {
    throw new EpiFileError('damaged', 'the knowledge section carries no readable derivation time')
  }
  const arrays = ['nodes', 'edges', 'branches', 'state', 'publications', 'sources'] as const
  for (const key of arrays) {
    if (!Array.isArray(knowledge[key])) {
      throw new EpiFileError('damaged', `the knowledge section carries no readable ${key}`)
    }
  }
  const payload: Omit<KnowledgeSection, 'sha256'> = {
    derivedFrom: {
      ...(derivedFrom.historySha256 === undefined
        ? {}
        : { historySha256: derivedFrom.historySha256 }),
      ontologySha256: derivedFrom.ontologySha256,
      filter: derivedFrom.filter as Readonly<Record<string, unknown>>,
    },
    derivedAt: knowledge.derivedAt,
    nodes: knowledge.nodes as readonly unknown[],
    edges: knowledge.edges as readonly unknown[],
    branches: knowledge.branches as readonly unknown[],
    state: knowledge.state as readonly unknown[],
    publications: knowledge.publications as readonly unknown[],
    sources: knowledge.sources as readonly unknown[],
  }
  if (typeof knowledge.sha256 !== 'string' || knowledgeDigestOf(payload) !== knowledge.sha256) {
    throw new EpiFileError('damaged', 'the knowledge section does not match its checksum')
  }
  return { ontology: manifest, knowledge: { ...payload, sha256: knowledge.sha256 } }
}

/**
 * Views are derived presentation, checksummed by nothing and authoritative in nothing, so a broken
 * view entry is dropped rather than allowed to gate the knowledge it decorates (ADR 0023). The
 * file's truth — profiles, sections, checksums, receipts — is never a view's hostage.
 */
function readViews(value: unknown): readonly ViewSection[] | undefined {
  if (!Array.isArray(value)) return undefined
  const views = value.filter((view): view is ViewSection => {
    if (typeof view !== 'object' || view === null) return false
    const section = view as Record<string, unknown>
    if (typeof section.name !== 'string' || typeof section.kind !== 'string') return false
    return (
      typeof section.over === 'object' &&
      section.over !== null &&
      typeof section.layout === 'object' &&
      section.layout !== null
    )
  })
  return views.length === 0 ? undefined : views
}

function isCompanion(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const companion = value as { name?: unknown; seq?: unknown; body?: unknown }
  return (
    typeof companion.name === 'string' &&
    typeof companion.seq === 'number' &&
    typeof companion.body === 'string'
  )
}

function isPack(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const pack = value as { name?: unknown; revision?: unknown; definitions?: unknown }
  return (
    typeof pack.name === 'string' &&
    typeof pack.revision === 'string' &&
    typeof pack.definitions === 'object' &&
    pack.definitions !== null
  )
}

function isIsoUtc(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) return false
  return !Number.isNaN(Date.parse(value))
}

function asObject(value: unknown, code: EpiFileProblem, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EpiFileError(code, message)
  }
  return value as Record<string, unknown>
}
