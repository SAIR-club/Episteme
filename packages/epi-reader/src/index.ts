/**
 * A lightweight reader for `.epi` knowledge files (ADR 0023).
 *
 * It reads what the file says — header, profiles, ontology manifest, knowledge projection and the
 * visible revision clues in an archive — and nothing more. No Core, no service, no storage: the
 * dependency list is `@episteme/epi-format` alone, and validation, checksums and refusal semantics
 * are the container's own (`readEpiFile`), so the reader cannot drift from the format contract.
 *
 * What the reader is honest about: a knowledge projection is a claim about a history, identified by
 * `derivedFrom`; `historyOf` surfaces the raw event clues an archive carries without refolding, and
 * `restorable` tells an archive from a knowledge-only file.
 */
import {
  EpiFileError,
  readEpiFile,
  type EpiFile,
  type HistorySection,
  type KnowledgeSection,
  type OntologyManifest,
} from '@episteme/epi-format'

/** The structural shape of a projected node: the reader reads what the file carries, optional where it must. */
export interface EpiNode {
  readonly id: string
  readonly type: string
  readonly label?: string
  readonly text?: string
  readonly tags?: readonly string[]
  readonly createdAt?: number
  readonly actorId?: string
  readonly tier?: string
}

export interface EpiEdge {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly type: string
  readonly createdAt?: number
}

export interface EpiBranch {
  readonly id: string
  readonly actorId?: string
  readonly createdAt?: number
  readonly parentBranchId?: string
  readonly forkPoint?: string
  readonly reason?: string
}

/** One actor's current understanding of one node, as folded by the writer. */
export interface EpiStateEntry {
  readonly target: string
  readonly actor: string
  readonly dimensions: Readonly<Record<string, unknown>>
}

/** A visible revision clue: one recorded state event, and whether a revocation withdraws it. */
export interface EpiRevisionClue {
  readonly eventId?: string
  readonly branchId?: string
  readonly actorId?: string
  readonly createdAt?: number
  readonly reason?: string
  readonly dimensions: Readonly<Record<string, unknown>>
  readonly revoked: boolean
  /** Why the recording was withdrawn, when the revocation carries one. */
  readonly revocationReason?: string
}

export interface EpiSubgraph {
  readonly nodes: readonly EpiNode[]
  readonly edges: readonly EpiEdge[]
}

export interface EpiKnowledgeFile {
  readonly format: string
  readonly version: number
  readonly profiles: readonly string[]
  readonly exportedAt: string
  readonly source: { readonly file: string; readonly build: string }
  /** True when the file carries an `archive` profile: the whole graph can come back. */
  readonly restorable: boolean
  readonly ontology: OntologyManifest | undefined
  nodeTypes(): readonly { readonly id: string; readonly label?: string }[]
  edgeTypes(): readonly {
    readonly id: string
    readonly label?: string
    readonly from?: readonly string[]
    readonly to?: readonly string[]
  }[]
  dimensions(): readonly {
    readonly id: string
    readonly kind?: string
    readonly levels?: readonly string[]
  }[]
  nodes(): readonly EpiNode[]
  node(id: string): EpiNode | undefined
  nodesByType(type: string): readonly EpiNode[]
  edges(): readonly EpiEdge[]
  /** Every edge touching `id`, either direction. */
  relationsOf(id: string): readonly EpiEdge[]
  /** Every node adjacent to `id` through a typed edge. */
  neighbors(id: string): readonly EpiNode[]
  /** Breadth-first closure from `root` along typed edges, up to `maxDepth` steps. */
  subgraphFrom(root: string, maxDepth: number): EpiSubgraph
  branches(): readonly EpiBranch[]
  actors(): readonly string[]
  state(): readonly EpiStateEntry[]
  stateOf(target: string): readonly EpiStateEntry[]
  publications(): readonly unknown[]
  sources(): readonly unknown[]
  /**
   * The state-event clues an archive carries for one node, in commit order, each marked with whether
   * a recorded revocation withdraws it. Clues are raw records, not a refold — visible history, not a
   * second authority. An empty array for a knowledge-only file.
   */
  historyOf(nodeId: string): readonly EpiRevisionClue[]
  /** Re-checks every checksum the file carries. Throws `EpiFileError` on the first mismatch. */
  verifyIntegrity(): void
}

/** Parses and fully validates an `.epi` file's text, then opens typed queries over it. */
export function openEpi(text: string): EpiKnowledgeFile {
  return openEnvelope(readEpiFile(text))
}

/** Opens typed queries over an already parsed, already validated envelope. */
export function openEnvelope(file: EpiFile): EpiKnowledgeFile {
  const knowledge = file.knowledge
  const archive = file.archive?.history
  const nodes = (knowledge?.nodes ?? []).map(asNode)
  const edges = (knowledge?.edges ?? []).map(asEdge)
  const branches = (knowledge?.branches ?? []).map(asBranch)
  const state = (knowledge?.state ?? []).map(asState)
  const nodeById = new Map(nodes.map((node) => [node.id, node]))

  const adjacency = new Map<string, EpiEdge[]>()
  for (const edge of edges) {
    for (const endpoint of [edge.from, edge.to]) {
      const list = adjacency.get(endpoint) ?? []
      list.push(edge)
      adjacency.set(endpoint, list)
    }
  }

  return {
    format: file.format,
    version: file.version,
    profiles: file.profiles,
    exportedAt: file.exportedAt,
    source: file.source,
    restorable: file.profiles.includes('archive') && archive !== undefined,
    ontology: file.ontology,
    nodeTypes: () =>
      (file.ontology?.packs ?? []).flatMap((pack) => pack.definitions.nodeTypes ?? []),
    edgeTypes: () =>
      (file.ontology?.packs ?? []).flatMap((pack) => pack.definitions.edgeTypes ?? []),
    dimensions: () =>
      (file.ontology?.packs ?? []).flatMap((pack) => pack.definitions.stateDimensions ?? []),
    nodes: () => nodes,
    node: (id) => nodeById.get(id),
    nodesByType: (type) => nodes.filter((node) => node.type === type),
    edges: () => edges,
    relationsOf: (id) => adjacency.get(id) ?? [],
    neighbors: (id) =>
      (adjacency.get(id) ?? [])
        .map((edge) => (edge.from === id ? edge.to : edge.from))
        .map((neighbor) => nodeById.get(neighbor))
        .filter((node) => node !== undefined),
    subgraphFrom: (root, maxDepth) => subgraph(root, maxDepth, nodeById, adjacency),
    branches: () => branches,
    actors: () => [...new Set(state.map((entry) => entry.actor))].sort(),
    state: () => state,
    stateOf: (target) => state.filter((entry) => entry.target === target),
    publications: () => knowledge?.publications ?? [],
    sources: () => knowledge?.sources ?? [],
    historyOf: (nodeId) => revisionClues(archive, nodeId),
    verifyIntegrity: () => verify(file, knowledge, archive),
  }
}

function subgraph(
  root: string,
  maxDepth: number,
  nodeById: Map<string, EpiNode>,
  adjacency: Map<string, EpiEdge[]>,
): EpiSubgraph {
  const start = nodeById.get(root)
  if (start === undefined) return { nodes: [], edges: [] }
  const seenNodes = new Set([root])
  const seenEdges = new Map<string, EpiEdge>()
  let frontier = [start]
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const next: EpiNode[] = []
    for (const node of frontier) {
      for (const edge of adjacency.get(node.id) ?? []) {
        const other = edge.from === node.id ? edge.to : edge.from
        const neighbor = nodeById.get(other)
        if (neighbor === undefined) continue
        seenEdges.set(edge.id, edge)
        if (!seenNodes.has(other)) {
          seenNodes.add(other)
          next.push(neighbor)
        }
      }
    }
    if (next.length === 0) break
    frontier = next
  }
  return {
    nodes: [...seenNodes]
      .map((id) => nodeById.get(id))
      .filter((node): node is EpiNode => node !== undefined),
    edges: [...seenEdges.values()],
  }
}

function revisionClues(
  archive: HistorySection | undefined,
  nodeId: string,
): readonly EpiRevisionClue[] {
  if (archive === undefined) return []
  const revoked = new Set<string>()
  const revocationReasons = new Map<string, string>()
  const clues: EpiRevisionClue[] = []
  for (const record of archive.records) {
    let parsed: unknown
    try {
      parsed = JSON.parse(record)
    } catch {
      throw new EpiFileError('damaged', 'the archive carries a record that is not valid JSON')
    }
    const body = parsed as {
      kind?: string
      event?: Record<string, unknown>
      revocation?: { eventId?: string; reason?: string }
    }
    if (body.kind === 'revocation' && typeof body.revocation?.eventId === 'string') {
      revoked.add(body.revocation.eventId)
      if (typeof body.revocation.reason === 'string') {
        revocationReasons.set(body.revocation.eventId, body.revocation.reason)
      }
      continue
    }
    if (body.kind !== 'event') continue
    const event = body.event
    if (event === undefined || event.target !== nodeId) continue
    clues.push({
      ...(typeof event.id === 'string' ? { eventId: event.id } : {}),
      ...(typeof event.branchId === 'string' ? { branchId: event.branchId } : {}),
      ...(typeof event.actorId === 'string' ? { actorId: event.actorId } : {}),
      ...(typeof event.createdAt === 'number' ? { createdAt: event.createdAt } : {}),
      ...(typeof event.reason === 'string' ? { reason: event.reason } : {}),
      dimensions: asDimensionRecord(event.dimensions),
      revoked: false,
    })
  }
  return clues.map((clue) => {
    if (clue.eventId === undefined || !revoked.has(clue.eventId)) return clue
    const revocationReason = revocationReasons.get(clue.eventId)
    return {
      ...clue,
      revoked: true,
      ...(revocationReason === undefined ? {} : { revocationReason }),
    }
  })
}

function verify(
  file: EpiFile,
  knowledge: KnowledgeSection | undefined,
  archive: HistorySection | undefined,
): void {
  // `readEpiFile` validated this once; the reader offers the re-check so a consumer that holds an
  // envelope for a long time can ask again before it trusts it.
  openEnvelope(file)
  if (archive !== undefined && knowledge !== undefined) {
    if (knowledge.derivedFrom.historySha256 !== archive.sha256) {
      throw new EpiFileError('projection_mismatch', 'the receipt no longer matches the archive')
    }
  }
}

function asDimensionRecord(value: unknown): Readonly<Record<string, unknown>> {
  // Persisted events serialize their dimensions map as [key, value] pairs; the reader gives them
  // back in the same object form the knowledge section's state uses.
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.filter((pair): pair is [string, unknown] => Array.isArray(pair)),
    )
  }
  return isRecord(value) ? value : {}
}

function asNode(value: unknown): EpiNode {
  const node = asRecord(value, 'a knowledge node')
  return {
    id: stringOf(node, 'id'),
    type: stringOf(node, 'type'),
    ...(typeof node.label === 'string' ? { label: node.label } : {}),
    ...(isRecord(node.properties) && typeof node.properties.text === 'string'
      ? { text: node.properties.text }
      : {}),
    ...(Array.isArray(node.tags)
      ? { tags: node.tags.filter((tag) => typeof tag === 'string') }
      : {}),
    ...(typeof node.createdAt === 'number' ? { createdAt: node.createdAt } : {}),
    ...(typeof node.actorId === 'string' ? { actorId: node.actorId } : {}),
    ...(isRecord(node.meta) && typeof node.meta.tier === 'string' ? { tier: node.meta.tier } : {}),
  }
}

function asEdge(value: unknown): EpiEdge {
  const edge = asRecord(value, 'a knowledge edge')
  return {
    id: stringOf(edge, 'id'),
    from: stringOf(edge, 'from'),
    to: stringOf(edge, 'to'),
    type: stringOf(edge, 'type'),
    ...(typeof edge.createdAt === 'number' ? { createdAt: edge.createdAt } : {}),
  }
}

function asBranch(value: unknown): EpiBranch {
  const branch = asRecord(value, 'a knowledge branch')
  return {
    id: stringOf(branch, 'id'),
    ...(typeof branch.actorId === 'string' ? { actorId: branch.actorId } : {}),
    ...(typeof branch.createdAt === 'number' ? { createdAt: branch.createdAt } : {}),
    ...(typeof branch.parentBranchId === 'string' ? { parentBranchId: branch.parentBranchId } : {}),
    ...(typeof branch.forkPoint === 'string' ? { forkPoint: branch.forkPoint } : {}),
    ...(typeof branch.reason === 'string' ? { reason: branch.reason } : {}),
  }
}

function asState(value: unknown): EpiStateEntry {
  const entry = asRecord(value, 'a state entry')
  return {
    target: stringOf(entry, 'target'),
    actor: stringOf(entry, 'actor'),
    dimensions: isRecord(entry.dimensions) ? entry.dimensions : {},
  }
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new EpiFileError('damaged', `the knowledge section carries ${what} that is not an object`)
  }
  return value as Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOf(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') {
    throw new EpiFileError('damaged', `the knowledge section carries an entry without a ${key}`)
  }
  return value
}

// Re-exported so a consumer needs exactly one package to read and to refuse.
export { EpiFileError, readEpiEnvelope, readEpiFile } from '@episteme/epi-format'
export type {
  EpiFile,
  EpiFileProblem,
  KnowledgeSection,
  OntologyManifest,
} from '@episteme/epi-format'
