import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import {
  applyDomainPacks,
  asId,
  createFixedClock,
  createGraph,
  createRegistries,
  defineDomainPack,
  EpistemeError,
  EventLog,
  project,
  type ActorId,
  type DomainPackDefinitions,
  type ProjectionFilter,
  type StateEvent,
} from '@episteme/core'
import {
  EPI_FORMAT,
  EPI_VERSION,
  canonicalJson,
  detectEpiKind,
  knowledgeDigestOf,
  ontologyDigestOf,
  readEpiFile,
  sha256Hex,
  type EpiFile,
  type KnowledgeSection,
  type OntologyManifest,
  type OntologyPack,
} from '@episteme/epi-format'
import { MemoryGraphStorage } from '@episteme/storage-memory'
import {
  deserializeRecord,
  RecordStorage,
  type LoadedState,
  type PersistedRecord,
} from './records.js'
import {
  GraphExportError,
  exportFromGraph,
  importFromExport,
  importGraph,
  type GraphExport,
} from './portable.js'

/**
 * The `.epi` v2 knowledge file (ADR 0023): the v1 portable export carried intact as the restorable
 * archive, beside an ontology manifest and a knowledge projection derived from the very history the
 * file holds.
 *
 * The projection is a cache with a receipt. It is built here, where `@episteme/core` is available to
 * fold and project exactly as a live session does — one implementation of the semantics, never a
 * second one — while a light reader reads what it produced without any of this machinery.
 */

export interface EpiPackDefinitions {
  readonly name: string
  readonly definitions: DomainPackDefinitions
}

/** The vocabulary a `.epi` file declares, as data: what the packs registered, and how they are named. */
export function ontologyManifestOf(packs: readonly EpiPackDefinitions[]): OntologyManifest {
  const entries: readonly OntologyPack[] = packs.map((pack) => ({
    name: pack.name,
    revision: sha256Hex(canonicalJson(pack.definitions)),
    definitions: pack.definitions,
  }))
  return { packs: entries, sha256: ontologyDigestOf({ packs: entries }) }
}

export interface BuildEpiFileOptions {
  readonly build: string
  /** The vocabulary the graph was written under, so the file can explain its own type ids. */
  readonly packs?: readonly EpiPackDefinitions[]
  readonly now?: () => Date
  /** The projection filter the knowledge section presents; empty means the whole visible graph. */
  readonly filter?: ProjectionFilter
}

/**
 * Builds a `.epi` v2 file's content for a graph: the restorable archive, the ontology manifest and a
 * knowledge projection derived from the records the archive carries. Nothing is written to `target`
 * here — the content is returned, and `writeEpiFile` puts it on disk.
 */
export function buildEpiFile(graph: string, options: BuildEpiFileOptions): EpiFile {
  const exported = exportFromGraph(graph, {
    build: options.build,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const manifest = ontologyManifestOf(options.packs ?? [])
  const knowledge = deriveKnowledge(
    exported,
    manifest,
    options.filter ?? {},
    (options.now ?? (() => new Date()))().toISOString(),
  )
  return {
    format: EPI_FORMAT,
    version: EPI_VERSION,
    exportedAt: exported.exportedAt,
    source: exported.source,
    profiles: ['archive', 'knowledge'],
    archive: { history: exported },
    ontology: manifest,
    knowledge,
  }
}

/**
 * Writes an `.epi` file. Same rules as a v1 export, because the file holds the same private material:
 * written once with `wx`, never over an existing file, readable only by its owner.
 */
export async function writeEpiFile(epi: EpiFile, target: string): Promise<void> {
  if (existsSync(target)) {
    throw new GraphExportError('target_exists', `"${target}" already exists; it was not replaced`)
  }
  await writeFile(target, JSON.stringify(epi), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
}

/** Builds the `.epi` content for a graph and writes it to `target`. */
export async function exportEpiFile(
  graph: string,
  target: string,
  options: BuildEpiFileOptions,
): Promise<EpiFile> {
  const epi = buildEpiFile(graph, options)
  await writeEpiFile(epi, target)
  return epi
}

/**
 * Brings a `.epi` file's understanding back as a new graph at `target`.
 *
 * A v1 portable export restores exactly as before. A v2 file restores through its archive section —
 * and only through its archive section: a knowledge-only file is readable, but it never claimed to
 * restore a graph, so restoring it is refused rather than faked.
 */
export async function importEpiFile(file: string, target: string): Promise<GraphExport> {
  const text = await readFile(file, 'utf8')
  if (detectEpiKind(text) === 'v1') return importGraph(file, target)
  const epi = readEpiFile(text)
  const history = epi.archive?.history
  if (history === undefined) {
    throw new GraphExportError(
      'not_an_export',
      `"${file}" carries no restorable history; it is a readable knowledge file`,
    )
  }
  return importFromExport(history as unknown as GraphExport, target)
}

/**
 * Derives the knowledge projection from the records an export carries, through the same Core
 * machinery a live session uses: the records are loaded through `RecordStorage` — the one
 * implementation of records → memory — into an `EventLog`, and the projection is `project` over the
 * wired view. Branch ancestry, revocations and per-actor state all come from Core; nothing here
 * re-derives a semantic another module already owns.
 */
function deriveKnowledge(
  exported: GraphExport,
  manifest: OntologyManifest,
  filter: ProjectionFilter,
  derivedAt: string,
): KnowledgeSection {
  const holder = new DerivedRecords()
  const loaded = holder.from(
    exported.records.map((body, index) => deserializeRecord(body, index + 1)),
  )
  const history = loaded.events

  if (history.branches.length === 0) {
    throw new GraphExportError(
      'damaged',
      'the export carries no branch record, so its history cannot be read',
    )
  }

  const storage = new MemoryGraphStorage()
  for (const node of loaded.nodes) storage.putNode(node)
  for (const edge of loaded.edges) storage.putEdge(edge)

  const registries = createRegistries()
  // The manifest declares the vocabulary by name and definitions; rebuilding it here is how the
  // projection is derived under exactly the vocabulary the file carries.
  applyDomainPacks(
    manifest.packs.map((pack) =>
      defineDomainPack(pack.name, pack.definitions as DomainPackDefinitions),
    ),
    { registries },
  )

  const actorOf = (event: StateEvent): string => event.actorId
  const defaultActor = asActorId(history.events[0]?.actorId ?? 'actor_human')
  const clock = createFixedClock(0)
  const graph = createGraph({ storage, registries, clock, actorId: defaultActor })
  const log = new EventLog({
    registries,
    clock,
    graph,
    defaultActorId: defaultActor,
    initialState: history,
  })
  const wired = createGraph({ storage, registries, state: log, clock, actorId: defaultActor })

  const view = project(wired, filter)
  // Ids may be content-independent UUIDs (edges, branches, publications), so the primary sort
  // keys must be stable fields; the id only breaks ties within one input. Same history and
  // ontology in, same normalized projection out — across runs.
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

  const actors = [...new Set(history.events.map(actorOf))].sort()
  const state = actors.flatMap((actor) =>
    view.nodes
      .filter((node) => log.hasState(node.id, asActorId(actor)))
      .map((node) => ({
        target: node.id,
        actor,
        dimensions: Object.fromEntries(
          [...log.stateOf(node.id, asActorId(actor)).entries()]
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([dimension, value]) => [dimension, value]),
        ),
      }))
      .sort((left, right) =>
        left.target < right.target ? -1 : left.target > right.target ? 1 : 0,
      ),
  )

  const payload = {
    derivedFrom: {
      historySha256: exported.sha256,
      ontologySha256: manifest.sha256,
      filter: filter as unknown as Readonly<Record<string, unknown>>,
    },
    derivedAt,
    nodes: [...view.nodes].sort(byKeys((node) => [node.createdAt, node.id])),
    edges: [...view.edges].sort(
      byKeys((edge) => [edge.type, edge.from, edge.to, edge.createdAt, edge.id]),
    ),
    branches: [...history.branches].sort(byKeys((branch) => [branch.createdAt, branch.id])),
    state,
    publications: [
      ...[...(history.publications ?? [])].sort(
        byKeys((publication) => [publication.createdAt, publication.id]),
      ),
      ...[...(history.withdrawals ?? [])].sort((left, right) =>
        left.publicationId < right.publicationId
          ? -1
          : left.publicationId > right.publicationId
            ? 1
            : 0,
      ),
    ],
    sources: [] as readonly unknown[],
  }
  return { ...payload, sha256: knowledgeDigestOf(payload) }
}

/**
 * The records of an export, read into memory through the same implementation a real graph file uses,
 * so the derivation cannot group or order a history differently from how a graph would. It is not a
 * file: nothing may open, save or back it up.
 */
class DerivedRecords extends RecordStorage {
  readonly name = 'derivation'

  protected get location(): string {
    return 'a .epi knowledge derivation'
  }

  from(records: readonly PersistedRecord[]): LoadedState {
    return this.restore(records)
  }

  open(): Promise<LoadedState> {
    return Promise.reject(
      new EpistemeError('guard_rejected', 'a derivation holder is not a file to open'),
    )
  }

  save(): Promise<void> {
    return Promise.reject(new EpistemeError('guard_rejected', 'a derivation holder saves nothing'))
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  backUp(): Promise<void> {
    return Promise.reject(
      new EpistemeError('guard_rejected', 'a derivation holder backs up nothing'),
    )
  }
}

function asActorId(actor: string): ActorId {
  return asId<ActorId>(actor)
}
