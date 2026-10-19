import { randomUUID } from 'node:crypto'
import { access, copyFile } from 'node:fs/promises'
import {
  DeterministicEmbeddingAdapter,
  InMemoryEmbeddingCache,
  asId,
  isEpistemeError,
  systemClock,
  toSerializedEvent,
  type SerializedStateEvent,
  defineDomainPack,
  type DomainPack,
  type ActorId,
  type DimensionId,
  type EdgeId,
  type EdgeTypeId,
  type MutationRefusal,
  type NodeTypeId,
  type EmbeddingAdapter,
  type GraphNode,
  type NodeId,
  type StateValue,
  topicTag,
  tag,
  type Tag,
} from '@episteme/core'
import {
  HybridRetriever,
  retrieveWith,
  visibleTo,
  type GraphReadView,
  type Publication,
  type PublicationDraft,
  type PublicationPreview,
  type Withdrawal,
  toAgentContext,
  type RankedEntry,
  type RelevantContext,
  type Retriever,
} from '@episteme/core'
import { MockCognitiveAgent } from '@episteme/agent'
import {
  newSuggestionIds,
  SUGGESTED_NODE_PREFIX,
  SuggestionStore,
  type Proposal,
  type Resolution,
  ownerOf,
  type Delegation,
  type Review,
  type Reviewer,
  type Suggestion,
  type SuggestionOrigin,
} from './suggestions.js'
import {
  SourceStore,
  payloadDigest,
  textDigest,
  type Source,
  type SourceReader,
  type SourceSubmission,
} from './sources.js'
import { CANDIDATE_PREFIX, type CognitiveAgent } from '@episteme/agent'
import {
  RuleBasedDistiller,
  MIN_QUOTE_SIGNS,
  canonicalText,
  distill,
  hostRefusalOf,
  occurrencesOf,
  prepareHostReading,
  quoteSigns,
  type DistillationPolicy,
  type HostItem,
} from '@episteme/distillation'
import { agentActor, humanActor, openEpisteme, type Episteme } from '@episteme/sdk'
import { openLocalStorage } from '@episteme/storage-local'
import { MAX_SCENE_RECORD_BYTES, SceneRecordStore, type SceneRecord } from './scene-records.js'
import { ThreadStore, type Thread, type Turn, type TurnSummary } from './threads.js'
import { learnScene } from './learn-scene.js'
import type { RecordableDimension, SessionScene } from './scene.js'

const DIMENSION = {
  confidence: asId<DimensionId>('confidence'),
  articulation: asId<DimensionId>('articulation'),
  evidence: asId<DimensionId>('evidence'),
  conflict: asId<DimensionId>('conflict'),
} as const

const NODE = {
  concept: asId<NodeTypeId>('concept'),
  claim: asId<NodeTypeId>('claim'),
  question: asId<NodeTypeId>('question'),
} as const

const EDGE = {
  refersTo: asId<EdgeTypeId>('refers_to'),
} as const

function defaultTags(topic = 'general', scope?: string): readonly Tag[] {
  const tags = [topicTag(topic), tag('scene', 'cognitive')]
  return scope === undefined ? tags : [...tags, tag('scope', scope)]
}

/**
 * What the application itself registers for every scene: the `scope` tag namespace, which marks the learning
 * project or course a node belongs to (ADR 0015, decision 6).
 */
const applicationPack: DomainPack = defineDomainPack('episteme-application', {
  tagNamespaces: [{ namespace: 'scope', label: 'Scope' }],
})

function defaultResponder(
  input: { readonly text: string },
  context: { readonly summary?: string },
): { text: string; usedContext: boolean; contextSummary?: string } {
  const summary = context.summary?.trim() ?? ''
  if (summary === '') {
    return {
      text: `Let's establish the foundation first regarding "${input.text}".`,
      usedContext: false,
    }
  }
  return {
    text: `Building on what is understood (${summary}): ${input.text}.`,
    usedContext: true,
    contextSummary: summary,
  }
}

/**
 * The Learn interaction session.
 *
 * This is the smallest surface on which the project's claim can actually be used rather than asserted:
 * a learner asks, sees which of their own prior understanding was retrieved **and why**, records what
 * they now understand, and the next answer is built on it.
 *
 * Three deliberate properties:
 *
 * 1. **Every answer is produced by the same retrieval that is displayed.** The reasons shown are the
 *    contributions that produced the ranking shown, from one call. A view that showed reasons fetched
 *    separately could disagree with the order next to them.
 * 2. **The agent cannot write.** Recording understanding goes through `record()`, which commits a
 *    `StateEvent` authored by the *human*; the agent only ever supplies answer text. The
 *    `core/ai-cannot-author-state` guard enforces this, and nothing here bypasses it.
 * 3. **Nothing is held only in memory.** Every recorded understanding is persisted, so the session can be
 *    closed and reopened, which is the whole point of the earlier phases.
 */

const HUMAN = asId<ActorId>('actor_human')
const SCAFFOLD = asId<ActorId>('actor_scaffold')

/**
 * Why a level may not be recorded on a recordable dimension, or `undefined` when it may.
 *
 * The one check behind both `record()` and a proposal's preview, so what a learner may write and what an agent
 * may propose cannot disagree. A legacy level is refused here even though Core still accepts it for old events.
 */
function levelRefusal(
  dimension: RecordableDimension,
  level: string,
): { readonly code: 'invalid_dimension_value'; readonly message: string } | undefined {
  if (dimension.levels.includes(level)) return undefined
  return {
    code: 'invalid_dimension_value',
    message: `"${level}" is not a level of ${dimension.id} that can be recorded. Available: ${dimension.levels.join(', ')}`,
  }
}

/** One retrieved node, with everything a view needs to justify its position. */
export interface RankedView {
  readonly nodeId: string
  readonly label: string
  readonly type: string
  readonly score: number
  readonly origin: 'match' | 'neighbor'
  readonly matchedTerms: readonly string[]
  /** The contributions that produced the score, largest first. */
  readonly reasons: readonly ReasonView[]
}

export interface ReasonView {
  readonly signal: string
  readonly value: number
  readonly weight: number
  readonly contribution: number
  /** Share of the total score, so the display can show what dominated. */
  readonly share: number
  /** How this signal is being read, in the learner's terms. */
  readonly explanation: string
  /** The same reading in Simplified Chinese, for the primary learner-facing display. */
  readonly explanationZh: string
  /** The signal's name in Chinese. */
  readonly labelZh: string
}

/** What this actor has recorded about one retrieved node. */
export interface UnderstandingView {
  readonly nodeId: string
  readonly label: string
  readonly settled: boolean
  readonly openConflicts: readonly string[]
  readonly dimensions: readonly { readonly id: string; readonly level: string }[]
}

/** The evidence for a question: what was retrieved, why, and what the learner has recorded about it. */
export interface RecallResult {
  readonly question: string
  readonly retriever: string
  readonly summary: string
  readonly known: readonly UnderstandingView[]
  readonly ranked: readonly RankedView[]
  readonly rules: readonly RankRule[]
}

export interface AskResult extends RecallResult {
  readonly answer: string
  /** Whether the answer was shaped by recorded prior understanding. Data, not prose. */
  readonly usedContext: boolean
}

/** The scoring model, echoed so the surface can be honest about how relevance was decided. */
export interface RankRule {
  readonly signal: string
  readonly weight: number
}

/** One registered dimension as a client sees it, so no page has to write levels of its own (ADR 0013). */
export interface VocabularyDimension {
  readonly id: string
  readonly label: string
  readonly kind: string
  /** Whether a person can record it by hand in the session's scene; see `recordableDimensions`. */
  readonly recordable: boolean
  /** Every registered level in registration order. A legacy level is shown, never offered for new input. */
  readonly levels: readonly { readonly id: string; readonly legacy: boolean }[]
}

export interface NodeView {
  readonly nodeId: string
  readonly label: string
  readonly type: string
  readonly tier: string
  readonly tags: readonly string[]
  /** The suggestion this node was accepted from, so a reference to that suggestion can be shown by name. */
  readonly fromSuggestion?: string
}

/**
 * Why an item deserves attention next.
 *
 * Deliberately four coarse states rather than a score. The learner's question is "what should I look at?",
 * and a ranked number would imply a precision this reading does not have — it comes from four settable
 * dimensions, not from measurement.
 */
export type AttentionReason =
  /** The learner holds something that contradicts this. */
  | 'conflict'
  /** Recorded, but not firmly enough to build on. */
  | 'shaky'
  /** Believed without being explainable — the situation a scaffold is for. */
  | 'unexplained'
  /** Firmly held and explainable. Nothing to add by resurfacing it. */
  | 'settled'

export interface ProgressItem {
  readonly nodeId: string
  readonly label: string
  readonly type: string
  readonly dimensions: readonly { readonly id: string; readonly level: string }[]
  readonly settled: boolean
  readonly openConflicts: readonly string[]
  readonly attention: AttentionReason
}

export interface ProgressSummary {
  /** How many nodes the learner has recorded anything about. */
  readonly touched: number
  readonly settled: number
  readonly withOpenConflict: number
  readonly totalNodes: number
  /** Most in need of attention first. */
  readonly items: readonly ProgressItem[]
  /** One readable line, so a surface does not have to compose the numbers itself. */
  readonly summary: string
}

/** How a thread's speakers are written when its turns become material to distil. */
const LEARNER_LABEL = '学习者'
const AGENT_LABEL = '助手'

/** The thread a distillation's material was built from, and where each of its turns lies in the text. */
export interface ThreadMaterial {
  readonly id: string
  readonly turns: readonly { readonly id: string; readonly start: number; readonly end: number }[]
}

/** A thread as its owner reads it: every turn, raw, with its current summary. */
export interface ThreadView {
  readonly thread: Thread
  readonly turns: readonly (Turn & { readonly summary?: TurnSummary })[]
}

/** An origin, with the turn its words lie in when the material came from a thread. */
function withTurn(origin: SuggestionOrigin, thread: ThreadMaterial | undefined): SuggestionOrigin {
  if (thread === undefined) return origin
  const turn = thread.turns.find(
    (range) => origin.span.start >= range.start && origin.span.start < range.end,
  )
  return turn === undefined ? origin : { ...origin, turn: turn.id }
}

/** A published node as anyone may read it. No state of anyone's is part of it. */
export interface PublicNode {
  readonly nodeId: string
  readonly label: string
  readonly type: string
  readonly author: string
  readonly source?: string
  readonly origin?: unknown
  /** Whether its author holds it by their own decision or under a delegation (ADR 0016). */
  readonly confirmation: 'person' | 'delegation'
}

/** A thread in a publication: summaries only. */
export interface PublishedThread {
  readonly id: string
  readonly title: string
  readonly turns: readonly {
    readonly turn: string
    readonly seq: number
    readonly speaker: 'learner' | 'agent'
    readonly summary: string
  }[]
}

export type PublicationPlan =
  | {
      readonly ok: true
      readonly publication: Publication
      readonly public: {
        readonly nodes: readonly PublicNode[]
        readonly threads: readonly PublishedThread[]
      }
      readonly private: {
        readonly otherNodes: number
        readonly state: string
        readonly drafts: number
        readonly sources: number
        readonly unsummarizedTurns: readonly string[]
        readonly reminder: string
      }
    }
  | { readonly ok: false; readonly refusal: MutationRefusal }

export interface PublicationSummary {
  readonly id: string
  readonly author: string
  readonly createdAt: number
  readonly rootLabel: string
  readonly members: number
  /** 1 for a first publication, 2 for the one that superseded it, and so on. */
  readonly version: number
  readonly note?: string
}

export interface PublicationView {
  readonly publication: Publication
  readonly live: boolean
  readonly withdrawnAt?: number
  readonly nodes: readonly PublicNode[]
  readonly edges: readonly {
    readonly id: string
    readonly type: string
    readonly from: string
    readonly to: string
  }[]
  readonly threads: readonly PublishedThread[]
  /** The version chain, oldest first, this one included. */
  readonly versions: readonly string[]
}

export interface PublicationUpdate {
  readonly adopted: string
  readonly newer: string
  readonly added: readonly string[]
  readonly removed: readonly string[]
}

/** How many items recall returns. */
const RECALL_LIMIT = 8
/** What a scope adds to an item's score: enough to lift it above an unscoped near-tie, not above a clear match. */
export const SCOPE_BOOST = 0.15
/** The characters a compact recall may use by default. */
export const DEFAULT_RECALL_BUDGET = 2000

export interface RecallOptions {
  /** A project or course to prefer, not to filter by (ADR 0015, decision 6). */
  readonly scope?: string
  /** For `recallSummary`: the characters it may use. */
  readonly budget?: number
}

export interface RecallSummaryEntry {
  readonly nodeId: string
  readonly label: string
  readonly type: string
  readonly score: number
  /** What this person recorded about it, compactly. */
  readonly state?: string
  readonly openConflict?: true
  readonly inScope?: true
}

export interface RecallSummary {
  readonly question: string
  readonly scope?: string
  readonly entries: readonly RecallSummaryEntry[]
  /** How many retrieved items the budget left out. */
  readonly truncated: number
  readonly budget: number
}

export interface ExpandedNode {
  readonly nodeId: string
  readonly label: string
  readonly type: string
  readonly tier: string
  readonly tags: readonly string[]
  readonly text?: string
  readonly author: string
  readonly source?: string
  readonly origin?: unknown
  readonly understanding: readonly { readonly id: string; readonly level: string }[]
  readonly neighbours: readonly {
    readonly edgeId: string
    readonly type: string
    readonly direction: 'in' | 'out'
    readonly nodeId: string
    readonly label: string
  }[]
  /** Live publications it is a member of. */
  readonly publications: readonly string[]
}

/** A ranked item with the scope's boost added, as a reason of its own. */
function withScopeBoost(entry: RankedView, scope: string): RankedView {
  const score = entry.score + SCOPE_BOOST
  const reasons = [
    ...entry.reasons,
    {
      signal: 'scope',
      value: 1,
      weight: SCOPE_BOOST,
      contribution: SCOPE_BOOST,
      share: 0,
      explanation: `belongs to "${scope}", the scope asked for`,
      explanationZh: `属于你指定的范围「${scope}」`,
      labelZh: '范围',
    },
  ]
    .map((reason) => ({ ...reason, share: score === 0 ? 0 : reason.contribution / score }))
    .sort((left, right) => right.contribution - left.contribution)
  return { ...entry, score, reasons }
}

/** What a person asks to publish: a node of theirs, and optionally more of theirs it reaches. */
export interface PublicationRequest {
  readonly root: string
  readonly include?: readonly string[]
  /** Threads of the author's whose summaries are published with it; never their raw turns (ADR 0015). */
  readonly threads?: readonly string[]
  /** Their earlier live publication this one replaces. */
  readonly supersedes?: string
  readonly note?: string
}

export interface SessionOptions {
  /** Where the graph lives. Without one, the session is in memory and loses everything on exit. */
  readonly filePath?: string
  readonly adapter?: EmbeddingAdapter
  readonly weights?: ConstructorParameters<typeof HybridRetriever>[4]
  /**
   * The scene the session serves: its packs, distillation policy and recordable dimensions (ADR 0013).
   * Without one, the deprecated built-in Learn scene, for one release.
   */
  readonly scene?: SessionScene
  /**
   * Whether people may publish (ADR 0014). Off by default: a graph that holds a publication cannot be opened by
   * a build from before publications, so turning it on is a deliberate choice.
   */
  readonly sharing?: boolean
  /** Replaces the scene's packs, for a caller that composes the graph with packs of its own. */
  readonly packs?: readonly DomainPack[]
}

/**
 * A live session over one graph, for one scene.
 *
 * Holds one composed instance and one retriever, so every call reads the same graph and the same event
 * history. Rebuilding the retriever per call would reintroduce the possibility of a display that does not
 * match the answer it accompanies.
 */
/** What every person's session over one graph shares: one mutation queue, one revision, one lifetime. */
interface SharedState {
  /** The tail of the mutation queue. See `#exclusive`. */
  mutations: Promise<unknown>
  /** See `revision`. Advanced only by `#exclusive`. */
  revision: number
  closed: boolean
  /** See `epoch`. */
  readonly epoch: string
  readonly recovered: RecoveredDecision[]
  /** The session of each person met so far, so every request for them reads through the same one. */
  readonly people: Map<string, CognitiveSession>
}

/** What a session is built from. Every person's session over one graph is built from the same parts. */
interface SessionParts {
  readonly scene: SessionScene
  readonly episteme: Episteme
  readonly suggestions: SuggestionStore
  readonly sources: SourceStore
  readonly store: Store | undefined
  readonly threads: ThreadStore
  readonly records: SceneRecordStore
  /** The graph file, when there is one, so it can be copied aside before its first publication. */
  readonly filePath: string | undefined
  readonly sharing: boolean
  /** The retriever for one person's view of the graph, sharing one embedding cache with the others. */
  readonly retrieverFor: (view: GraphReadView) => Retriever
}

export class CognitiveSession {
  readonly #parts: SessionParts
  readonly #episteme: Episteme
  readonly #retriever: Retriever
  readonly #agent = new MockCognitiveAgent({ responder: defaultResponder })
  readonly #store: Store | undefined
  readonly #suggestions: SuggestionStore
  readonly #sources: SourceStore
  readonly #scene: SessionScene
  /** The person this session is for: whose state it reads and writes, and whose view of the graph it has. */
  readonly #actor: ActorId
  /** The graph as `#actor` may see it (ADR 0014). Every read of nodes and edges goes through it. */
  readonly #seen: GraphReadView
  readonly #shared: SharedState

  private constructor(parts: SessionParts, actor: ActorId, shared: SharedState) {
    this.#parts = parts
    this.#scene = parts.scene
    this.#episteme = parts.episteme
    this.#suggestions = parts.suggestions
    this.#sources = parts.sources
    this.#store = parts.store
    this.#actor = actor
    this.#seen = visibleTo(parts.episteme.graph, actor)
    this.#retriever = parts.retrieverFor(this.#seen)
    this.#shared = shared
  }

  /**
   * The session of `actorId` over the same graph (ADR 0014, step S3): one graph and one owner, a view per person.
   *
   * Everything it reads is what that person may see, and everything it writes is theirs. It shares this
   * session's mutation queue, revision and lifetime, so closing any of them closes the graph for all.
   */
  forActor(actorId: string, displayName = 'Person'): CognitiveSession {
    const known = this.#shared.people.get(actorId)
    if (known !== undefined) return known
    const id = asId<ActorId>(actorId)
    this.#episteme.registerActor(humanActor(id, displayName))
    const session = new CognitiveSession(this.#parts, id, this.#shared)
    this.#shared.people.set(actorId, session)
    return session
  }

  /**
   * Opens a session, reading any existing history first.
   *
   * The ordering — load, then compose — is the rule `@episteme/sdk` exists to hold, so this does not
   * repeat it.
   */
  static async open(options: SessionOptions = {}): Promise<CognitiveSession> {
    const actors = [humanActor(HUMAN), agentActor(SCAFFOLD)]
    const adapter = options.adapter ?? new DeterministicEmbeddingAdapter()
    const scene = options.scene ?? learnScene
    const packs = [applicationPack, ...(options.packs ?? scene.packs)]

    // One embedding cache for every person's retriever: what a text means does not depend on who asks.
    const cache = new InMemoryEmbeddingCache()
    const retrieverFor =
      (episteme: Episteme) =>
      (view: GraphReadView): Retriever =>
        new HybridRetriever(
          view,
          episteme.log,
          adapter,
          cache,
          ...(options.weights === undefined ? [] : [options.weights]),
        )

    if (options.filePath === undefined) {
      const { compose } = await import('@episteme/sdk')
      const episteme = compose({ actors, actorId: HUMAN, packs })
      return CognitiveSession.#owner({
        scene,
        episteme,
        suggestions: await SuggestionStore.open(),
        sources: await SourceStore.open(),
        threads: await ThreadStore.open(),
        records: await SceneRecordStore.open(),
        store: undefined,
        filePath: undefined,
        sharing: options.sharing === true,
        retrieverFor: retrieverFor(episteme),
      })
    }

    const storage = await openLocalStorage(options.filePath)
    let episteme: Episteme
    let suggestions: SuggestionStore
    let sources: SourceStore
    let threads: ThreadStore
    let records: SceneRecordStore
    try {
      episteme = await openEpisteme(storage, { actors, actorId: HUMAN, packs })
      // Opened only after the graph's lock is held, so the drafts have the same single owner as the graph.
      suggestions = await SuggestionStore.open(suggestionsPathFor(options.filePath))
      // Material distilled into this graph, kept beside it like the drafts and owned with it.
      sources = await SourceStore.open(`${options.filePath}.sources.jsonl`)
      // Conversations and a scene's own records, beside the graph and owned with it (ADR 0015).
      threads = await ThreadStore.open(`${options.filePath}.threads.jsonl`)
      records = await SceneRecordStore.open(`${options.filePath}.scene.jsonl`)
    } catch (error) {
      // The file is owned from the moment storage opened. A history that fails to restore must not keep it.
      await storage.close()
      throw error
    }
    const session = CognitiveSession.#owner({
      scene,
      episteme,
      suggestions,
      sources,
      threads,
      records,
      store: storage,
      filePath: options.filePath,
      sharing: options.sharing === true,
      retrieverFor: retrieverFor(episteme),
    })
    try {
      // Before anyone can use it: a decision a crash left half-done is finished or undone first.
      await session.#recover()
    } catch (error) {
      await storage.close()
      throw error
    }
    return session
  }

  /** The scene this session serves. */
  get scene(): SessionScene {
    return this.#scene
  }

  /** The dimensions a person may record by hand in this session's scene, in the order they are offered. */
  get recordableDimensions(): readonly RecordableDimension[] {
    return this.#scene.recordableDimensions
  }

  /** The session of the graph's own person, from which every other person's session is made. */
  static #owner(parts: SessionParts): CognitiveSession {
    const shared: SharedState = {
      mutations: Promise.resolve(),
      revision: 0,
      closed: false,
      epoch: randomUUID(),
      recovered: [],
      people: new Map(),
    }
    const session = new CognitiveSession(parts, HUMAN, shared)
    shared.people.set(HUMAN, session)
    return session
  }

  get actorId(): ActorId {
    return this.#actor
  }

  get graph(): Episteme['graph'] {
    return this.#episteme.graph
  }

  /**
   * The event history, for a view or a test that needs to read it.
   *
   * Exposed read-only in spirit: nothing in this app writes to it except `record()`, which authors as the
   * human. Handing out the log is safe precisely because Core's guards reject a non-human author, so there
   * is no path through it that lets an agent write the learner's understanding.
   */
  get log(): Episteme['log'] {
    return this.#episteme.log
  }

  get retrieverName(): string {
    return this.#retriever.name
  }

  get rules(): readonly RankRule[] {
    if (this.#retriever instanceof HybridRetriever) {
      const weights = this.#retriever.weights
      return Object.entries(weights).map(([signal, weight]) => ({
        signal,
        weight,
      }))
    }
    return []
  }

  get eventCount(): number {
    return this.#episteme.log.eventCount
  }

  /**
   * Which state of the graph, the history and the drafts a read saw, so that several reads can tell whether
   * they describe the same one.
   *
   * It advances when a mutation starts and again when it ends, so it is even while nothing is changing and odd
   * while a change is in progress. Two reads that return the same even revision saw the same state. An odd
   * revision promises nothing, because a mutation can be read between its steps: read again. It may advance
   * without anything having changed, as it does for a refused mutation, but it never stays put across a change.
   *
   * It counts within this session only, from zero when the session opens, so it identifies a state only
   * together with `epoch`.
   */
  get revision(): number {
    return this.#shared.revision
  }

  /**
   * Which opening of the graph a `revision` counts within. A new session, such as after a restart, starts a
   * new epoch, so a revision remembered from before cannot be mistaken for the same number counted again.
   */
  get epoch(): string {
    return this.#shared.epoch
  }

  /**
   * Asks a question and returns the answer together with the evidence behind it.
   *
   * One retrieval produces both the ranking shown and the context the answer was conditioned on, so the
   * two cannot disagree.
   */
  async ask(question: string): Promise<AskResult> {
    const context = await this.#retrieve(question)
    const response = await this.#agent.respond({ text: question }, toAgentContext(context))
    return {
      ...this.#recallView(question, context),
      answer: response.text,
      usedContext: response.usedContext,
    }
  }

  /**
   * What the learner already understands that bears on a question, and why each item was retrieved, without
   * an answer.
   *
   * For a surface whose own agent writes the answer, such as an MCP host. It is the same retrieval `ask`
   * uses, so an agent recalling a question sees exactly the evidence the Learn surface would show for it.
   */
  async recall(question: string, options: RecallOptions = {}): Promise<RecallResult> {
    if (options.scope === undefined)
      return this.#recallView(question, await this.#retrieve(question))
    // A scope is a preference, not a wall: more is retrieved, what lies in the scope rises, and the boost is a
    // reason in the ranking like any other signal, so the order stays checkable (ADR 0015, decision 6).
    const view = this.#recallView(question, await this.#retrieve(question, RECALL_LIMIT * 2))
    const inScope = this.#inScope(options.scope)
    const ranked = view.ranked
      .map((entry) => (inScope.has(entry.nodeId) ? withScopeBoost(entry, options.scope!) : entry))
      .sort((left, right) => right.score - left.score)
      .slice(0, RECALL_LIMIT)
    const kept = new Set(ranked.map((entry) => entry.nodeId))
    const known = view.known
      .filter((entry) => kept.has(entry.nodeId))
      .sort((left, right) => Number(inScope.has(right.nodeId)) - Number(inScope.has(left.nodeId)))
    return { ...view, ranked, known }
  }

  /**
   * Recall in its compact layer (ADR 0015 and #44): one line per item, within a budget of characters, so an agent
   * reads the gist first and asks `expand` for the few it needs. Says how many items the budget left out.
   */
  async recallSummary(question: string, options: RecallOptions = {}): Promise<RecallSummary> {
    const full = await this.recall(question, options)
    const budget = options.budget ?? DEFAULT_RECALL_BUDGET
    const inScope = options.scope === undefined ? new Set<string>() : this.#inScope(options.scope)
    const stateOf = new Map(full.known.map((entry) => [entry.nodeId, entry]))
    const entries: RecallSummaryEntry[] = []
    let used = 0
    for (const item of full.ranked) {
      const known = stateOf.get(item.nodeId)
      const entry: RecallSummaryEntry = {
        nodeId: item.nodeId,
        label: item.label,
        type: item.type,
        score: Math.round(item.score * 1000) / 1000,
        ...(known === undefined
          ? {}
          : { state: known.dimensions.map((d) => `${d.id}=${d.level}`).join(', ') }),
        ...(known !== undefined && known.openConflicts.length > 0 ? { openConflict: true } : {}),
        ...(inScope.has(item.nodeId) ? { inScope: true } : {}),
      }
      const size = JSON.stringify(entry).length
      if (used + size > budget) break
      used += size
      entries.push(entry)
    }
    return {
      question,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
      entries,
      truncated: full.ranked.length - entries.length,
      budget,
    }
  }

  /**
   * One node in full, for an agent that read its line in a summary and needs the detail: its words, this
   * person's state, its visible neighbours and where it came from. `undefined` for a node they cannot see.
   */
  expand(nodeId: string): ExpandedNode | undefined {
    const node = this.#seen.getNode(nodeId)
    if (node === undefined) return undefined
    const neighbours = this.#seen.edgesOf(node.id).map((edge) => {
      const outgoing = edge.from === node.id
      const other = outgoing ? edge.to : edge.from
      return {
        edgeId: edge.id,
        type: edge.type,
        direction: outgoing ? ('out' as const) : ('in' as const),
        nodeId: other,
        label: this.#seen.getNode(other)?.label ?? other,
      }
    })
    const text = node.properties['text']
    return {
      nodeId: node.id,
      label: node.label,
      type: node.type,
      tier: node.meta.tier ?? 'thought',
      tags: node.tags,
      ...(typeof text === 'string' && text !== node.label ? { text } : {}),
      author: node.actorId,
      ...(node.source === undefined ? {} : { source: node.source }),
      ...(node.properties['origin'] === undefined ? {} : { origin: node.properties['origin'] }),
      understanding: this.understandingOf(node.id),
      neighbours,
      publications: this.publications()
        .filter((publication) => publication.members.includes(node.id))
        .map((publication) => publication.id),
    }
  }

  /** The ids of the nodes this person can see that carry `scope:<scope>`. */
  #inScope(scope: string): ReadonlySet<string> {
    const tag = `scope:${scope}`
    return new Set(
      this.#seen
        .listNodes()
        .filter((node) => node.tags.includes(tag))
        .map((node) => node.id),
    )
  }

  #retrieve(question: string, limit = RECALL_LIMIT): Promise<RelevantContext> {
    return retrieveWith(this.#retriever, this.#seen, this.#episteme.log, question, {
      actorId: this.#actor,
      depth: 1,
      limit,
    })
  }

  #recallView(question: string, context: RelevantContext): RecallResult {
    return {
      question,
      retriever: context.retriever,
      // The Chinese display form, decided here so every surface reads the same and no view invents its own
      // wording for "nothing recorded". `contextSummary` is the English one, used by the English demos.
      summary: context.summary === '' ? '关于这个，你还没有记录过任何东西' : context.summary,
      known: context.known.map((entry) => ({
        nodeId: entry.nodeId,
        label: entry.label,
        settled: entry.settled,
        openConflicts: entry.openConflicts,
        dimensions: Object.entries(entry.state)
          .map(([id, value]: [string, StateValue]) => ({
            id,
            level: value.level ?? String(value.scalar ?? '?'),
          }))
          .sort((left, right) => (left.id < right.id ? -1 : 1)),
      })),
      ranked: toRankedView(context),
      rules: this.rules,
    }
  }

  /**
   * Records what the learner now understands about a node.
   *
   * Authored by the human, always: there is no parameter for an actor, because a surface that let a
   * caller pass one would be one refactor away from letting the agent write the learner's understanding.
   * The commit is validated by Core's guards like any other.
   */
  async record(
    target: NodeId | string,
    dimensions: Readonly<Record<string, string>>,
    options: {
      readonly reason?: string
      /** Where the statement came from. Adopting names the publication (ADR 0014, decision 4). */
      readonly source?: string
    } = {},
  ): Promise<{
    readonly eventId: string
    readonly recorded: readonly { id: string; level: string }[]
  }> {
    const entries = Object.entries(dimensions).filter(([, level]) => level !== '')
    if (entries.length === 0) {
      throw new SessionRefusal('missing_dimension', 'record needs at least one dimension')
    }

    for (const [dimension, level] of entries) {
      const known = this.#scene.recordableDimensions.find((candidate) => candidate.id === dimension)
      if (known === undefined) {
        throw new SessionRefusal(
          'not_recordable',
          `"${dimension}" is not recordable from this surface. Available: ${this.#scene.recordableDimensions.map((d) => d.id).join(', ')}`,
        )
      }
      const refusal = levelRefusal(known, level)
      if (refusal !== undefined) throw new SessionRefusal(refusal.code, refusal.message)
    }

    return this.#exclusive(async () => {
      const event = this.#episteme.log.commit({
        target: asId<NodeId>(target),
        actorId: this.#actor,
        dimensions: new Map(
          entries.map(([dimension, level]): [DimensionId, StateValue] => [
            asId<DimensionId>(dimension),
            { level },
          ]),
        ),
        ...(options.reason === undefined ? {} : { reason: options.reason }),
        source: options.source ?? 'learn-surface',
      })
      await this.#persist()
      return {
        eventId: event.id,
        recorded: entries.map(([id, level]) => ({ id, level })),
      }
    })
  }

  /**
   * Adds a claim or concept the learner is working with, so the graph is theirs rather than a fixture.
   *
   * Only the kinds a learner actually writes are accepted here. Anything else — evidence, synthesis, raw
   * notes — has its own lifecycle, and a surface that let a learner create all nine node types from one
   * text box would be teaching them the ontology instead of the subject.
   */
  async addNode(input: {
    readonly label: string
    readonly kind: 'claim' | 'concept' | 'question'
    readonly topic?: string
    readonly source?: string
    /** The learning project or course the node belongs to (ADR 0015, decision 6). */
    readonly scope?: string
    /** Supplied when the caller needs a stable id, such as a topic seeder that must be idempotent. */
    readonly id?: string
    /**
     * Material the person was given, such as a course's topic, rather than their own thinking. Seeded at
     * `reference` tier whatever its kind, so a given claim or question never counts as their understanding.
     */
    readonly given?: boolean
  }): Promise<NodeView> {
    return this.#exclusive(async () => {
      // The id is chosen inside the queue, so two concurrent additions cannot both pick the same next id.
      const node = this.#addNodeNow({
        id: input.id ?? this.#nextId(input.kind),
        label: input.label,
        type:
          input.kind === 'claim'
            ? NODE.claim
            : input.kind === 'concept'
              ? NODE.concept
              : NODE.question,
        // A concept the learner introduces is reference material; a claim is their own thinking. The tier
        // decides whether it counts as understanding, so it is not a cosmetic field.
        tier: input.kind === 'concept' || input.given === true ? 'reference' : 'thought',
        ...(input.topic === undefined ? {} : { topic: input.topic }),
        ...(input.source === undefined ? {} : { source: input.source }),
        ...(input.scope === undefined ? {} : { scope: input.scope }),
      })
      await this.#persist()
      return node
    })
  }

  /**
   * A short id derived from the kind of node and how many of that kind already exist.
   *
   * Short because these ids are typed by hand: the surface asks a learner to name a node when recording
   * their understanding, and the first version used a slug of the label, which produced
   * `node_0_self_attention_cannot_tell_which_word_ca` — truncated mid-word and impractical to type. A
   * learner's own vocabulary should not be turned into an identifier they cannot say.
   */
  #nextId(kind: string): string {
    const prefix = `${kind}_`
    let highest = 0
    for (const node of this.#episteme.graph.listNodes()) {
      if (!node.id.startsWith(prefix)) continue
      const suffix = Number.parseInt(node.id.slice(prefix.length), 10)
      if (Number.isFinite(suffix) && suffix > highest) highest = suffix
    }
    // `listNodes` leaves out revoked nodes, but their ids are still taken. So is an id planned for a decision
    // that has not been settled: if it landed after all, the node it names is that decision's.
    const planned = new Set(
      this.#suggestions.resolutions().map((resolution) => resolution.planned.nodeId),
    )
    let next = highest + 1
    while (
      this.#episteme.graph.getNode(asId<NodeId>(`${prefix}${next}`)) !== undefined ||
      planned.has(`${prefix}${next}`)
    )
      next += 1
    return `${prefix}${next}`
  }

  /**
   * Resolves a node the learner referred to by id or by an unambiguous prefix.
   *
   * Returns every match rather than guessing, so an ambiguous prefix produces a message naming the
   * candidates instead of silently recording understanding against the wrong node — which would be a
   * permanent, validated, wrong fact in their history.
   */
  resolveNodes(reference: string): readonly NodeView[] {
    const nodes = this.listNodes()
    const exact = nodes.find((node) => node.nodeId === reference)
    if (exact !== undefined) return [exact]
    return nodes.filter((node) => node.nodeId.startsWith(reference))
  }

  /**
   * Runs several additions as one mutation and one write, such as seeding a topic.
   *
   * `work` runs inside the mutation queue, so whatever it reads before it writes (for example, whether a
   * topic is already there) cannot change underneath it. It is synchronous on purpose: nothing else can run
   * in the middle of it, and the batch is written once when it returns.
   */
  batch<T>(work: (writer: SessionWriter) => T): Promise<T> {
    return this.#exclusive(async () => {
      const result = work({
        addNode: (input) => this.#addNodeNow(input),
        link: (from, to, type, id) => this.#linkNow(from, to, type, id),
      })
      await this.#persist()
      return result
    })
  }

  /** Adds one node. Only ever called inside the mutation queue. */
  #addNodeNow(input: NodeInput): NodeView {
    const label = input.label.trim()
    if (label === '') throw new SessionRefusal('missing_property', 'a node needs a label')

    const node = this.#episteme.graph.addNode({
      id: asId<NodeId>(input.id),
      type: input.type,
      label,
      properties: { text: label, ...input.properties },
      tags: defaultTags(input.topic ?? 'general', input.scope),
      tier: input.tier,
      actorId: this.#actor,
      ...(input.source === undefined ? {} : { source: input.source }),
    })

    return this.#view(node)
  }

  /** Links two nodes, so a claim can be anchored and graph proximity has something to work with. */
  async link(
    from: string,
    to: string,
    type = EDGE.refersTo,
    id?: string,
  ): Promise<{ readonly edgeId: string }> {
    return this.#exclusive(async () => {
      const edge = this.#linkNow(from, to, type, id)
      await this.#persist()
      return edge
    })
  }

  /** Adds one edge. Only ever called inside the mutation queue. */
  #linkNow(
    from: string,
    to: string,
    type: Parameters<Episteme['graph']['addEdge']>[0]['type'] = EDGE.refersTo,
    id?: string,
    source?: string,
  ): { readonly edgeId: string } {
    const edge = this.#episteme.graph.addEdge({
      id: asId<EdgeId>(id ?? newEdgeId()),
      type,
      from: asId<NodeId>(from),
      to: asId<NodeId>(to),
      actorId: this.#actor,
      ...(source === undefined ? {} : { source }),
    })
    return { edgeId: edge.id }
  }

  /** Every dimension the graph's registries hold, with its levels and which of them are legacy. */
  vocabulary(): readonly VocabularyDimension[] {
    return this.#episteme.registries.stateDimensions.list().map((definition) => {
      const legacy = definition.legacyLevels ?? []
      return {
        id: definition.id,
        label: definition.label,
        kind: definition.kind,
        recordable: this.#scene.recordableDimensions.some(
          (dimension) => dimension.id === definition.id,
        ),
        levels: (definition.levels ?? []).map((level) => ({
          id: level,
          legacy: legacy.includes(level),
        })),
      }
    })
  }

  /** Every node the learner can see, for an overview of their own graph. */
  listNodes(): readonly NodeView[] {
    return this.#seen.listNodes().map((node) => this.#view(node))
  }

  /** What the human understands about one node, for a detail panel. */
  understandingOf(
    target: NodeId | string,
  ): readonly { readonly id: string; readonly level: string }[] {
    const state = this.#episteme.log.stateOf(asId<NodeId>(target), this.#actor)
    return [...state]
      .map(([id, value]) => ({ id, level: value.level ?? String(value.scalar ?? '?') }))
      .sort((left, right) => (left.id < right.id ? -1 : 1))
  }

  /**
   * Every recorded change of the learner's understanding of one node, in the persisted form, or `undefined`
   * when there is no such node. The data an understanding timeline is drawn from.
   */
  historyOf(target: NodeId | string): readonly SerializedStateEvent[] | undefined {
    const id = asId<NodeId>(target)
    if (this.#seen.getNode(id) === undefined) return undefined
    return this.#episteme.log.history({ target: id, actorId: this.#actor }).map(toSerializedEvent)
  }

  /** The open ends of this learner's lines of inquiry, so a surface can show where they left off. */
  openEnds(): readonly {
    readonly eventId: string
    readonly target: string
    readonly label: string
  }[] {
    return this.#episteme.log.tips(this.#actor).map((event) => ({
      eventId: event.id,
      target: event.target,
      label: this.#seen.getNode(event.target)?.label ?? event.target,
    }))
  }

  /**
   * What the learner has actually understood so far, and what deserves attention next.
   *
   * This answers the question a learner has after using the loop a few times — *what did I get out of this?* —
   * which nothing else on the surface does. Retrieval answers "what is relevant to this question"; the graph
   * listing answers "what exists". Neither says whether the session changed anything.
   *
   * Reuses the same reading of state that ranking uses (`SETTLED_DIMENSIONS`, open conflicts) rather than
   * inventing a second definition of "understood". A second definition would drift from the one the cognitive
   * relevance signal is built on, and the two would disagree about the same learner.
   */
  progress(): ProgressSummary {
    const items: ProgressItem[] = []

    for (const node of this.listNodes()) {
      const state = this.#episteme.log.stateOf(asId<NodeId>(node.nodeId), this.#actor)
      if (state.size === 0) continue // Untouched reference material is not progress.

      const dimensions = [...state]
        .map(([id, value]) => ({ id, level: value.level ?? String(value.scalar ?? '?') }))
        .sort((left, right) => (left.id < right.id ? -1 : 1))
      const levelOf = (id: string): string | undefined =>
        dimensions.find((entry) => entry.id === id)?.level

      const openConflicts = dimensions
        .filter((entry) => entry.id === DIMENSION.conflict && entry.level !== 'none')
        .map((entry) => entry.level)

      // Same predicate as `retrieveWith`: a dimension in its settled band makes the item buildable.
      const settled =
        (['medium', 'high'] as const).includes(
          levelOf(DIMENSION.confidence) as 'medium' | 'high',
        ) &&
        (['medium', 'high'] as const).includes(levelOf(DIMENSION.articulation) as 'medium' | 'high')

      items.push({
        nodeId: node.nodeId,
        label: node.label,
        type: node.type,
        dimensions,
        settled,
        openConflicts,
        attention: attentionFor(dimensions, settled, openConflicts),
      })
    }

    // Most in need of attention first, so the panel opens on something worth doing rather than on whatever
    // happened to be recorded first. `shaky` precedes `unexplained`: an item with no ground under it is the
    // more urgent of the two, since there is nothing to build on at all.
    const order = { conflict: 0, shaky: 1, unexplained: 2, settled: 3 } as const
    items.sort((left, right) => {
      if (order[left.attention] !== order[right.attention]) {
        return order[left.attention] - order[right.attention]
      }
      return left.label < right.label ? -1 : 1
    })

    const settledCount = items.filter((item) => item.settled).length
    return {
      touched: items.length,
      settled: settledCount,
      withOpenConflict: items.filter((item) => item.openConflicts.length > 0).length,
      totalNodes: this.listNodes().length,
      items,
      summary: progressLine(items.length, settledCount),
    }
  }

  /** Writes the history through the store, if there is one, after every mutation already queued. */
  flush(): Promise<void> {
    return this.#exclusive(() => this.#persist())
  }

  /**
   * Runs one mutation of this session's graph, history or drafts, after every mutation queued before it.
   *
   * Every method that changes state goes through here, and nothing it runs calls another public mutating
   * method, which would wait on itself. Reads are not queued: they see the state as it stands between
   * mutations. Without this, a mutation that awaits a write lets a second one start on the same state; two
   * decisions on one draft could then both commit.
   *
   * A failed mutation rejects for its caller only. The queue carries on with the next one.
   */
  #exclusive<T>(work: () => Promise<T> | T): Promise<T> {
    const run = this.#shared.mutations.then(async () => {
      if (this.#shared.closed)
        throw new Error('this session is closed; open a new one to change the graph')
      this.#shared.revision += 1
      try {
        return await work()
      } finally {
        this.#shared.revision += 1
      }
    })
    this.#shared.mutations = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Keeps an agent's proposal as a pending draft, for a human to decide later.
   *
   * Nothing here changes the graph or the history. What can be checked now is checked now, so an agent learns
   * at once that a proposal could never be accepted, rather than leaving the learner a draft that fails when
   * they try to take it: the nodes it names must exist, a claim and a link must pass the graph's own preview,
   * and a state change must use a dimension and level the learner could record themselves. A refusal is
   * returned as a value, as `previewNode` does, because proposing something unacceptable is an ordinary
   * outcome.
   *
   * `proposedBy` must be an agent. The human does not propose to themselves; they record.
   */
  async propose(
    proposal: Proposal,
    from: { readonly proposedBy: string; readonly rationale: string; readonly scope?: string },
  ): Promise<ProposeResult> {
    return this.#exclusive(async (): Promise<ProposeResult> => {
      // Checked inside the queue, against the graph as it is when the draft is kept.
      const refusal = this.#refusalOf(proposal, from)
      if (refusal !== undefined) return { ok: false, refusal }

      const suggestion = await this.#suggestions.add({
        owner: this.#actor,
        ...(from.scope === undefined ? {} : { scope: from.scope }),
        proposal: normalized(proposal),
        rationale: from.rationale.trim(),
        proposedBy: from.proposedBy,
        proposedAt: systemClock.now(),
      })
      const delegated = await this.#decideUnderDelegation(suggestion)
      return { ok: true, suggestion, ...(delegated === undefined ? {} : { delegated }) }
    })
  }

  /**
   * What publishing `request` would make public, or why it cannot be published (ADR 0014). Changes nothing.
   *
   * The same validation as `publish`, so what a person confirms is what is written. Everything not listed stays
   * private: their state, their other nodes, their drafts and sources.
   */
  previewPublication(request: PublicationRequest): PublicationPreview {
    const refusal = this.#sharingRefusal() ?? this.#threadRefusal(request)
    if (refusal !== undefined) return { ok: false, refusal }
    return this.#episteme.log.previewPublication(this.#publicationDraft(request))
  }

  /**
   * The preview a person confirms before publishing (ADR 0014, story step 1): what becomes public, and what stays
   * private, including the turns of a listed thread that are not summarized and so are left out.
   */
  publicationPlan(request: PublicationRequest): PublicationPlan {
    const preview = this.previewPublication(request)
    if (!preview.ok) return preview
    const members = new Set<string>(preview.publication.members)
    return {
      ok: true,
      publication: preview.publication,
      public: {
        nodes: preview.publication.members.map((id) => this.#publicNode(id)),
        threads: (preview.publication.threads ?? []).map((id) => this.#publishedThread(id)),
      },
      private: {
        otherNodes: this.#seen
          .listNodes()
          .filter((node) => node.actorId === this.#actor && !members.has(node.id)).length,
        state: 'none of your recorded understanding is published',
        drafts: this.#ownSuggestions().length,
        sources: this.sources().length,
        unsummarizedTurns: (preview.publication.threads ?? []).flatMap((id) =>
          this.#parts.threads
            .turnsOf(id)
            .filter((turn) => this.#parts.threads.summaryOf(turn.id) === undefined)
            .map((turn) => turn.id),
        ),
        reminder: 'check the summaries for anything personal before publishing; Episteme does not',
      },
    }
  }

  /**
   * Publishes part of this person's understanding: the root and what it reaches through their own relations.
   *
   * Only ever a person's own act: the session's person is the author, and Core refuses an agent. Before the
   * graph's first publication, the graph file is copied aside, because no earlier build can open it after.
   */
  publish(request: PublicationRequest): Promise<PublicationPreview> {
    return this.#exclusive(async () => {
      const refusal = this.#sharingRefusal() ?? this.#threadRefusal(request)
      if (refusal !== undefined) return { ok: false, refusal }
      const draft = this.#publicationDraft(request)
      const preview = this.#episteme.log.previewPublication(draft)
      if (!preview.ok) return preview
      await this.#backUpBeforeFirstPublication()
      const published = this.#episteme.log.publish(draft)
      if (published.ok) await this.#persist()
      return published
    })
  }

  /** Withdraws one of this person's live publications. What others adopted from it stays in their history. */
  withdrawPublication(
    id: string,
    reason?: string,
  ): Promise<
    | { readonly ok: true; readonly withdrawal: Withdrawal }
    | { readonly ok: false; readonly refusal: MutationRefusal }
  > {
    return this.#exclusive(async () => {
      const result = this.#episteme.log.withdrawPublication(id, this.#actor, reason)
      if (result.ok) await this.#persist()
      return result
    })
  }

  /** Every live publication, anyone's, oldest first. What browsing reads. */
  publications(): readonly Publication[] {
    return this.#episteme.log.publications.live()
  }

  /** Live publications to browse (ADR 0014, story step 2), newest first. */
  browsePublications(
    query: { readonly author?: string; readonly scope?: string; readonly q?: string } = {},
  ): readonly PublicationSummary[] {
    const text = query.q?.trim().toLowerCase()
    return this.publications()
      .filter((publication) => query.author === undefined || publication.actorId === query.author)
      .map((publication) => ({ publication, root: this.#episteme.graph.getNode(publication.root) }))
      .filter(
        ({ root }) =>
          query.scope === undefined || root?.tags.includes(`scope:${query.scope}`) === true,
      )
      .filter(
        ({ publication, root }) =>
          text === undefined ||
          text === '' ||
          (root?.label.toLowerCase().includes(text) ?? false) ||
          publication.members.some((id) =>
            this.#episteme.graph.getNode(id)?.label.toLowerCase().includes(text),
          ),
      )
      .map(({ publication, root }) => ({
        id: publication.id,
        author: publication.actorId,
        createdAt: publication.createdAt,
        rootLabel: root?.label ?? publication.root,
        members: publication.members.length,
        version: this.#versionsOf(publication.id).findIndex((id) => id === publication.id) + 1,
        ...(publication.note === undefined ? {} : { note: publication.note }),
      }))
      .reverse()
  }

  /**
   * One publication as anyone may read it (ADR 0014, story step 2): its members as a structure, with where each
   * came from, the relations between them, the author, the version chain both ways, and its threads' summaries.
   */
  publicationView(id: string): PublicationView | undefined {
    const publication = this.#episteme.log.publications.get(id)
    if (publication === undefined) return undefined
    const withdrawal = this.#episteme.log.publications.withdrawalOf(id)
    // Withdrawing stops reading it (ADR 0014); only its author still sees what it held.
    if (withdrawal !== undefined && publication.actorId !== this.#actor) return undefined
    return {
      publication,
      live: withdrawal === undefined,
      ...(withdrawal === undefined ? {} : { withdrawnAt: withdrawal.withdrawnAt }),
      nodes: publication.members.map((member) => this.#publicNode(member)),
      edges: publication.edges
        .map((edgeId) => this.#episteme.graph.getEdge(edgeId))
        .filter((edge) => edge !== undefined)
        .map((edge) => ({ id: edge.id, type: edge.type, from: edge.from, to: edge.to })),
      threads: (publication.threads ?? []).map((thread) => this.#publishedThread(thread)),
      versions: this.#versionsOf(publication.id),
    }
  }

  /**
   * Adopts a member of someone else's publication as this person's own understanding, at their own levels
   * (ADR 0014, decision 4): one state event of theirs on the author's node, naming the publication. No copy.
   */
  async adopt(
    publicationId: string,
    nodeId: string,
    dimensions: Readonly<Record<string, string>>,
    options: { readonly reason?: string } = {},
  ): Promise<{
    readonly eventId: string
    readonly recorded: readonly { id: string; level: string }[]
  }> {
    const publication = this.#episteme.log.publications.get(publicationId)
    if (publication === undefined || !this.#episteme.log.publications.isLive(publicationId)) {
      throw new SessionRefusal('not_live', `"${publicationId}" is not a live publication`)
    }
    if (publication.actorId === this.#actor) {
      throw new SessionRefusal(
        'own_publication',
        'this is your own publication; record your understanding directly',
      )
    }
    if (!publication.members.includes(nodeId as NodeId)) {
      throw new SessionRefusal('not_a_member', `"${nodeId}" is not part of "${publicationId}"`)
    }
    return this.record(nodeId, dimensions, {
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      source: `publication:${publicationId}`,
    })
  }

  /**
   * Publications this person adopted from that have a newer live version (ADR 0014, story step 5), with what
   * changed between the two. Nothing changes for them until they decide.
   */
  updates(): readonly PublicationUpdate[] {
    const adopted = new Set<string>()
    for (const node of this.#seen.listNodes()) {
      for (const event of this.#episteme.log.history({ target: node.id, actorId: this.#actor })) {
        if (event.source?.startsWith('publication:') === true) {
          adopted.add(event.source.slice('publication:'.length))
        }
      }
    }
    const updates: PublicationUpdate[] = []
    for (const id of adopted) {
      const versions = this.#versionsOf(id)
      const newest = versions[versions.length - 1]
      if (newest === undefined || newest === id || !this.#episteme.log.publications.isLive(newest))
        continue
      const before = new Set<string>(this.#episteme.log.publications.get(id)?.members ?? [])
      const after = new Set<string>(this.#episteme.log.publications.get(newest)?.members ?? [])
      updates.push({
        adopted: id,
        newer: newest,
        added: [...after].filter((member) => !before.has(member)),
        removed: [...before].filter((member) => !after.has(member)),
      })
    }
    return updates
  }

  /** A publication's version chain, oldest first: what it supersedes, back to the first, then what supersedes it. */
  #versionsOf(id: string): readonly string[] {
    const all = this.#episteme.log.publications.all()
    const earlier: string[] = []
    for (let at = this.#episteme.log.publications.get(id); at?.supersedes !== undefined; ) {
      earlier.unshift(at.supersedes)
      at = this.#episteme.log.publications.get(at.supersedes)
    }
    const later: string[] = []
    for (let at = id; ; ) {
      const next = all.find((publication) => publication.supersedes === at)
      if (next === undefined) break
      later.push(next.id)
      at = next.id
    }
    return [...earlier, id, ...later]
  }

  /** A published node as anyone may read it: no one's state, only what the node itself carries. */
  #publicNode(id: string): PublicNode {
    const node = this.#episteme.graph.getNode(id)
    const source = node?.source ?? ''
    return {
      nodeId: id,
      label: node?.label ?? id,
      type: node?.type ?? 'unknown',
      author: node?.actorId ?? 'unknown',
      ...(node?.source === undefined ? {} : { source: node.source }),
      ...(typeof node?.properties['origin'] === 'object'
        ? { origin: node.properties['origin'] }
        : {}),
      // How the author came to hold it: by their own decision, or under a delegation (ADR 0016, decision 5).
      confirmation: source.includes('via delegation') ? 'delegation' : 'person',
    }
  }

  /** A thread as a publication shows it: its turns' current summaries, never their raw words. */
  #publishedThread(id: string): PublishedThread {
    const thread = this.#parts.threads.thread(id)
    return {
      id,
      title: thread?.title ?? id,
      turns: this.#parts.threads
        .turnsOf(id)
        .map((turn) => ({ turn, summary: this.#parts.threads.summaryOf(turn.id) }))
        .filter((entry) => entry.summary !== undefined)
        .map(({ turn, summary }) => ({
          turn: turn.id,
          seq: turn.seq,
          speaker: turn.speaker,
          summary: summary?.text ?? '',
        })),
    }
  }

  #threadRefusal(request: PublicationRequest): MutationRefusal | undefined {
    for (const id of request.threads ?? []) {
      if (this.#parts.threads.thread(id)?.owner !== this.#actor) {
        return { code: 'not_publishable', message: `"${id}" is not a thread of yours` }
      }
    }
    return undefined
  }

  #publicationDraft(request: PublicationRequest): PublicationDraft {
    return {
      id: `pub_${randomUUID()}`,
      actorId: this.#actor,
      root: request.root,
      ...(request.include === undefined ? {} : { include: request.include }),
      ...(request.supersedes === undefined ? {} : { supersedes: request.supersedes }),
      ...(request.note === undefined ? {} : { note: request.note }),
      ...(request.threads === undefined ? {} : { threads: [...new Set(request.threads)] }),
    }
  }

  #sharingRefusal(): MutationRefusal | undefined {
    if (this.#parts.sharing) return undefined
    return {
      code: 'sharing_disabled',
      message: 'this graph does not allow publishing; start the service with sharing enabled',
    }
  }

  /** Copies the graph file aside once, before the first publication is written into it. */
  async #backUpBeforeFirstPublication(): Promise<void> {
    const file = this.#parts.filePath
    if (file === undefined || this.#episteme.log.publications.all().length > 0) return
    const backup = `${file}.before-sharing`
    const exists = await access(backup).then(
      () => true,
      () => false,
    )
    if (!exists) await copyFile(file, backup)
  }

  /** Opens a conversation thread for this person (ADR 0015). */
  openThread(input: {
    readonly title: string
    readonly scope?: string
    readonly hostSession?: string
  }): Promise<Thread> {
    return this.#exclusive(async () => {
      const title = input.title.trim()
      if (title === '') throw new SessionRefusal('missing_property', 'a thread needs a title')
      const thread: Thread = {
        id: `thr_${randomUUID()}`,
        owner: this.#actor,
        title,
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(input.hostSession === undefined ? {} : { hostSession: input.hostSession }),
        createdAt: systemClock.now(),
      }
      await this.#parts.threads.addThread(thread)
      return thread
    })
  }

  /** Records one turn of a thread of this person's, raw. */
  appendTurn(
    threadId: string,
    input: { readonly speaker: 'learner' | 'agent'; readonly text: string; readonly by?: string },
  ): Promise<Turn> {
    return this.#exclusive(async () => {
      this.#ownThread(threadId)
      const text = canonicalText(input.text)
      if (text.trim() === '') throw new SessionRefusal('missing_property', 'a turn needs words')
      const turn: Turn = {
        id: `turn_${randomUUID()}`,
        thread: threadId,
        seq: this.#parts.threads.ownTurns(threadId).length + 1,
        speaker: input.speaker,
        text,
        by: input.by ?? this.#actor,
        at: systemClock.now(),
      }
      await this.#parts.threads.addTurn(turn)
      return turn
    })
  }

  /**
   * Keeps a host's summary of a turn (ADR 0015, decision 2).
   *
   * A learner's turn needs at least one quote of their own words, each found verbatim in the turn, so the summary
   * is tied to what they wrote. A newer summary replaces the current one; the earlier ones stay.
   */
  summarizeTurn(
    threadId: string,
    turnId: string,
    input: { readonly text: string; readonly quotes?: readonly string[]; readonly by?: string },
  ): Promise<TurnSummary> {
    return this.#exclusive(async () => {
      this.#ownThread(threadId)
      const turn = this.#parts.threads
        .turnsOf(threadId)
        .find((candidate) => candidate.id === turnId)
      if (turn === undefined) {
        throw new SessionRefusal('unknown_turn', `"${turnId}" is not a turn of "${threadId}"`)
      }
      const text = input.text.trim()
      if (text === '') throw new SessionRefusal('missing_property', 'a summary needs words')
      const quotes = (input.quotes ?? []).map((quote) => canonicalText(quote))
      if (turn.speaker === 'learner' && quotes.length === 0) {
        throw new SessionRefusal(
          'missing_quote',
          'a summary of the learner’s turn must quote at least some of their own words',
        )
      }
      for (const quote of quotes) {
        if (quoteSigns(quote) < MIN_QUOTE_SIGNS) {
          throw new SessionRefusal(
            'quote_too_short',
            `a quote needs at least ${MIN_QUOTE_SIGNS} letters or digits to rest on`,
          )
        }
        if (occurrencesOf(turn.text, quote).length === 0) {
          throw new SessionRefusal('quote_not_found', `"${quote}" is not in the turn`)
        }
      }
      const summary: TurnSummary = {
        turn: turn.id,
        text,
        quotes,
        by: input.by ?? this.#actor,
        at: systemClock.now(),
      }
      await this.#parts.threads.addSummary(summary)
      return summary
    })
  }

  /** Opens a new line from a turn of a thread of this person's (ADR 0015, decision 3). */
  forkThread(threadId: string, turnId: string, title?: string): Promise<Thread> {
    return this.#exclusive(async () => {
      const parent = this.#ownThread(threadId)
      if (!this.#parts.threads.turnsOf(threadId).some((turn) => turn.id === turnId)) {
        throw new SessionRefusal('unknown_turn', `"${turnId}" is not a turn of "${threadId}"`)
      }
      const thread: Thread = {
        id: `thr_${randomUUID()}`,
        owner: this.#actor,
        title: title?.trim() || parent.title,
        ...(parent.scope === undefined ? {} : { scope: parent.scope }),
        parent: { thread: threadId, turn: turnId },
        createdAt: systemClock.now(),
      }
      await this.#parts.threads.addThread(thread)
      return thread
    })
  }

  /** This person's threads, newest first. */
  threads(scope?: string): readonly Thread[] {
    return this.#parts.threads.threadsOf(this.#actor, scope)
  }

  /** A thread of this person's as it reads: its turns, raw, each with its current summary. */
  threadView(threadId: string): ThreadView | undefined {
    const thread = this.#parts.threads.thread(threadId)
    if (thread === undefined || thread.owner !== this.#actor) return undefined
    return {
      thread,
      turns: this.#parts.threads.turnsOf(threadId).map((turn) => {
        const summary = this.#parts.threads.summaryOf(turn.id)
        return { ...turn, ...(summary === undefined ? {} : { summary }) }
      }),
    }
  }

  /**
   * Distills turns of a thread of this person's (ADR 0015, decision 5): the turns become a dialogue, kept as a
   * source that names the thread, and every candidate's origin names the turn its words are in.
   */
  distillThread(
    threadId: string,
    options: { readonly turns?: readonly string[]; readonly requestedBy?: string } = {},
  ): Promise<DistillOutcome> {
    const view = this.threadView(threadId)
    if (view === undefined) {
      return Promise.resolve({
        ok: false,
        refusal: { code: 'unknown_thread', message: `there is no thread "${threadId}" of yours` },
      })
    }
    const chosen = view.turns.filter(
      (turn) => options.turns === undefined || options.turns.includes(turn.id),
    )
    let text = ''
    const ranges: { id: string; start: number; end: number }[] = []
    for (const turn of chosen) {
      const line = `${turn.speaker === 'learner' ? LEARNER_LABEL : AGENT_LABEL}: ${turn.text}`
      const start = text.length
      text += `${line}\n`
      ranges.push({ id: turn.id, start, end: start + line.length })
    }
    return this.distill(
      { title: view.thread.title, text },
      {
        learner: LEARNER_LABEL,
        thread: { id: threadId, turns: ranges },
        ...(options.requestedBy === undefined ? {} : { requestedBy: options.requestedBy }),
      },
    )
  }

  #ownThread(threadId: string): Thread {
    const thread = this.#parts.threads.thread(threadId)
    if (thread === undefined || thread.owner !== this.#actor) {
      throw new SessionRefusal('unknown_thread', `there is no thread "${threadId}" of yours`)
    }
    return thread
  }

  /** The latest version of one of this person's records in a scene's namespace (ADR 0015, decision 7). */
  sceneRecord(namespace: string, key: string): SceneRecord | undefined {
    return this.#parts.records.get(namespace, this.#actor, key)
  }

  /** This person's latest records in a scene's namespace. */
  sceneRecords(namespace: string, prefix = ''): readonly SceneRecord[] {
    return this.#parts.records.list(namespace, this.#actor, prefix)
  }

  /** Writes the next version of one of this person's records. `null` removes it, keeping its history. */
  putSceneRecord(
    namespace: string,
    key: string,
    value: unknown,
    by?: string,
  ): Promise<SceneRecord> {
    return this.#exclusive(async () => {
      if (namespace.trim() === '' || key.trim() === '') {
        throw new SessionRefusal('missing_property', 'a scene record needs a namespace and a key')
      }
      const size = Buffer.byteLength(JSON.stringify(value ?? null), 'utf8')
      if (size > MAX_SCENE_RECORD_BYTES) {
        throw new SessionRefusal(
          'value_too_large',
          `a scene record holds at most ${MAX_SCENE_RECORD_BYTES} bytes; this one is ${size}`,
        )
      }
      return this.#parts.records.put({
        namespace,
        owner: this.#actor,
        key,
        value: value ?? null,
        by: by ?? this.#actor,
        at: systemClock.now(),
      })
    })
  }

  /**
   * Grants a delegation (ADR 0016): from now on, agent proposals for this person in `scope` are confirmed for
   * them by the service, through the same decision path, and recorded as delegated. Only the person grants it;
   * the service's routes keep agent credentials out.
   */
  grantDelegation(scope = '*'): Promise<Delegation> {
    return this.#exclusive(async () => {
      const delegation: Delegation = {
        id: `del_${randomUUID()}`,
        owner: this.#actor,
        scope: scope.trim() === '' ? '*' : scope.trim(),
        grantedAt: systemClock.now(),
      }
      await this.#suggestions.putDelegation(delegation)
      return delegation
    })
  }

  /** Stops a delegation from the next proposal on. What it already decided stays until undone. */
  revokeDelegation(id: string): Promise<Delegation> {
    return this.#exclusive(async () => {
      const delegation = this.delegations().find((candidate) => candidate.id === id)
      if (delegation === undefined) {
        throw new SessionRefusal('unknown_delegation', `there is no delegation "${id}" of yours`)
      }
      if (delegation.revokedAt !== undefined) return delegation
      const revoked = { ...delegation, revokedAt: systemClock.now() }
      await this.#suggestions.putDelegation(revoked)
      return revoked
    })
  }

  /** This person's delegations, live and revoked. */
  delegations(): readonly Delegation[] {
    return this.#suggestions.delegations().filter((delegation) => delegation.owner === this.#actor)
  }

  /**
   * Revokes what a delegated decision committed (ADR 0016, decision 4): its state event, node or edge. Nothing is
   * erased; the history keeps both, and a review records the undoing.
   */
  undoDelegated(suggestionId: string): Promise<{ readonly revoked: readonly string[] }> {
    return this.#exclusive(async () => {
      const review = this.reviews().find(
        (candidate) =>
          candidate.suggestionId === suggestionId &&
          candidate.channel === 'delegation' &&
          candidate.outcome === 'accepted',
      )
      if (review === undefined) {
        throw new SessionRefusal(
          'not_delegated',
          `"${suggestionId}" was not decided for you under a delegation`,
        )
      }
      if (this.reviews().some((r) => r.suggestionId === suggestionId && r.outcome === 'undone')) {
        return { revoked: [] }
      }
      const revoked: string[] = []
      const named = `suggestion ${suggestionId} from `
      for (const node of this.#seen.listNodes()) {
        for (const event of this.#episteme.log.history({ target: node.id, actorId: this.#actor })) {
          if ([...event.dimensions.values()].some((value) => value.sourceOf === suggestionId)) {
            this.#episteme.log.revokeStateEvent(event.id, { reason: 'undone delegated decision' })
            revoked.push(event.id)
          }
        }
        if (node.actorId === this.#actor && node.properties['suggestion'] === suggestionId) {
          this.#episteme.graph.revokeNode(node.id)
          revoked.push(node.id)
        }
      }
      for (const edge of this.#seen.listEdges()) {
        if (edge.source?.includes(named) === true) {
          this.#episteme.graph.revokeEdge(edge.id)
          revoked.push(edge.id)
        }
      }
      await this.#persist()
      await this.#suggestions.addReview({
        owner: this.#actor,
        suggestionId,
        outcome: 'undone',
        channel: 'learn-review',
        reviewer: { actorId: this.#actor },
        decidedAt: systemClock.now(),
      })
      return { revoked }
    })
  }

  /**
   * Decides a fresh draft under a live delegation of its owner's, when one covers it (ADR 0016, decisions 2–3).
   * Only ever called inside the mutation queue, right after the draft is kept.
   */
  async #decideUnderDelegation(suggestion: Suggestion): Promise<DecisionResult | undefined> {
    const proposal = suggestion.proposal
    // Never a conflict: delegation does not let a model pick a side.
    if (proposal.kind === 'state' && proposal.dimension === 'conflict') return undefined
    const delegation = this.delegations().find(
      (candidate) =>
        candidate.revokedAt === undefined &&
        (candidate.scope === '*' || candidate.scope === suggestion.scope),
    )
    if (delegation === undefined) return undefined
    return this.#decideNow(suggestion.id, { action: 'accept' }, 'delegation', {
      actorId: this.#actor,
      credentialId: delegation.id,
      label: 'delegation',
    })
  }

  /** Every decision on a suggestion, dismissals included, oldest first (ADR 0012, decision 5). */
  reviews(): readonly Review[] {
    return this.#suggestions.reviews().filter((review) => ownerOf(review) === this.#actor)
  }

  /** The drafts proposed for this person. Another person's drafts are not theirs to see or decide. */
  #ownSuggestions(): readonly Suggestion[] {
    return this.#suggestions.list().filter((suggestion) => ownerOf(suggestion) === this.#actor)
  }

  /** A pending draft of this person's, or `undefined` for one that is not pending or not theirs. */
  #ownSuggestion(id: string): Suggestion | undefined {
    const suggestion = this.#suggestions.get(id)
    return suggestion !== undefined && ownerOf(suggestion) === this.#actor ? suggestion : undefined
  }

  /** Every draft still waiting for the learner, oldest first. */
  pendingSuggestions(): readonly Suggestion[] {
    return this.#ownSuggestions()
  }

  /**
   * Applies the learner's decision on a pending suggestion: the one path from a human decision to the graph
   * (ADR 0008).
   *
   * Every channel (the Learn review queue, MCP elicitation) collects the decision and calls this. None of
   * them commits on its own, so accept, modify and dismiss mean the same thing wherever they were chosen.
   *
   * - **accept** commits the agent's proposed value. A state change is committed as `confirmed`, and
   *   `confirmedBy` is this session's human. There is no parameter for it: the confirming human is the one
   *   whose graph this is, never a value a caller, a client or an agent supplies.
   * - **modify** commits the human's own value instead, of the same kind, checked as the agent's was. The
   *   human wrote it, so it is authored rather than confirmed.
   * - **dismiss** removes the draft and commits nothing. No cognitive event records it, because the graph
   *   never saw the draft.
   *
   * Everything committed goes through the ordinary validated path, and its source names the suggestion, the
   * agent that proposed it and the channel that resolved it. A refusal (an unknown suggestion, a modified
   * value that could never be committed, or a commit the graph rejects) is returned as a value and leaves
   * the draft pending.
   */
  decide(
    suggestionId: string,
    decision: Decision,
    channel: DecisionChannel,
    /** Who decided, as the caller's channel established it; kept in the review record (ADR 0012). */
    reviewer?: Reviewer,
  ): Promise<DecisionResult> {
    // One decision at a time, from reading the draft to removing it: of two decisions on the same draft,
    // whichever is queued first wins, and the second finds it already decided.
    return this.#exclusive(() => this.#decideNow(suggestionId, decision, channel, reviewer))
  }

  async #decideNow(
    suggestionId: string,
    decision: Decision,
    channel: DecisionChannel,
    reviewer: Reviewer | undefined,
  ): Promise<DecisionResult> {
    // A decision on this draft that started before and was never settled (its write failed) is settled first,
    // so deciding again cannot commit a second time.
    const unsettled = this.#suggestions.resolutionOf(suggestionId)
    if (unsettled !== undefined) await this.#settle(unsettled)

    const suggestion = this.#ownSuggestion(suggestionId)
    if (suggestion === undefined) {
      return {
        ok: false,
        refusal: {
          code: 'unknown_suggestion',
          message: `suggestion "${suggestionId}" is not pending; it may already have been decided`,
        },
      }
    }

    // One write of one file, the draft gone and its review kept together: it happened or it did not.
    if (decision.action === 'dismiss') {
      await this.#suggestions.dismiss({
        owner: this.#actor,
        suggestionId: suggestion.id,
        outcome: 'dismissed',
        channel,
        ...(reviewer === undefined ? {} : { reviewer }),
        decidedAt: systemClock.now(),
      })
      return { ok: true, outcome: 'dismissed', suggestion }
    }

    const chosen = normalized(
      decision.action === 'accept' ? suggestion.proposal : decision.proposal,
    )
    if (chosen.kind !== suggestion.proposal.kind) {
      return {
        ok: false,
        refusal: {
          code: 'kind_changed',
          message: `a ${suggestion.proposal.kind} suggestion can only be modified into another ${suggestion.proposal.kind}`,
        },
      }
    }
    // A node suggested alongside it must have been accepted first; it is then named by its id in the graph.
    const resolved = this.#resolveSuggestedNodes(chosen)
    if ('code' in resolved) return { ok: false, refusal: resolved }
    const proposal = resolved
    const refusal = this.#contentRefusalOf(proposal)
    if (refusal !== undefined) return { ok: false, refusal }

    // Recorded before anything is committed, with the ids it will create, so a crash at any point after this
    // leaves enough behind to tell whether the decision landed.
    const operationId = `dec_${randomUUID()}`
    const resolution: Resolution = {
      operationId,
      suggestionId: suggestion.id,
      outcome: decision.action === 'accept' ? 'accepted' : 'modified',
      proposal,
      planned: this.#plan(proposal, operationId),
      channel,
      owner: this.#actor,
      ...(reviewer === undefined ? {} : { reviewer }),
    }
    await this.#suggestions.begin(resolution)

    let committed: Committed | MutationRefusal
    try {
      committed = this.#commitDecided(resolution, suggestion)
    } catch (error) {
      // Only the graph's own refusals become a value. Anything else is a bug: it propagates, and the record
      // stays for the next decision on this draft, or the next start, to settle.
      if (!isEpistemeError(error)) throw error
      committed = { code: error.code, message: error.message }
    }
    if ('code' in committed) {
      // A revoked claim may be pending; it is written like any other change, and the draft stays.
      await this.#persist()
      await this.#suggestions.abandon(operationId)
      return { ok: false, refusal: committed }
    }

    await this.#persist()
    // The draft and the record go together, in one write, once the graph holds the change.
    await this.#suggestions.complete(operationId, systemClock.now())
    return { ok: true, outcome: resolution.outcome, suggestion, committed, operationId }
  }

  /**
   * The ids a decision will create, chosen before it commits.
   *
   * Derived from the operation id, so they are unique and can be looked for in the graph afterwards. A
   * claim's node keeps the short counted id a learner types; it is chosen inside the mutation queue, so
   * nothing else can take it before the decision commits.
   */
  #plan(proposal: Proposal, operationId: string): Resolution['planned'] {
    switch (proposal.kind) {
      case 'state':
        return { edgeIds: [] }
      case 'link':
        return { edgeIds: [`edge_${operationId}_0`] }
      case 'node':
        return { nodeId: this.#nextId(proposal.nodeType), edgeIds: [] }
      case 'claim':
        return {
          nodeId: this.#nextId('claim'),
          edgeIds: (proposal.about ?? []).map((_, index) => `edge_${operationId}_${index}`),
        }
    }
  }

  /**
   * Whether a decision's change is in the graph.
   *
   * A state change is found by the suggestion it names (`sourceOf`), which no other event can name, because a
   * draft is decided at most once. A claim or a link is found by the id planned for it, and only counts while
   * it is not revoked: a claim withdrawn because its links were refused did not land.
   */
  #landed(resolution: Resolution): boolean {
    const { proposal, planned } = resolution
    switch (proposal.kind) {
      case 'state':
        return this.#episteme.log
          .history({ target: asId<NodeId>(proposal.target), actorId: this.#actor })
          .some((event) =>
            [...event.dimensions.values()].some(
              (value) => value.sourceOf === resolution.suggestionId,
            ),
          )
      case 'link': {
        const [edgeId] = planned.edgeIds
        const edge = edgeId === undefined ? undefined : this.#episteme.graph.getEdge(edgeId)
        return edge !== undefined && edge.revoked !== true
      }
      case 'node':
      case 'claim': {
        const node =
          planned.nodeId === undefined ? undefined : this.#episteme.graph.getNode(planned.nodeId)
        return node !== undefined && node.revoked !== true
      }
    }
  }

  /**
   * Settles a decision that started and was not finished: completes it if its change landed, drops its record
   * otherwise. Only ever called inside the mutation queue, or while opening.
   */
  async #settle(resolution: Resolution): Promise<RecoveredDecision> {
    if (this.#landed(resolution)) {
      // If a write failed, the change may so far exist only in memory. It is written before the draft goes.
      await this.#persist()
      await this.#suggestions.complete(resolution.operationId, systemClock.now())
      return { ...identify(resolution), settled: 'completed' }
    }
    await this.#suggestions.abandon(resolution.operationId)
    return { ...identify(resolution), settled: 'rolled_back' }
  }

  /** Decisions found unsettled when this session opened, and how each was settled. */
  get recovered(): readonly RecoveredDecision[] {
    return this.#shared.recovered
  }

  /** Settles every decision a previous session left unfinished. Runs once, before the session is handed out. */
  async #recover(): Promise<void> {
    for (const resolution of this.#suggestions.resolutions()) {
      this.#shared.recovered.push(await this.#settle(resolution))
    }
  }

  /**
   * Commits a decided proposal through the validated graph and log, with the ids planned for it.
   *
   * Throws the graph's own refusals, except one it has to detect itself: an edge of an accepted claim that
   * cannot be added, which it returns after withdrawing the claim.
   */
  #commitDecided(resolution: Resolution, suggestion: Suggestion): Committed | MutationRefusal {
    const { proposal, planned } = resolution
    const confirmed = resolution.outcome === 'accepted'
    // A distilled suggestion's basis goes with it, so an agent's reading is never recorded as the learner's words.
    const source = `suggestion ${suggestion.id} from ${suggestion.proposedBy}, ${resolution.outcome} via ${resolution.channel} (${resolution.operationId})${suggestion.basis === undefined ? '' : `, basis ${suggestion.basis}`}`
    switch (proposal.kind) {
      case 'state': {
        const value: StateValue = confirmed
          ? {
              level: proposal.level,
              // Confirmed for the person under their delegation, which their history says (ADR 0016).
              authority: resolution.channel === 'delegation' ? 'delegated' : 'confirmed',
              confirmedBy: this.#actor,
              sourceOf: suggestion.id,
            }
          : { level: proposal.level, sourceOf: suggestion.id }
        const event = this.#episteme.log.commit({
          target: asId<NodeId>(proposal.target),
          actorId: this.#actor,
          dimensions: new Map([[asId<DimensionId>(proposal.dimension), value]]),
          reason: suggestion.rationale,
          source,
        })
        return { kind: 'event', id: event.id }
      }
      case 'link': {
        const edge = this.#linkNow(
          proposal.from,
          proposal.to,
          asId<EdgeTypeId>(proposal.relation),
          planned.edgeIds[0],
          source,
        )
        return { kind: 'edge', id: edge.edgeId }
      }
      case 'node': {
        const node = this.#addNodeNow({
          id: planned.nodeId ?? this.#nextId(proposal.nodeType),
          label: proposal.label,
          type: asId<NodeTypeId>(proposal.nodeType),
          tier: this.#tierOf(proposal.nodeType),
          source,
          // The text follows the label as decided, so a learner who puts it in their own words is not left
          // with the distiller's wording underneath.
          properties: {
            ...proposal.properties,
            text: proposal.label.trim(),
            ...provenanceOf(suggestion),
          },
        })
        return { kind: 'node', id: node.nodeId }
      }
      case 'claim': {
        const node = this.#addNodeNow({
          id: planned.nodeId ?? this.#nextId('claim'),
          label: proposal.label,
          type: NODE.claim,
          tier: 'thought',
          source,
          properties: provenanceOf(suggestion),
        })
        // An edge can only be checked once the claim exists. If one is refused, the claim is revoked, which
        // is how the graph withdraws something, so nothing half-accepted stays standing.
        const edges = (proposal.about ?? []).map((target, index) => ({
          id: asId<EdgeId>(planned.edgeIds[index] ?? newEdgeId()),
          type: EDGE.refersTo,
          from: asId<NodeId>(node.nodeId),
          to: asId<NodeId>(target),
          actorId: this.#actor,
          source,
        }))
        for (const edge of edges) {
          const preview = this.#episteme.graph.previewEdge(edge)
          if (!preview.ok) {
            this.#episteme.graph.revokeNode(node.nodeId)
            return preview.refusal
          }
        }
        for (const edge of edges) this.#episteme.graph.addEdge(edge)
        return { kind: 'node', id: node.nodeId }
      }
    }
  }

  /** Why a reference to a suggested node names nothing: it must name a pending or accepted node suggestion. */
  #suggestedNodeRefusal(reference: string): MutationRefusal | undefined {
    const id = reference.slice(SUGGESTED_NODE_PREFIX.length)
    // A node of the batch being checked: it becomes a suggestion in the same write.
    if (id === BATCH_PLACEHOLDER) return undefined
    if (this.#acceptedNodeOf(id) !== undefined) return undefined
    const pending = this.#ownSuggestion(id)
    if (
      pending !== undefined &&
      (pending.proposal.kind === 'node' || pending.proposal.kind === 'claim')
    ) {
      return undefined
    }
    return { code: 'unknown_suggestion', message: `"${reference}" names no suggested node` }
  }

  /** The node an accepted suggestion became, found by the provenance it carries. */
  #acceptedNodeOf(suggestionId: string): string | undefined {
    return this.#episteme.graph
      .listNodes()
      .find((node) => node.properties[PROVENANCE_KEY] === suggestionId)?.id
  }

  /**
   * A proposal with every `cand:` end replaced by the node its suggestion became.
   *
   * A suggestion that is still pending cannot stand in for a node yet (`depends_on_pending`); one that was
   * dismissed never will (`unresolved_candidate`).
   */
  #resolveSuggestedNodes(proposal: Proposal): Proposal | MutationRefusal {
    const resolve = (end: string): string | MutationRefusal => {
      if (!isSuggestedNode(end)) return end
      const id = end.slice(SUGGESTED_NODE_PREFIX.length)
      const accepted = this.#acceptedNodeOf(id)
      if (accepted !== undefined) return accepted
      if (this.#ownSuggestion(id) !== undefined) {
        return {
          code: 'depends_on_pending',
          message: `it depends on suggestion "${id}", which has not been accepted yet; decide that one first`,
        }
      }
      return {
        code: 'unresolved_candidate',
        message: `it depends on suggestion "${id}", which was not accepted, so it has nothing to attach to`,
      }
    }
    switch (proposal.kind) {
      case 'link': {
        const from = resolve(proposal.from)
        if (typeof from !== 'string') return from
        const to = resolve(proposal.to)
        if (typeof to !== 'string') return to
        return { ...proposal, from, to }
      }
      case 'state': {
        const target = resolve(proposal.target)
        return typeof target === 'string' ? { ...proposal, target } : target
      }
      case 'claim': {
        if (proposal.about === undefined) return proposal
        const about: string[] = []
        for (const end of proposal.about) {
          const resolved = resolve(end)
          if (typeof resolved !== 'string') return resolved
          about.push(resolved)
        }
        return { ...proposal, about }
      }
      case 'node':
        return proposal
    }
  }

  /** The tier a node of this type starts in, as its registered definition says. */
  #tierOf(nodeType: string): 'draft' | 'thought' | 'reference' {
    return this.#episteme.registries.nodeTypes.find(nodeType)?.defaultTier ?? 'thought'
  }

  /** Material this session has distilled, oldest first. */
  sources(): readonly Source[] {
    return this.#sources.list().filter((source) => ownerOf(source) === this.#actor)
  }

  /**
   * Distils learning material into pending suggestions (ADR 0009). Changes no understanding.
   *
   * The material is kept beside the graph, never in it, in canonical form (`canonicalText`), and every span
   * points into that text. It is split into episodes, and the reader's candidates are checked against the
   * domain's policy. Each kept candidate then becomes a pending suggestion, through the same checks `propose`
   * applies, carrying the words it came from. A candidate that refers to another, such as a claim answering a
   * question found with it, refers to that suggestion as `cand:<id>`, and can be accepted only after it. Nothing
   * reaches the graph or the history until the learner decides.
   *
   * The reader is Episteme's rule-based one, or, with `host`, the host's own model (ADR 0011). Then Episteme's
   * reader does not also run, the host's items are verified and read through the same engine, what is kept is
   * proposed by `requestedBy`, and refusals are reported under the host's own refs. `learner` names the
   * learner's speaker label in a dialogue; without it nothing is `stated`.
   *
   * Repetition (ADR 0011 §5):
   * - a host submission with a `submissionId` is remembered with its scope (`requestedBy`) and the digest of
   *   its whole payload. The same again writes nothing and answers with the original receipt and each
   *   candidate's current status; a different payload under the same id is refused;
   * - the same text, read by the same reader in the same `hostSession`, reuses its source, and a candidate whose
   *   proposal and origin both match a pending suggestion is refused as `already_pending`.
   *
   * Bounded: material longer than `MAX_MATERIAL` characters, or a queue already holding `MAX_PENDING`
   * suggestions, is refused as a value, before anything is kept.
   */
  distill(
    material: { readonly title?: string; readonly text: string },
    options: {
      readonly requestedBy?: string
      readonly agent?: CognitiveAgent
      readonly policy?: DistillationPolicy
      readonly learner?: string
      readonly host?: {
        readonly candidates: readonly HostItem[]
        readonly hostSession?: string
        readonly submissionId?: string
      }
      /** Set by `distillThread`: the thread the material was built from, and where each turn lies in it. */
      readonly thread?: ThreadMaterial
    } = {},
  ): Promise<DistillOutcome> {
    return this.#exclusive(async (): Promise<DistillOutcome> => {
      const text = canonicalText(material.text)
      if (text.trim() === '') {
        return {
          ok: false,
          refusal: { code: 'empty_material', message: 'there is no material to distil' },
        }
      }
      if (text.length > MAX_MATERIAL) {
        return {
          ok: false,
          refusal: {
            code: 'material_too_long',
            message: `material of ${text.length} characters is longer than the ${MAX_MATERIAL} one distillation reads; split it`,
          },
        }
      }
      const host = options.host
      const submittedBy = options.requestedBy
      if (host !== undefined && host.candidates.length > MAX_HOST_ITEMS) {
        return {
          ok: false,
          refusal: {
            code: 'too_many_candidates',
            message: `${host.candidates.length} items are more than the ${MAX_HOST_ITEMS} one reading may carry; split the material`,
          },
        }
      }
      if (host !== undefined && submittedBy === undefined) {
        return {
          ok: false,
          refusal: {
            code: 'invalid_request',
            message: 'a host reading needs the agent that submitted it',
          },
        }
      }

      // A keyed submission made before is answered from what it stored, and nothing is written (ADR 0011 §5).
      const keyed =
        host?.submissionId === undefined || submittedBy === undefined
          ? undefined
          : {
              by: submittedBy,
              id: host.submissionId,
              payloadDigest: payloadDigest({
                text,
                ...(material.title === undefined ? {} : { title: material.title }),
                ...(options.learner === undefined ? {} : { learner: options.learner }),
                ...(host.hostSession === undefined ? {} : { hostSession: host.hostSession }),
                candidates: host.candidates,
              }),
            }
      if (keyed !== undefined) {
        let earlier = this.#sources.submission(this.#actor, keyed.by, keyed.id)
        // Recorded on its source, but its drafts never landed: the write of the drafts failed or the process
        // died first. Nothing of it reached the queue, so it is not answered as made: the record of the attempt
        // is dropped and this request is read again. The source stays, and is reused for the same words.
        if (
          earlier !== undefined &&
          this.#suggestions.landing(this.#actor, keyed.by, keyed.id) === undefined
        ) {
          await this.#sources.put({
            ...earlier.source,
            submissions: (earlier.source.submissions ?? []).filter(
              (entry) => entry !== earlier?.submission,
            ),
          })
          earlier = undefined
        }
        if (earlier !== undefined) {
          if (earlier.submission.payloadDigest !== keyed.payloadDigest) {
            return {
              ok: false,
              refusal: {
                code: 'submission_conflict',
                message: `submission "${keyed.id}" was already made with a different payload; nothing was changed, and a new request needs a new submissionId`,
              },
            }
          }
          return this.#resubmitted(earlier.source, earlier.submission)
        }
      }

      if (this.#ownSuggestions().length >= MAX_PENDING) {
        return {
          ok: false,
          refusal: {
            code: 'too_many_pending',
            message: `${MAX_PENDING} suggestions are already waiting; decide on some before distilling more`,
          },
        }
      }

      const policy = options.policy ?? this.#scene.distillationPolicy
      const reader: SourceReader = host === undefined ? 'episteme' : 'host'
      const reused = this.#sources.reusable(this.#actor, text, reader, host?.hostSession)
      const sourceId = reused?.id ?? `src_${randomUUID()}`
      const reading =
        host === undefined
          ? undefined
          : prepareHostReading({
              sourceId,
              text,
              items: host.candidates,
              policy,
              actorId: this.#actor,
            })
      const agent = reading?.reader ?? options.agent ?? new RuleBasedDistiller({ policy })
      const result = await distill({
        material: { sourceId, text },
        agent,
        policy,
        actorId: this.#actor,
        known: this.#seen
          .listNodes()
          .map((node) => ({ id: node.id, label: node.label, type: node.type })),
        ...(options.learner === undefined ? {} : { learner: options.learner }),
      })

      // A host's model did the reading, so the agent that submitted it proposes what is kept.
      const proposedBy = reading === undefined ? `actor_agent_${agent.id}` : (submittedBy ?? '')
      const refused: DistillRefusal[] = (reading?.refused ?? []).map(({ ref, refusal }) => ({
        ref,
        ...refusal,
      }))
      const accepted: {
        ref: string
        proposal: Proposal
        origin: SuggestionOrigin
        rationale: string
        basis: Suggestion['basis']
      }[] = []
      const candidates = new Map<string, number>()
      const refer = (end: string): string | undefined => {
        if (!end.startsWith(CANDIDATE_PREFIX)) return end
        const index = candidates.get(end.slice(CANDIDATE_PREFIX.length))
        return index === undefined ? undefined : `${SUGGESTED_NODE_PREFIX}#${index}`
      }

      for (const candidate of result.candidates) {
        if (candidate.status === 'refused') {
          // Told under the host's own refs when a host read it. A quote that could not be located has no
          // origin, and none is made up for it.
          const told =
            reading === undefined
              ? { ref: candidate.ref, refusal: candidate.refusal }
              : hostRefusalOf(reading, candidate)
          if (told === undefined) continue
          refused.push({
            ref: told.ref,
            ...told.refusal,
            ...(candidate.origin === undefined ? {} : { origin: candidate.origin }),
          })
          continue
        }
        const ref = reading === undefined ? candidate.ref : (candidate.readerRef ?? candidate.ref)
        const origin: SuggestionOrigin = candidate.origin
        const suggestion = candidate.suggestion
        const proposals: Proposal[] = []
        if (suggestion.kind === 'node') {
          proposals.push({
            kind: 'node',
            nodeType: suggestion.nodeType,
            label: suggestion.label,
            ...(suggestion.properties === undefined ? {} : { properties: suggestion.properties }),
          })
        } else if (suggestion.kind === 'edge') {
          const from = refer(suggestion.from)
          const to = refer(suggestion.to)
          if (from !== undefined && to !== undefined) {
            proposals.push({ kind: 'link', from, to, relation: suggestion.edgeType })
          }
        } else {
          const target = refer(suggestion.target)
          for (const [dimension, value] of Object.entries(suggestion.dimensions)) {
            if (target !== undefined && value.level !== undefined) {
              proposals.push({ kind: 'state', target, dimension, level: value.level })
            }
          }
        }
        if (proposals.length === 0) {
          refused.push({
            ref,
            code: 'depends_on_refused',
            message: 'it depends on a candidate that was not kept',
            origin,
          })
          continue
        }
        for (const proposal of proposals) {
          if (suggestion.kind === 'node') candidates.set(candidate.ref, accepted.length)
          accepted.push({
            ref,
            proposal,
            origin,
            rationale: suggestion.rationale,
            basis: suggestion.basis,
          })
        }
      }

      // The same checks `propose` applies, with references to this batch's own nodes standing in for nodes. A
      // candidate that repeats a pending suggestion, the same proposal from the same words, is not queued
      // twice; what refers to it refers to the pending one instead.
      const pending = this.#ownSuggestions()
      const kept: typeof accepted = []
      const keptIndex = new Map<number, number>()
      const pendingAs = new Map<number, string>()
      for (const [index, item] of accepted.entries()) {
        const local = localReferences(item.proposal)
        const brokenReference = local.some(
          (reference) => !keptIndex.has(reference) && !pendingAs.has(reference),
        )
        const repeated = brokenReference
          ? undefined
          : pending.find((suggestion) =>
              repeats(
                suggestion,
                bindLocalReferences(item.proposal, (reference) => pendingAs.get(reference)),
                item.origin,
              ),
            )
        if (repeated !== undefined) {
          pendingAs.set(index, repeated.id)
          refused.push({
            ref: item.ref,
            code: 'already_pending',
            message: `the same suggestion from the same words is already waiting as "${repeated.id}"`,
            origin: item.origin,
          })
          continue
        }
        const refusal = brokenReference
          ? { code: 'depends_on_refused', message: 'it depends on a candidate that was not kept' }
          : this.#refusalOf(withoutLocalReferences(item.proposal), {
              proposedBy,
              rationale: item.rationale,
            })
        if (refusal !== undefined) {
          refused.push({ ref: item.ref, ...refusal, origin: item.origin })
          continue
        }
        keptIndex.set(index, kept.length)
        kept.push(item)
      }

      // The limit holds for what this run would add too, not only for what was waiting before it.
      const waiting = pending.length
      if (waiting + kept.length > MAX_PENDING) {
        return {
          ok: false,
          refusal: {
            code: 'too_many_pending',
            message: `${waiting} suggestions are waiting, and this material would add ${kept.length}, more than the ${MAX_PENDING} the queue holds; decide on some first, or distil less at once`,
          },
        }
      }

      // The ids are chosen first, so the receipt of a keyed submission can name them, and it is stored with the
      // source before any draft: a draft's origin never points at nothing.
      const ids = newSuggestionIds(kept.length)
      const now = systemClock.now()
      const submission: SourceSubmission | undefined =
        keyed === undefined
          ? undefined
          : {
              ...keyed,
              at: now,
              receipt: {
                kept: kept.map((item, at) => ({ ref: item.ref, suggestionId: ids[at] ?? '' })),
                refused: refused.map(({ ref, code }) => ({ ref, code })),
              },
            }
      if (reused === undefined) {
        await this.#sources.put({
          id: sourceId,
          owner: this.#actor,
          title: canonicalText(material.title?.trim() || firstLine(text)),
          text,
          kind: result.episodes[0]?.kind ?? 'prose',
          episodes: result.episodes.map((episode) => ({
            id: episode.id,
            span: episode.span,
            ...(episode.time === undefined ? {} : { time: episode.time }),
          })),
          addedAt: now,
          ...(options.requestedBy === undefined ? {} : { requestedBy: options.requestedBy }),
          reader,
          digest: textDigest(text),
          ...(host?.hostSession === undefined ? {} : { hostSession: host.hostSession }),
          ...(options.thread === undefined
            ? {}
            : {
                thread: {
                  id: options.thread.id,
                  turns: options.thread.turns.map((turn) => turn.id),
                },
              }),
          ...(submission === undefined ? {} : { submissions: [submission] }),
        })
      } else if (submission !== undefined) {
        await this.#sources.put({
          ...reused,
          submissions: [...(reused.submissions ?? []), submission],
        })
      }

      const stored = await this.#suggestions.addAll(
        kept.length,
        (chosen) =>
          kept.map((item) => ({
            proposal: bindLocalReferences(item.proposal, (reference) => {
              const at = keptIndex.get(reference)
              return at === undefined ? pendingAs.get(reference) : chosen[at]
            }),
            owner: this.#actor,
            rationale: item.rationale,
            proposedBy,
            proposedAt: now,
            origin: withTurn(item.origin, options.thread),
            ...(item.basis === undefined ? {} : { basis: item.basis }),
            ...(options.requestedBy === undefined ? {} : { requestedBy: options.requestedBy }),
          })),
        ids,
        keyed === undefined
          ? undefined
          : {
              owner: this.#actor,
              by: keyed.by,
              submissionId: keyed.id,
              sourceId,
              suggestionIds: ids,
            },
      )
      // Under a delegation each kept draft is decided now, in the order kept, so one that refers to an earlier
      // one finds it accepted. Whatever is refused waits in the queue like any other.
      for (const suggestion of stored) await this.#decideUnderDelegation(suggestion)
      const suggestions = stored
      return {
        ok: true,
        status: 'pending',
        reader,
        sourceId,
        episodes: result.episodes.length,
        suggestions,
        refused,
      }
    })
  }

  /**
   * The answer to a keyed submission made again: what it stored, and what has become of each suggestion since.
   * Writes nothing.
   */
  #resubmitted(source: Source, submission: SourceSubmission): DistillOutcome {
    const kept = submission.receipt.kept.map(({ ref, suggestionId }) => ({
      ref,
      suggestionId,
      ...this.#currentStatusOf(suggestionId),
    }))
    return {
      ok: true,
      status: 'duplicate_submission',
      reader: source.reader,
      sourceId: source.id,
      episodes: source.episodes.length,
      suggestions: kept.flatMap(({ suggestionId }) => {
        const still = this.#ownSuggestion(suggestionId)
        return still === undefined ? [] : [still]
      }),
      refused: submission.receipt.refused.map(({ ref, code }) => ({
        ref,
        code,
        message: 'refused when this submission was first made',
      })),
      receipt: {
        submissionId: submission.id,
        submittedBy: submission.by,
        sourceId: source.id,
        reader: source.reader,
        ...(source.hostSession === undefined ? {} : { hostSession: source.hostSession }),
        storedAt: submission.at,
        kept,
        refused: submission.receipt.refused,
      },
    }
  }

  /**
   * What has become of a suggestion of a submission whose drafts landed: still pending; accepted or modified,
   * with what it committed, found through the provenance the graph keeps; or `not_pending`, no longer in the
   * queue with nothing in the graph from it. The landing record proves it was in the queue. Episteme keeps no
   * record of a dismissal, so `not_pending` does not claim one.
   */
  #currentStatusOf(suggestionId: string): SubmissionStatus {
    if (this.#ownSuggestion(suggestionId) !== undefined) return { status: 'pending' }
    const decided = (source: string | undefined): 'accepted' | 'modified' =>
      /, modified via /u.test(source ?? '') ? 'modified' : 'accepted'
    const graph = this.#episteme.graph
    for (const node of graph.listNodes()) {
      if (node.revoked !== true && node.properties[PROVENANCE_KEY] === suggestionId) {
        return { status: decided(node.source), committed: { kind: 'node', id: node.id } }
      }
    }
    const named = `suggestion ${suggestionId} from `
    for (const edge of graph.listEdges()) {
      if (edge.revoked !== true && edge.source?.includes(named) === true) {
        return { status: decided(edge.source), committed: { kind: 'edge', id: edge.id } }
      }
    }
    for (const node of graph.listNodes()) {
      for (const event of this.#episteme.log.history({ target: node.id, actorId: this.#actor })) {
        if ([...event.dimensions.values()].some((value) => value.sourceOf === suggestionId)) {
          return { status: decided(event.source), committed: { kind: 'event', id: event.id } }
        }
      }
    }
    return { status: 'not_pending' }
  }

  /** Why a proposal could never be accepted, or `undefined` when it could be. */
  #refusalOf(
    proposal: Proposal,
    from: { readonly proposedBy: string; readonly rationale: string },
  ): MutationRefusal | undefined {
    if (from.rationale.trim() === '') {
      return { code: 'missing_rationale', message: 'a suggestion must say why it is proposed' }
    }
    if (from.proposedBy.trim() === '' || from.proposedBy === this.#actor) {
      return {
        code: 'not_an_agent',
        message: 'only an agent proposes; the human records their own understanding directly',
      }
    }
    return this.#contentRefusalOf(proposal)
  }

  /**
   * Why a proposal's content could never be committed, or `undefined` when it could be.
   *
   * Shared by proposing and by a human's modification, so a value the human edits meets exactly the checks
   * the agent's value met.
   */
  #contentRefusalOf(proposal: Proposal): MutationRefusal | undefined {
    // A node suggested alongside this proposal stands in for its end until it is accepted. Here it only has to
    // name a suggested node; whether the relation fits is checked once it resolves, at decision time.
    const missing = (id: string): MutationRefusal | undefined =>
      isSuggestedNode(id)
        ? this.#suggestedNodeRefusal(id)
        : this.#seen.getNode(asId<NodeId>(id)) === undefined
          ? { code: 'unknown_node', message: `node "${id}" does not exist` }
          : undefined

    switch (proposal.kind) {
      case 'node': {
        const label = proposal.label.trim()
        if (label === '') return { code: 'missing_property', message: 'a node needs a label' }
        const preview = this.#episteme.graph.previewNode({
          id: asId<NodeId>(this.#nextId(proposal.nodeType)),
          type: asId<NodeTypeId>(proposal.nodeType),
          label,
          properties: { ...proposal.properties, text: label },
          tags: defaultTags('general'),
          tier: this.#tierOf(proposal.nodeType),
        })
        return preview.ok ? undefined : preview.refusal
      }
      case 'claim': {
        const label = proposal.label.trim()
        if (label === '') return { code: 'missing_property', message: 'a claim needs a label' }
        for (const id of proposal.about ?? []) {
          const refusal = missing(id)
          if (refusal !== undefined) return refusal
        }
        const preview = this.#episteme.graph.previewNode({
          id: asId<NodeId>(this.#nextId('claim')),
          type: NODE.claim,
          label,
          properties: { text: label },
          tags: defaultTags('general'),
          tier: 'thought',
        })
        return preview.ok ? undefined : preview.refusal
      }
      case 'link': {
        if (isSuggestedNode(proposal.from) || isSuggestedNode(proposal.to)) {
          if (!this.#episteme.registries.edgeTypes.has(proposal.relation)) {
            return {
              code: 'unregistered_edge_type',
              message: `edge type "${proposal.relation}" is not registered`,
            }
          }
          return missing(proposal.from) ?? missing(proposal.to)
        }
        // Two edges of one type between the same nodes say the same thing twice.
        const existing = this.#episteme.graph
          .listEdges()
          .find(
            (edge) =>
              edge.from === proposal.from &&
              edge.to === proposal.to &&
              edge.type === proposal.relation,
          )
        if (existing !== undefined) {
          return {
            code: 'duplicate_edge',
            message: `"${proposal.from}" already ${proposal.relation} "${proposal.to}" (edge ${existing.id})`,
          }
        }
        const preview = this.#episteme.graph.previewEdge({
          id: asId<EdgeId>(newEdgeId()),
          type: asId<EdgeTypeId>(proposal.relation),
          from: asId<NodeId>(proposal.from),
          to: asId<NodeId>(proposal.to),
        })
        return preview.ok ? undefined : preview.refusal
      }
      case 'state': {
        const refusal = missing(proposal.target)
        if (refusal !== undefined) return refusal
        const dimension = this.#scene.recordableDimensions.find(
          (candidate) => candidate.id === proposal.dimension,
        )
        if (dimension === undefined) {
          return {
            code: 'unregistered_dimension',
            message: `"${proposal.dimension}" is not a dimension the learner records. Available: ${this.#scene.recordableDimensions.map((d) => d.id).join(', ')}`,
          }
        }
        return levelRefusal(dimension, proposal.level)
      }
    }
  }

  /**
   * Writes what is pending and gives up ownership of the graph file, so another surface can open it.
   *
   * Every surface that opens a session closes it on the way out. A session that is never closed holds the
   * graph until its process exits.
   */
  close(): Promise<void> {
    // Queued like a mutation, so it waits for every change already under way, and nothing queued after it
    // can change a graph this session no longer owns.
    return this.#exclusive(async () => {
      await this.#persist()
      await this.#store?.close()
      this.#shared.closed = true
    })
  }

  /** Writes the graph and history. Only ever called inside the mutation queue. */
  async #persist(): Promise<void> {
    if (this.#store === undefined) return
    await this.#episteme.persist()
    await this.#store.save()
  }

  #view(node: GraphNode): NodeView {
    return {
      nodeId: node.id,
      label: node.label,
      type: node.type,
      tier: node.meta.tier ?? 'thought',
      tags: [...node.tags],
      ...(typeof node.properties[PROVENANCE_KEY] === 'string'
        ? { fromSuggestion: node.properties[PROVENANCE_KEY] }
        : {}),
    }
  }
}

/** Where a human made a decision, recorded with whatever it committed. */
export type DecisionChannel = 'learn-review' | 'mcp-elicitation' | 'delegation'

/** What a human decided about a pending suggestion. */
export type Decision =
  | { readonly action: 'accept' }
  | { readonly action: 'modify'; readonly proposal: Proposal }
  | { readonly action: 'dismiss' }

/** What a decision committed: one state event, one edge, or one claim node. */
export interface Committed {
  readonly kind: 'event' | 'edge' | 'node'
  readonly id: string
}

export type DecisionResult =
  | {
      readonly ok: true
      readonly outcome: 'accepted' | 'modified'
      readonly suggestion: Suggestion
      readonly committed: Committed
      /** Names this decision in the graph's provenance and in the write-ahead record. */
      readonly operationId: string
    }
  | { readonly ok: true; readonly outcome: 'dismissed'; readonly suggestion: Suggestion }
  | { readonly ok: false; readonly refusal: MutationRefusal }

/** A decision found unfinished when a session opened, and what was done about it. */
export interface RecoveredDecision {
  readonly operationId: string
  readonly suggestionId: string
  /** `completed`: it had landed, so its draft was removed. `rolled_back`: it had not, so the draft waits. */
  readonly settled: 'completed' | 'rolled_back'
}

function identify(resolution: Resolution): Omit<RecoveredDecision, 'settled'> {
  return { operationId: resolution.operationId, suggestionId: resolution.suggestionId }
}

/** A proposal's outcome. `delegated` is set when the service decided it under the person's delegation. */
export type ProposeResult =
  | {
      readonly ok: true
      readonly suggestion: Suggestion
      /** Set when the service decided it at once under the person's delegation (ADR 0016). */
      readonly delegated?: DecisionResult
    }
  | { readonly ok: false; readonly refusal: MutationRefusal }

/**
 * A command refused because of what it was asked to do, such as recording a dimension the learner cannot
 * record. Thrown before anything changes, so a caller can report it as a refusal.
 */
export class SessionRefusal extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SessionRefusal'
    this.code = code
  }
}

/**
 * Whether an error is a refusal of the request, by the session or by the graph's own validation, rather than a
 * failure, such as a write that did not reach the disk. A failure may come after the change was made in
 * memory, so reporting it as a refusal would tell the caller nothing happened when something did.
 */
export function isRefusal(error: unknown): error is Error & { readonly code: string } {
  return error instanceof SessionRefusal || isEpistemeError(error)
}

/** Material longer than this is split by the learner before it is distilled. */
export const MAX_MATERIAL = 20_000
/** A queue holding this many suggestions takes no more distillations until some are decided. */
export const MAX_PENDING = 500

/** At most this many items in one host reading (ADR 0011 §9). */
export const MAX_HOST_ITEMS = 100

/** A candidate distillation found and did not offer, with why, and the words it came from. */
export interface DistillRefusal {
  readonly ref: string
  readonly code: string
  readonly message: string
  /** Where its words are. Absent when they could not be located (ADR 0011). */
  readonly origin?: SuggestionOrigin
  /** For `already_known`: the node the learner already has, which the observation can be sent against. */
  readonly existingNodeId?: string
}

export type DistillOutcome =
  | {
      readonly ok: true
      /** `pending`: this request was read. `duplicate_submission`: it was made before, and nothing was written. */
      readonly status: 'pending' | 'duplicate_submission'
      readonly reader: SourceReader
      readonly sourceId: string
      readonly episodes: number
      /** What now waits for the learner: from this request, or, for a repeated one, what is still pending of it. */
      readonly suggestions: readonly Suggestion[]
      readonly refused: readonly DistillRefusal[]
      /** For a repeated keyed submission: what it was, and what has become of it. */
      readonly receipt?: SubmissionReceipt
    }
  | { readonly ok: false; readonly refusal: MutationRefusal }

/** What has become of a suggestion a submission kept (ADR 0011 §5). */
export type SubmissionStatus =
  | { readonly status: 'pending' }
  | {
      readonly status: 'accepted' | 'modified'
      /** What the decision committed, found through the provenance the graph keeps. */
      readonly committed: { readonly kind: 'node' | 'edge' | 'event'; readonly id: string }
    }
  /**
   * It was in the queue (its submission's landing record proves that), it is no longer, and nothing in the graph
   * came from it. A dismissal leaves exactly this, but leaves no record of its own, so this is not called one.
   */
  | { readonly status: 'not_pending' }

/** The receipt of a keyed submission, given when it is made again. Nothing is re-queued. */
export interface SubmissionReceipt {
  readonly submissionId: string
  readonly submittedBy: string
  readonly sourceId: string
  readonly reader: SourceReader
  readonly hostSession?: string
  /** When the submission was first made and stored. */
  readonly storedAt: number
  /** Each suggestion it kept, under the submitter's ref, with what has become of it. */
  readonly kept: readonly ({
    readonly ref: string
    readonly suggestionId: string
  } & SubmissionStatus)[]
  /** What it refused, under the submitter's ref. */
  readonly refused: readonly { readonly ref: string; readonly code: string }[]
}

/** The property under which an accepted node records the suggestion it came from. */
const PROVENANCE_KEY = 'suggestion'

/**
 * What an accepted node keeps of its suggestion: which one it was, the words it came from, and whether the
 * learner said them or they were read into what was said.
 */
function provenanceOf(suggestion: Suggestion): Record<string, unknown> {
  return {
    [PROVENANCE_KEY]: suggestion.id,
    ...(suggestion.origin === undefined ? {} : { origin: suggestion.origin }),
    ...(suggestion.basis === undefined ? {} : { basis: suggestion.basis }),
  }
}

function isSuggestedNode(id: string): boolean {
  return id.startsWith(SUGGESTED_NODE_PREFIX)
}

/** The ends of a proposal that name another candidate of the same distillation, by position. */
function localReferences(proposal: Proposal): readonly number[] {
  const ends =
    proposal.kind === 'link'
      ? [proposal.from, proposal.to]
      : proposal.kind === 'state'
        ? [proposal.target]
        : []
  return ends.flatMap((end) =>
    end.startsWith(`${SUGGESTED_NODE_PREFIX}#`)
      ? [Number(end.slice(SUGGESTED_NODE_PREFIX.length + 1))]
      : [],
  )
}

/**
 * A proposal checked as if its references to this distillation's own nodes were already suggestions: they
 * are replaced by a reference that passes the "names a suggested node" check without naming a real draft.
 */
function withoutLocalReferences(proposal: Proposal): Proposal {
  return bindLocalReferences(proposal, () => undefined, true)
}

function bindLocalReferences(
  proposal: Proposal,
  idOf: (position: number) => string | undefined,
  placeholder = false,
): Proposal {
  const bind = (end: string): string => {
    if (!end.startsWith(`${SUGGESTED_NODE_PREFIX}#`)) return end
    if (placeholder) return `${SUGGESTED_NODE_PREFIX}${BATCH_PLACEHOLDER}`
    const id = idOf(Number(end.slice(SUGGESTED_NODE_PREFIX.length + 1)))
    return id === undefined ? end : `${SUGGESTED_NODE_PREFIX}${id}`
  }
  if (proposal.kind === 'link')
    return { ...proposal, from: bind(proposal.from), to: bind(proposal.to) }
  if (proposal.kind === 'state') return { ...proposal, target: bind(proposal.target) }
  return proposal
}

/** Stands in, while checking a batch, for a node of the same batch that has no id yet. */
const BATCH_PLACEHOLDER = '__batch__'

/**
 * Whether a pending suggestion is this one again: the same proposal, from the same words of the same source
 * (ADR 0011 §5). Either alone is not a repetition: the same idea said elsewhere, or other words read at the same
 * place, are new observations.
 */
function repeats(pending: Suggestion, proposal: Proposal, origin: SuggestionOrigin): boolean {
  const at = pending.origin
  return (
    at !== undefined &&
    at.sourceId === origin.sourceId &&
    at.span.start === origin.span.start &&
    at.span.end === origin.span.end &&
    stableJson(normalized(pending.proposal)) === stableJson(normalized(proposal))
  )
}

/** JSON with object keys in order, so two equal values compare equal however they were built. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_, field: unknown) =>
    typeof field === 'object' && field !== null && !Array.isArray(field)
      ? Object.fromEntries(
          Object.entries(field as Record<string, unknown>).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : field,
  )
}

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/u)[0] ?? ''
  return line.length > 60 ? `${line.slice(0, 59)}…` : line
}

/** A node to add, as a batch or an addition gives it. */
export interface NodeInput {
  readonly id: string
  readonly label: string
  readonly type: Parameters<Episteme['graph']['addNode']>[0]['type']
  readonly tier: 'draft' | 'thought' | 'reference'
  readonly topic?: string
  readonly source?: string
  readonly scope?: string
  /** Properties beyond the label's `text`, such as a distilled node's provenance. */
  readonly properties?: Readonly<Record<string, unknown>>
}

/** What a batch may do: add nodes and link them, all written together when it returns. */
export interface SessionWriter {
  addNode(input: NodeInput): NodeView
  link(
    from: string,
    to: string,
    type?: Parameters<Episteme['graph']['addEdge']>[0]['type'],
    id?: string,
  ): { readonly edgeId: string }
}

/**
 * A new edge id: unique without depending on anything that can repeat.
 *
 * Edge ids were once derived from the event count and the endpoints, which repeats whenever two edges join
 * the same nodes with no event in between, as accepting two links does. Core now refuses a repeated id, so a
 * repeating scheme would turn into refusals rather than overwrites. Nothing types an edge id by hand.
 */
function newEdgeId(): string {
  return `edge_${randomUUID()}`
}

/** A proposal with what it names said once: a claim about the same node twice is about it once. */
function normalized(proposal: Proposal): Proposal {
  if (proposal.kind !== 'claim' || proposal.about === undefined) return proposal
  return { ...proposal, about: [...new Set(proposal.about)] }
}

/** Drafts live beside the graph file they are about, and are owned with it. */
function suggestionsPathFor(graphPath: string): string {
  return `${graphPath}.suggestions.jsonl`
}

/** The part of the durable store a session uses: writing, and releasing the graph when it is done. */
interface Store {
  save(state?: unknown): Promise<void>
  close(): Promise<void>
}

/** Turns the retrieval's recorded contributions into something a view can render. */
function toRankedView(context: RelevantContext): readonly RankedView[] {
  const ranked: readonly RankedEntry[] = context.ranked ?? []
  const byId = new Map(context.nodes.map((node) => [node.id, node]))

  return ranked.map((entry) => {
    const node = byId.get(entry.nodeId)
    const reasons = [...entry.contributions]
      .sort((left, right) => right.contribution - left.contribution)
      .map((contribution) => ({
        signal: contribution.signal,
        value: contribution.value,
        weight: contribution.weight,
        contribution: contribution.contribution,
        share: entry.score === 0 ? 0 : contribution.contribution / entry.score,
        explanation: explainSignal(contribution.signal, contribution.value, entry.matchedTerms),
        explanationZh: explainSignalZh(contribution.signal, contribution.value, entry.matchedTerms),
        labelZh: SIGNAL_LABELS_ZH[contribution.signal] ?? contribution.signal,
      }))

    return {
      nodeId: entry.nodeId,
      label: node?.label ?? entry.nodeId,
      type: node?.type ?? 'unknown',
      score: entry.score,
      origin: entry.origin,
      matchedTerms: entry.matchedTerms,
      reasons,
    }
  })
}

/** The signal names in Simplified Chinese, for the learner-facing display. */
export const SIGNAL_LABELS_ZH: Readonly<Record<string, string>> = {
  semantic: '语义',
  lexical: '词面',
  graph: '图谱',
  cognitive: '你的理解',
  recency: '新旧',
}

/**
 * How one signal is being read, in the learner's terms.
 *
 * The point of showing this at all is that a relevance decision about someone's own understanding should
 * be legible to them. A bare number would be a request for trust; a sentence is something they can argue
 * with.
 */
function explainSignal(signal: string, value: number, matchedTerms: readonly string[]): string {
  switch (signal) {
    case 'semantic':
      return value === 0
        ? 'not close in meaning to your question'
        : `close in meaning to your question (${(value * 100).toFixed(0)}% similarity)`
    case 'lexical':
      return matchedTerms.length > 0
        ? `shares the words ${matchedTerms.map((term) => `"${term}"`).join(', ')}`
        : 'no words in common with your question'
    case 'graph':
      // "Connected to", not "is": a node can score full graph proximity without being the question's
      // subject at all, and the stronger phrasing claimed something the data does not say. It read as a
      // defect on a node the learner had never asked about.
      return value >= 1
        ? 'is directly connected to what you asked about'
        : 'is connected to what you asked about'
    case 'cognitive':
      return value === 0
        ? 'you have not recorded anything about it'
        : 'your own recorded understanding makes it worth resurfacing'
    case 'recency':
      return 'recently added or changed'
    default:
      return signal
  }
}

/** The same reading in Simplified Chinese, which is what the learner actually reads. */
function explainSignalZh(signal: string, value: number, matchedTerms: readonly string[]): string {
  switch (signal) {
    case 'semantic':
      return value === 0
        ? '和你的问题在含义上不相近'
        : `和你的问题在含义上相近（相似度 ${(value * 100).toFixed(0)}%）`
    case 'lexical':
      return matchedTerms.length > 0
        ? `和你的问题共有这些词：${matchedTerms.map((term) => `「${term}」`).join('、')}`
        : '和你的问题没有共同词'
    case 'graph':
      return value >= 1 ? '和你检索到的内容直接相连' : '和你问的东西在图谱上相连'
    case 'cognitive':
      return value === 0 ? '你还没有为它记录过任何理解' : '你自己记录过的理解让它值得再次出现'
    case 'recency':
      return '最近新增或改动过'
    default:
      return signal
  }
}

/**
 * Classifies one recorded item by what would help the learner next.
 *
 * Order matters: an open conflict outranks everything, because it is the one state the system explicitly
 * refuses to build on. Surfacing a settled item by mistake is a smaller failure than ignoring a conflict the
 * learner took the trouble to mark.
 */
function attentionFor(
  dimensions: readonly { readonly id: string; readonly level: string }[],
  settled: boolean,
  openConflicts: readonly string[],
): AttentionReason {
  if (openConflicts.length > 0) return 'conflict'

  const levelOf = (id: string): string | undefined =>
    dimensions.find((entry) => entry.id === id)?.level

  // Believed but not sayable — which requires the belief to have been *recorded*. An unrecorded confidence
  // is not evidence of believing, so `unexplained` needs confidence to be present and not low. Without that,
  // every node with a low articulation alone would be labelled this way and the label would stop meaning
  // anything distinct from `shaky`.
  const confidence = levelOf(DIMENSION.confidence)
  if (
    levelOf(DIMENSION.articulation) === 'low' &&
    confidence !== undefined &&
    confidence !== 'low'
  ) {
    return 'unexplained'
  }

  return settled ? 'settled' : 'shaky'
}

/** One readable line, so every surface does not compose the same sentence differently. */
function progressLine(touched: number, settled: number): string {
  if (touched === 0) return '你还没有记录过任何理解'
  return `你为 ${touched} 个节点记录过理解，其中 ${settled} 个已经可以往下建`
}

/** @deprecated Renamed to `CognitiveSession` (ADR 0013, step M3); the alias is removed one release later. */
export const LearnSession = CognitiveSession
/** @deprecated Renamed to `CognitiveSession` (ADR 0013, step M3). */
export type LearnSession = CognitiveSession
