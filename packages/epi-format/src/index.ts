/**
 * The `.epi` knowledge-file container, with no dependencies: what any reader and any writer of the
 * format must agree on before they disagree about anything else.
 *
 * Canonical JSON and checksums live here so a writer and a light reader cannot drift; the envelope's
 * refusal semantics live here so a file that claims more than it proves is refused, never trusted.
 */
export {
  CanonicalJsonError,
  canonicalJson,
  sha256Hex,
} from './canonical.js'
export { EpiFileError, type EpiFileProblem } from './errors.js'
export {
  EPI_FORMAT,
  EPI_PROFILES,
  EPI_VERSION,
  V1_FORMAT,
  V1_VERSION,
  detectEpiKind,
  historyDigestOf,
  knowledgeDigestOf,
  ontologyDigestOf,
  readEpiEnvelope,
  readEpiFile,
  type DerivedFrom,
  type EpiFile,
  type EpiKind,
  type EpiProfile,
  type EpiSource,
  type HistorySection,
  type KnowledgeSection,
  type OntologyManifest,
  type OntologyPack,
  type OntologyPackDefinitions,
  type ViewSection,
} from './container.js'
