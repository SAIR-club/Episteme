/**
 * Scoped knowledge publication (ADR 0023, decision 7): share one publication's subgraph as a
 * readable `.epi` knowledge file, without the private rest of the graph.
 *
 * The inclusion set is computed **before** serialization, from the persisted Publication record and
 * the publication rules (ADR 0014) re-verified against the records themselves — never by exporting
 * everything and hiding a view. What cannot be proven safe is refused with a named reason, never
 * silently omitted, and the file ships the knowledge-only profile: a cropped history is not a
 * restorable archive and must not pretend to be one.
 *
 * What the file carries: the published nodes, the author's edges between them, the public reference
 * nodes those edges reach, and the publication record itself. What it never carries: any other
 * node, any state event (understanding state is private by default), branches, revocations,
 * companions, or the private history.
 */
import {
  EPI_FORMAT,
  EPI_VERSION,
  knowledgeDigestOf,
  type EpiFile,
  type KnowledgeSection,
  type OntologyManifest,
} from '@episteme/epi-format'
import type { GraphEdge, GraphNode } from '@episteme/core'
import { deserializeRecord } from './records.js'
import {
  GraphExportError,
  exportFromGraph,
  type GraphExport,
  type GraphExportProblem,
} from './portable.js'
import { ontologyManifestOf, writeEpiFile, type EpiPackDefinitions } from './knowledge.js'

/** Publication-related refusals, carried by `GraphExportError` alongside the v1 export codes. */
export type ScopedExportProblem = Extract<
  GraphExportProblem,
  'no_publication' | 'ambiguous_publication' | 'withdrawn_publication' | 'unsafe_publication'
>

export interface ScopedExportOptions {
  readonly build: string
  readonly packs?: readonly EpiPackDefinitions[]
  readonly now?: () => Date
  /** The person whose publication is shared. Only a live publication of theirs is eligible. */
  readonly actorId: string
  /** The root of the published subgraph. */
  readonly root: string
}

/**
 * Builds a knowledge-only `.epi` file from one live publication, as a whitelist over the graph's
 * records. Every member and every boundary is re-verified against the persisted records: the
 * publication's own rules, applied again at export time, so a file is written only from content
 * that can be proven safe.
 */
export function buildPublishedEpi(graph: string, options: ScopedExportOptions): EpiFile {
  const exported = exportFromGraph(graph, {
    build: options.build,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return publishedEpiOf(exported, options)
}

/**
 * `buildPublishedEpi` without the graph read: the publication's rules re-verified against records
 * that are already in hand. Exposed on its own so hostile or damaged records can be tested without
 * a database — the same records reach the exporter from a graph file, whatever wrote it.
 */
export function publishedEpiOf(exported: GraphExport, options: ScopedExportOptions): EpiFile {
  let publication:
    | {
        readonly id: string
        readonly actorId: string
        readonly createdAt: number
        readonly root: string
        readonly members: readonly string[]
        readonly edges: readonly string[]
      }
    | undefined
  const withdrawn = new Set<string>()
  for (const body of exported.records) {
    const record = deserializeRecord(body, 0)
    if (record.kind === 'publication') {
      const candidate = record.publication
      if (candidate.actorId === options.actorId && candidate.root === options.root) {
        if (publication !== undefined) {
          throw new GraphExportError(
            'ambiguous_publication',
            `"${options.actorId}" has more than one publication rooted at "${options.root}"; name which one to share`,
          )
        }
        publication = candidate
      }
    }
    if (record.kind === 'withdrawal') withdrawn.add(record.withdrawal.publicationId)
  }
  if (publication === undefined) {
    throw new GraphExportError(
      'no_publication',
      `"${options.actorId}" has no publication rooted at "${options.root}", so nothing is authorized to share`,
    )
  }
  if (withdrawn.has(publication.id)) {
    throw new GraphExportError(
      'withdrawn_publication',
      `publication "${publication.id}" was withdrawn; withdrawn knowledge is not shared again`,
    )
  }

  const nodes = new Map<string, GraphNode>()
  const edges = new Map<string, GraphEdge>()
  for (const body of exported.records) {
    const record = deserializeRecord(body, 0)
    if (record.kind === 'node') nodes.set(record.node.id, record.node)
    if (record.kind === 'edge') edges.set(record.edge.id, record.edge)
  }

  const unsafe = (why: string): GraphExportError => new GraphExportError('unsafe_publication', why)

  // Re-verify the publication's own rules (ADR 0014) against the persisted records: membership is a
  // whitelist, and a member that cannot be proven safe refuses the whole export. The root is a
  // member too: a record that names a root outside the whitelist would make the file describe a
  // subgraph it does not carry.
  if (!publication.members.includes(publication.root)) {
    throw unsafe(
      `root "${publication.root}" of publication "${publication.id}" is not among its members`,
    )
  }
  const members = new Set<string>(publication.members)
  const nodesOut: GraphNode[] = []
  for (const id of publication.members) {
    const node = nodes.get(id)
    if (node === undefined || node.revoked === true || node.meta.tier === 'draft') {
      throw unsafe(`"${id}" is not a record that can be published`)
    }
    if (node.actorId !== publication.actorId) {
      throw unsafe(`"${id}" was written by someone else; it can be linked to, never published`)
    }
    nodesOut.push(node)
  }

  // Edges may reach public reference nodes outside the membership: the boundary is included as
  // context, because those nodes are visible to everyone by the publication rules.
  const edgesOut: GraphEdge[] = []
  for (const id of publication.edges) {
    const edge = edges.get(id)
    if (edge === undefined || edge.revoked === true) {
      throw unsafe(`edge "${id}" of publication "${publication.id}" is not a readable record`)
    }
    if (edge.actorId !== publication.actorId) {
      throw unsafe(
        `edge "${id}" of publication "${publication.id}" was written by someone else; it can be linked to, never published`,
      )
    }
    for (const endpoint of [edge.from, edge.to]) {
      if (members.has(endpoint)) continue
      const node = nodes.get(endpoint)
      if (node === undefined || node.revoked === true || node.meta.tier !== 'reference') {
        throw unsafe(
          `"${endpoint}" is reached by a published edge but cannot be proven visible to everyone`,
        )
      }
      members.add(endpoint)
      nodesOut.push(node)
    }
    edgesOut.push(edge)
  }

  const manifest = ontologyManifestOf(options.packs ?? [])
  const knowledge = knowledgeOf(
    publication,
    nodesOut,
    edgesOut,
    manifest,
    (options.now ?? (() => new Date()))().toISOString(),
  )

  return {
    format: EPI_FORMAT,
    version: EPI_VERSION,
    exportedAt: exported.exportedAt,
    source: exported.source,
    // Knowledge-only on purpose: no archive section, so no cropped history can masquerade as a
    // restorable backup, and no private record ever enters the file.
    profiles: ['knowledge'],
    ontology: manifest,
    knowledge,
  }
}

/** Writes the publication as an `.epi` knowledge file, under the same ownership rules as v1. */
export async function exportPublishedEpi(
  graph: string,
  target: string,
  options: ScopedExportOptions,
): Promise<EpiFile> {
  const epi = buildPublishedEpi(graph, options)
  await writeEpiFile(epi, target)
  return epi
}

function knowledgeOf(
  publication: {
    readonly id: string
    readonly actorId: string
    readonly createdAt: number
    readonly root: string
    readonly members: readonly string[]
    readonly edges: readonly string[]
  },
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  manifest: OntologyManifest,
  derivedAt: string,
): KnowledgeSection {
  const byKeys =
    <T>(key: (entry: T) => readonly (string | number)[]) =>
    (left: T, right: T): number => {
      const a = key(left)
      const b = key(right)
      for (let index = 0; index < a.length; index += 1) {
        if (a[index] !== b[index]) return (a[index] ?? 0) < (b[index] ?? 0) ? -1 : 1
      }
      return 0
    }

  const payload = {
    // No historySha256: there is no archive section, so the receipt pins what the projection
    // actually derives from — the ontology and the named whitelist.
    derivedFrom: {
      ontologySha256: manifest.sha256,
      filter: { publicationId: publication.id, root: publication.root, actor: publication.actorId },
    },
    derivedAt,
    nodes: [...nodes].sort(byKeys((node) => [node.createdAt, node.id])),
    edges: [...edges].sort(
      byKeys((edge) => [edge.type, edge.from, edge.to, edge.createdAt, edge.id]),
    ),
    // Understanding state is private by default; a publication shares knowledge, not anyone's
    // cognitive state, so state and branch lineage stay out of a scoped export entirely.
    branches: [],
    state: [],
    publications: [
      {
        id: publication.id,
        actorId: publication.actorId,
        createdAt: publication.createdAt,
        root: publication.root,
        members: [...publication.members].sort(),
        edges: [...publication.edges].sort(),
      },
    ],
    sources: [],
  }
  return { ...payload, sha256: knowledgeDigestOf(payload) }
}
