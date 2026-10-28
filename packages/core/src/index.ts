/**
 * Episteme Core — public surface.
 *
 * Core does exactly one job: it is the graph itself. It contains no application-specific
 * ranking, scenario algorithms, agent workflow orchestration, UI state, or domain policies.
 * Those belong to a Domain Extension or an Application, preserving Core as a generic
 * substrate for applications built on Episteme.
 *
 * Everything exported below must be usable with no frontend, no LLM and no database.
 */

// ── Identity, time and errors ────────────────────────────────────────────────
export { asId } from './ontology/ids.js'
export type {
  ActorId,
  NodeId,
  EdgeId,
  EventId,
  BranchId,
  TagId,
  NodeTypeId,
  EdgeTypeId,
  DimensionId,
  Brand,
} from './ontology/ids.js'

export { systemClock, createFixedClock } from './ontology/primitives.js'
export type {
  Clock,
  EpochMillis,
  Timestamps,
  Provenance,
  EntityRef,
} from './ontology/primitives.js'

export { EpistemeError, GuardRejection, isEpistemeError } from './errors.js'
export type { CoreErrorCode } from './errors.js'

// ── Ontology ─────────────────────────────────────────────────────────────────
export type { Actor, ActorKind, Authority, ActorDraft } from './ontology/actor.js'
export type {
  GraphNode,
  GraphEdge,
  SubGraph,
  Neighbors,
  NodeQuery,
  NodeMeta,
  Tier,
  EntityBase,
} from './ontology/resources.js'
export { queryNodes } from './ontology/resources.js'

export type {
  StateEvent,
  StateEventDraft,
  StateValue,
  StateAuthority,
  DimensionIndex,
  DimensionKind,
} from './ontology/state.js'

export {
  tag,
  sceneTag,
  topicTag,
  stateTag,
  actorTag,
  CORE_TAG_NAMESPACES,
} from './ontology/tags.js'
export type { Tag, CoreTagNamespace } from './ontology/tags.js'

// ── Registries: the only way vocabulary enters the system ────────────────────
export {
  NodeTypeRegistry,
  EdgeTypeRegistry,
  StateDimensionRegistry,
  TagNamespaceRegistry,
} from './graph/registry.js'
export type {
  NodeTypeDefinition,
  EdgeTypeDefinition,
  EdgeCategory,
  StateDimensionDefinition,
  TagNamespaceDefinition,
} from './graph/definitions.js'

export { createRegistries, defineDomainPack, applyDomainPacks } from './graph/registries.js'
export type {
  Registries,
  DomainPack,
  DomainPackContext,
  DomainPackDefinitions,
} from './graph/registries.js'

// ── Graph ────────────────────────────────────────────────────────────────────
export { CoreGraph, createGraph } from './graph/graph.js'
export type {
  CoreGraphOptions,
  GraphNodeDraft,
  GraphEdgeDraft,
  CognitiveStateView,
  MutationRefusal,
  PreviewResult,
  GraphStats,
} from './graph/graph.js'
export { emptyStateView } from './graph/graph.js'

// ── Guards: the single authoritative validation path ─────────────────────────
export {
  GuardRegistry,
  validateMutation,
  validateStructure,
  runGuards,
  ok,
  reject,
} from './guards/index.js'
export type {
  GraphMutation,
  MutationGuard,
  GuardContext,
  GuardGraphView,
  GuardVerdict,
} from './guards/index.js'

// ── Engram: append-only, branchable history of understanding ─────────────────
export {
  EventLog,
  createEventLog,
  createSequentialIdFactory,
  foldEvents,
  predecessorOf,
  subjectKey,
} from './events/index.js'
export type {
  EventLogOptions,
  EventCommitResult,
  StateCommit,
  HistoryQuery,
  HistoryOrder,
  Branch,
  IdFactory,
  Revocation,
  EventLogState,
  PersistentEventStore,
} from './events/index.js'

// ── Serialization: the durable form of an event, so adapters need not invent one ──
export type { SerializedStateEvent } from './events/serialization.js'
export { toSerializedEvent, fromSerializedEvent } from './events/serialization.js'

// ── Projection: one graph, many views ────────────────────────────────────────
export { project, selectSeeds, dimensionsOf, toSubGraph } from './projection/index.js'
export {
  isEdgeVisible,
  isNodeVisible,
  visibleTo,
  type GraphReadView,
  type VisibilityFacts,
} from './visibility/index.js'
export {
  PublicationLog,
  type Publication,
  type PublicationDraft,
  type PublicationId,
  type PublicationPreview,
  type PublicationsState,
  type Withdrawal,
} from './publication/index.js'
export type { Projection, ProjectionFilter } from './projection/index.js'

// ── Retrieval: getting previous understanding back ───────────────────────────
export {
  retrieve,
  termsOf,
  matchedTermsIn,
  isStopWord,
  HybridRetriever,
  LexicalGraphRetriever,
  EmbeddingRetriever,
  canExplain,
  toResult,
  DEFAULT_HYBRID_WEIGHTS,
  retrieveRelevantContext,
  retrieveWith,
  summarise,
  contextSummary,
  settledUnderstanding,
  hasOpenConflict,
  isOpenConflict,
  toAgentContext,
} from './retrieval/index.js'
export type {
  RetrievalQuery,
  RetrievalResult,
  RetrievedNode,
  Retriever,
  RetrieveQuery,
  RankSignal,
  SignalContribution,
  ScoredCandidate,
  ExplainingRetriever,
  HybridWeights,
  KnownUnderstanding,
  RelevantContext,
  RankedEntry,
  RetrieveContextOptions,
} from './retrieval/index.js'

// ── Embedding port: semantics behind an adapter, never a Core dependency ─────
export { EmbeddingError, embeddingKeyFor } from './embedding/index.js'
export type {
  EmbeddingAdapter,
  EmbeddingCache,
  EmbeddingFailureKind,
  CachedEmbedding,
  Vector,
} from './embedding/index.js'
export { cosineSimilarity, similaritySignal, isVector } from './embedding/similarity.js'
export { InMemoryEmbeddingCache, createInMemoryEmbeddingCache } from './embedding/cache.js'
export {
  DeterministicEmbeddingAdapter,
  createDeterministicEmbeddingAdapter,
  expandedTermsOf,
  lexiconTermsOf,
  lexiconTokens,
  retrievalTokens,
  tokensOf,
  EXPANDED_TERMS,
  CHINESE_TERMS,
  CHINESE_STOP_WORDS,
} from './embedding/deterministic.js'
export type { DeterministicEmbeddingOptions } from './embedding/deterministic.js'

// ── Storage ports: Core never binds to one database ───────────────────────────
export type { GraphStorageAdapter, GraphReadPort, GraphMutationPort } from './storage/adapter.js'
