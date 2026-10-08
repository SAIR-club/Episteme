import { randomUUID } from 'node:crypto'
import {
  DeterministicEmbeddingAdapter,
  InMemoryEmbeddingCache,
  asId,
  isEpistemeError,
  systemClock,
  toSerializedEvent,
  type SerializedStateEvent,
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
} from '@episteme/core'
import {
  DIMENSION,
  EDGE,
  HybridRetriever,
  NODE,
  learnTags,
  retrieveWith,
  toAgentContext,
  type RankedEntry,
  type RelevantContext,
  type Retriever,
} from '@episteme/domain-learn'
import { MockCognitiveAgent } from '@episteme/agent'
import { chineseLearnerResponder } from './responder.js'
import {
  SUGGESTED_NODE_PREFIX,
  SuggestionStore,
  type Proposal,
  type Resolution,
  type Suggestion,
  type SuggestionOrigin,
} from './suggestions.js'
import { SourceStore, type Source } from './sources.js'
import { CANDIDATE_PREFIX, type CognitiveAgent } from '@episteme/agent'
import { RuleBasedDistiller, distill, type DistillationPolicy } from '@episteme/distillation'
import { learnDistillationPolicy } from '@episteme/domain-learn/distillation'
import { agentActor, humanActor, openEpisteme, type Episteme } from '@episteme/sdk'
import { openLocalStorage } from '@episteme/storage-local'

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

/** A dimension the learner can record, with the levels the domain pack allows. */
export interface RecordableDimension {
  readonly id: DimensionId
  readonly label: string
  /** The same label in Simplified Chinese, shown first to the learner. */
  readonly labelZh: string
  readonly levels: readonly string[]
  /** Levels with their Chinese names, in the same order as `levels`. */
  readonly levelLabelsZh: readonly { readonly level: string; readonly label: string }[]
  readonly description: string
  readonly descriptionZh: string
}

/**
 * The dimensions a learner may set from this surface, in the order they are offered.
 *
 * Deliberately a subset of the registered axes. The others are recorded by other means or are not yet
 * settable by hand, and offering a control for a dimension whose meaning is unclear would invite the
 * learner to record something they cannot interpret later.
 *
 * Chinese and English are both carried here rather than translated in a view, so the two cannot drift:
 * `AGENTS.md` requires Simplified Chinese for user-facing prose and English for code, and a dimension whose
 * Chinese name disagrees with its English one would be a correctness problem, not a cosmetic one.
 */
export const RECORDABLE_DIMENSIONS: readonly RecordableDimension[] = [
  {
    id: DIMENSION.confidence,
    label: 'Confidence',
    labelZh: '确信程度',
    levels: ['low', 'medium', 'high'],
    levelLabelsZh: [
      { level: 'low', label: '低' },
      { level: 'medium', label: '中' },
      { level: 'high', label: '高' },
    ],
    description: 'How much you would rely on this.',
    descriptionZh: '你愿意多大程度上依赖它。',
  },
  {
    id: DIMENSION.articulation,
    label: 'Articulation',
    labelZh: '表达程度',
    levels: ['low', 'medium', 'high'],
    levelLabelsZh: [
      { level: 'low', label: '低' },
      { level: 'medium', label: '中' },
      { level: 'high', label: '高' },
    ],
    description: 'How well you could explain it to someone else.',
    descriptionZh: '你能多好地把它讲给别人听。',
  },
  {
    id: DIMENSION.evidence,
    label: 'Evidence',
    labelZh: '证据',
    levels: ['none', 'weak', 'reproduced', 'derived'],
    levelLabelsZh: [
      { level: 'none', label: '无' },
      { level: 'weak', label: '薄弱' },
      { level: 'reproduced', label: '已复现' },
      { level: 'derived', label: '已推导' },
    ],
    description: 'What backs it up.',
    descriptionZh: '它背后有什么支撑。',
  },
  {
    id: DIMENSION.conflict,
    label: 'Conflict',
    labelZh: '冲突',
    levels: ['none', 'open', 'resolved'],
    levelLabelsZh: [
      { level: 'none', label: '无' },
      { level: 'open', label: '未解决' },
      { level: 'resolved', label: '已解决' },
    ],
    description: 'Whether you hold something that contradicts it.',
    descriptionZh: '你是否同时持有与它矛盾的东西。',
  },
]

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

export interface SessionOptions {
  /** Where the graph lives. Without one, the session is in memory and loses everything on exit. */
  readonly filePath?: string
  readonly adapter?: EmbeddingAdapter
  readonly weights?: ConstructorParameters<typeof HybridRetriever>[4]
}

/**
 * A live Learn session.
 *
 * Holds one composed instance and one retriever, so every call reads the same graph and the same event
 * history. Rebuilding the retriever per call would reintroduce the possibility of a display that does not
 * match the answer it accompanies.
 */
export class LearnSession {
  readonly #episteme: Episteme
  readonly #retriever: Retriever
  readonly #agent = new MockCognitiveAgent({ responder: chineseLearnerResponder })
  readonly #store: Store | undefined
  readonly #suggestions: SuggestionStore
  readonly #sources: SourceStore
  /** The tail of the mutation queue. See `#exclusive`. */
  #mutations: Promise<unknown> = Promise.resolve()
  /** See `revision`. Advanced only by `#exclusive`. */
  #revision = 0
  /** See `epoch`. */
  readonly #epoch = randomUUID()
  #closed = false
  readonly #recovered: RecoveredDecision[] = []

  private constructor(
    episteme: Episteme,
    retriever: Retriever,
    suggestions: SuggestionStore,
    sources: SourceStore,
    store?: Store,
  ) {
    this.#episteme = episteme
    this.#retriever = retriever
    this.#suggestions = suggestions
    this.#sources = sources
    this.#store = store
  }

  /**
   * Opens a session, reading any existing history first.
   *
   * The ordering 鈥?load, then compose 鈥?is the rule `@episteme/sdk` exists to hold, so this does not
   * repeat it.
   */
  static async open(options: SessionOptions = {}): Promise<LearnSession> {
    const actors = [humanActor(HUMAN), agentActor(SCAFFOLD)]
    const adapter = options.adapter ?? new DeterministicEmbeddingAdapter()

    if (options.filePath === undefined) {
      const { compose } = await import('@episteme/sdk')
      const episteme = compose({ actors, actorId: HUMAN })
      return new LearnSession(
        episteme,
        new HybridRetriever(
          episteme.graph,
          episteme.log,
          adapter,
          new InMemoryEmbeddingCache(),
          ...(options.weights === undefined ? [] : [options.weights]),
        ),
        await SuggestionStore.open(),
        await SourceStore.open(),
      )
    }

    const storage = await openLocalStorage(options.filePath)
    let episteme: Episteme
    let suggestions: SuggestionStore
    let sources: SourceStore
    try {
      episteme = await openEpisteme(storage, { actors, actorId: HUMAN })
      // Opened only after the graph's lock is held, so the drafts have the same single owner as the graph.
      suggestions = await SuggestionStore.open(suggestionsPathFor(options.filePath))
      // Material distilled into this graph, kept beside it like the drafts and owned with it.
      sources = await SourceStore.open(`${options.filePath}.sources.jsonl`)
    } catch (error) {
      // The file is owned from the moment storage opened. A history that fails to restore must not keep it.
      await storage.close()
      throw error
    }
    const session = new LearnSession(
      episteme,
      new HybridRetriever(
        episteme.graph,
        episteme.log,
        adapter,
        new InMemoryEmbeddingCache(),
        ...(options.weights === undefined ? [] : [options.weights]),
      ),
      suggestions,
      sources,
      storage,
    )
    try {
      // Before anyone can use it: a decision a crash left half-done is finished or undone first.
      await session.#recover()
    } catch (error) {
      await storage.close()
      throw error
    }
    return session
  }

  get actorId(): ActorId {
    return HUMAN
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
      return (Object.entries(weights) as [string, number][]).map(([signal, weight]) => ({
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
    return this.#revision
  }

  /**
   * Which opening of the graph a `revision` counts within. A new session, such as after a restart, starts a
   * new epoch, so a revision remembered from before cannot be mistaken for the same number counted again.
   */
  get epoch(): string {
    return this.#epoch
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
  async recall(question: string): Promise<RecallResult> {
    return this.#recallView(question, await this.#retrieve(question))
  }

  #retrieve(question: string): Promise<RelevantContext> {
    return retrieveWith(this.#retriever, this.#episteme.graph, this.#episteme.log, question, {
      actorId: HUMAN,
      depth: 1,
      limit: 8,
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
    options: { readonly reason?: string } = {},
  ): Promise<{
    readonly eventId: string
    readonly recorded: readonly { id: string; level: string }[]
  }> {
    const entries = Object.entries(dimensions).filter(([, level]) => level !== '')
    if (entries.length === 0) {
      throw new Error('record needs at least one dimension')
    }

    for (const [dimension] of entries) {
      const known = RECORDABLE_DIMENSIONS.find((candidate) => candidate.id === dimension)
      if (known === undefined) {
        throw new Error(
          `"${dimension}" is not recordable from this surface. Available: ${RECORDABLE_DIMENSIONS.map((d) => d.id).join(', ')}`,
        )
      }
    }

    return this.#exclusive(async () => {
      const event = this.#episteme.log.commit({
        target: asId<NodeId>(target),
        actorId: HUMAN,
        dimensions: new Map(
          entries.map(([dimension, level]): [DimensionId, StateValue] => [
            asId<DimensionId>(dimension),
            { level },
          ]),
        ),
        ...(options.reason === undefined ? {} : { reason: options.reason }),
        source: 'learn-surface',
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
   * Only the kinds a learner actually writes are accepted here. Anything else 鈥?evidence, synthesis, raw
   * notes 鈥?has its own lifecycle, and a surface that let a learner create all nine node types from one
   * text box would be teaching them the ontology instead of the subject.
   */
  async addNode(input: {
    readonly label: string
    readonly kind: 'claim' | 'concept' | 'question'
    readonly topic?: string
    readonly source?: string
    /** Supplied when the caller needs a stable id, such as a topic seeder that must be idempotent. */
    readonly id?: string
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
        tier: input.kind === 'concept' ? 'reference' : 'thought',
        ...(input.topic === undefined ? {} : { topic: input.topic }),
        ...(input.source === undefined ? {} : { source: input.source }),
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
   * `node_0_self_attention_cannot_tell_which_word_ca` 鈥?truncated mid-word and impractical to type. A
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
   * candidates instead of silently recording understanding against the wrong node 鈥?which would be a
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
    if (label === '') throw new Error('a node needs a label')

    const node = this.#episteme.graph.addNode({
      id: asId<NodeId>(input.id),
      type: input.type,
      label,
      properties: { text: label, ...input.properties },
      tags: learnTags(input.topic ?? 'general'),
      tier: input.tier,
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
      ...(source === undefined ? {} : { source }),
    })
    return { edgeId: edge.id }
  }

  /** Every node the learner can see, for an overview of their own graph. */
  listNodes(): readonly NodeView[] {
    return this.#episteme.graph.listNodes().map((node) => this.#view(node))
  }

  /** What the human understands about one node, for a detail panel. */
  understandingOf(
    target: NodeId | string,
  ): readonly { readonly id: string; readonly level: string }[] {
    const state = this.#episteme.log.stateOf(asId<NodeId>(target), HUMAN)
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
    if (this.#episteme.graph.getNode(id) === undefined) return undefined
    return this.#episteme.log.history({ target: id, actorId: HUMAN }).map(toSerializedEvent)
  }

  /** The open ends of this learner's lines of inquiry, so a surface can show where they left off. */
  openEnds(): readonly {
    readonly eventId: string
    readonly target: string
    readonly label: string
  }[] {
    return this.#episteme.log.tips(HUMAN).map((event) => ({
      eventId: event.id,
      target: event.target,
      label: this.#episteme.graph.getNode(event.target)?.label ?? event.target,
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
      const state = this.#episteme.log.stateOf(asId<NodeId>(node.nodeId), HUMAN)
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
    const run = this.#mutations.then(async () => {
      if (this.#closed)
        throw new Error('this session is closed; open a new one to change the graph')
      this.#revision += 1
      try {
        return await work()
      } finally {
        this.#revision += 1
      }
    })
    this.#mutations = run.then(
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
    from: { readonly proposedBy: string; readonly rationale: string },
  ): Promise<ProposeResult> {
    return this.#exclusive(async (): Promise<ProposeResult> => {
      // Checked inside the queue, against the graph as it is when the draft is kept.
      const refusal = this.#refusalOf(proposal, from)
      if (refusal !== undefined) return { ok: false, refusal }

      const suggestion = await this.#suggestions.add({
        proposal: normalized(proposal),
        rationale: from.rationale.trim(),
        proposedBy: from.proposedBy,
        proposedAt: systemClock.now(),
      })
      return { ok: true, suggestion }
    })
  }

  /** Every draft still waiting for the learner, oldest first. */
  pendingSuggestions(): readonly Suggestion[] {
    return this.#suggestions.list()
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
  ): Promise<DecisionResult> {
    // One decision at a time, from reading the draft to removing it: of two decisions on the same draft,
    // whichever is queued first wins, and the second finds it already decided.
    return this.#exclusive(() => this.#decideNow(suggestionId, decision, channel))
  }

  async #decideNow(
    suggestionId: string,
    decision: Decision,
    channel: DecisionChannel,
  ): Promise<DecisionResult> {
    // A decision on this draft that started before and was never settled (its write failed) is settled first,
    // so deciding again cannot commit a second time.
    const unsettled = this.#suggestions.resolutionOf(suggestionId)
    if (unsettled !== undefined) await this.#settle(unsettled)

    const suggestion = this.#suggestions.get(suggestionId)
    if (suggestion === undefined) {
      return {
        ok: false,
        refusal: {
          code: 'unknown_suggestion',
          message: `suggestion "${suggestionId}" is not pending; it may already have been decided`,
        },
      }
    }

    // One write of one file, so it needs no record of its own: it happened or it did not.
    if (decision.action === 'dismiss') {
      await this.#suggestions.remove(suggestion.id)
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
    await this.#suggestions.complete(operationId)
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
          .history({ target: asId<NodeId>(proposal.target), actorId: HUMAN })
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
      await this.#suggestions.complete(resolution.operationId)
      return { ...identify(resolution), settled: 'completed' }
    }
    await this.#suggestions.abandon(resolution.operationId)
    return { ...identify(resolution), settled: 'rolled_back' }
  }

  /** Decisions found unsettled when this session opened, and how each was settled. */
  get recovered(): readonly RecoveredDecision[] {
    return this.#recovered
  }

  /** Settles every decision a previous session left unfinished. Runs once, before the session is handed out. */
  async #recover(): Promise<void> {
    for (const resolution of this.#suggestions.resolutions()) {
      this.#recovered.push(await this.#settle(resolution))
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
    const source = `suggestion ${suggestion.id} from ${suggestion.proposedBy}, ${resolution.outcome} via ${resolution.channel} (${resolution.operationId})`
    switch (proposal.kind) {
      case 'state': {
        const value: StateValue = confirmed
          ? {
              level: proposal.level,
              authority: 'confirmed',
              confirmedBy: HUMAN,
              sourceOf: suggestion.id,
            }
          : { level: proposal.level, sourceOf: suggestion.id }
        const event = this.#episteme.log.commit({
          target: asId<NodeId>(proposal.target),
          actorId: HUMAN,
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
    const pending = this.#suggestions.get(id)
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
      if (this.#suggestions.get(id) !== undefined) {
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
    return this.#sources.list()
  }

  /**
   * Distils learning material into pending suggestions (ADR 0009). Changes no understanding.
   *
   * The material is kept beside the graph, never in it. It is split into episodes, and the distiller's
   * candidates are checked against the domain's policy. Each kept candidate then becomes a pending suggestion,
   * through the same checks `propose` applies, carrying the words it came from. A candidate that refers to
   * another, such as a claim answering a question found with it, refers to that suggestion as
   * `cand:<id>`, and can be accepted only after it. Nothing reaches the graph or the history until the
   * learner decides.
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
    } = {},
  ): Promise<DistillOutcome> {
    return this.#exclusive(async (): Promise<DistillOutcome> => {
      const text = material.text
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
      if (this.#suggestions.list().length >= MAX_PENDING) {
        return {
          ok: false,
          refusal: {
            code: 'too_many_pending',
            message: `${MAX_PENDING} suggestions are already waiting; decide on some before distilling more`,
          },
        }
      }

      const policy = options.policy ?? learnDistillationPolicy
      const agent = options.agent ?? new RuleBasedDistiller({ policy })
      const sourceId = `src_${randomUUID()}`
      const result = await distill({
        material: { sourceId, text },
        agent,
        policy,
        actorId: HUMAN,
        known: this.#episteme.graph
          .listNodes()
          .map((node) => ({ id: node.id, label: node.label, type: node.type })),
      })

      const proposedBy = `actor_agent_${agent.id}`
      const refused: DistillRefusal[] = []
      const accepted: {
        ref: string
        proposal: Proposal
        origin: SuggestionOrigin
        rationale: string
      }[] = []
      const candidates = new Map<string, number>()
      const refer = (end: string): string | undefined => {
        if (!end.startsWith(CANDIDATE_PREFIX)) return end
        const index = candidates.get(end.slice(CANDIDATE_PREFIX.length))
        return index === undefined ? undefined : `${SUGGESTED_NODE_PREFIX}#${index}`
      }

      for (const candidate of result.candidates) {
        const origin: SuggestionOrigin = candidate.origin
        if (candidate.status === 'refused') {
          refused.push({
            ref: candidate.ref,
            ...(candidate.refusal ?? { code: 'refused', message: '' }),
            origin,
          })
          continue
        }
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
            ref: candidate.ref,
            code: 'depends_on_refused',
            message: 'it depends on a candidate that was not kept',
            origin,
          })
          continue
        }
        for (const proposal of proposals) {
          if (suggestion.kind === 'node') candidates.set(candidate.ref, accepted.length)
          accepted.push({ ref: candidate.ref, proposal, origin, rationale: suggestion.rationale })
        }
      }

      // The same checks `propose` applies, with references to this batch's own nodes standing in for nodes.
      const kept: typeof accepted = []
      const keptIndex = new Map<number, number>()
      for (const [index, item] of accepted.entries()) {
        const local = localReferences(item.proposal)
        const brokenReference = local.some((reference) => !keptIndex.has(reference))
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
      const waiting = this.#suggestions.list().length
      if (waiting + kept.length > MAX_PENDING) {
        return {
          ok: false,
          refusal: {
            code: 'too_many_pending',
            message: `${waiting} suggestions are waiting, and this material would add ${kept.length}, more than the ${MAX_PENDING} the queue holds; decide on some first, or distil less at once`,
          },
        }
      }

      await this.#sources.add({
        id: sourceId,
        title: material.title?.trim() || firstLine(text),
        text,
        kind: result.episodes[0]?.kind ?? 'prose',
        episodes: result.episodes.map((episode) => ({
          id: episode.id,
          span: episode.span,
          ...(episode.time === undefined ? {} : { time: episode.time }),
        })),
        addedAt: systemClock.now(),
        ...(options.requestedBy === undefined ? {} : { requestedBy: options.requestedBy }),
      })

      const proposedAt = systemClock.now()
      const suggestions = await this.#suggestions.addAll(kept.length, (ids) =>
        kept.map((item) => ({
          proposal: bindLocalReferences(item.proposal, (reference) => {
            const at = keptIndex.get(reference)
            return at === undefined ? undefined : ids[at]
          }),
          rationale: item.rationale,
          proposedBy,
          proposedAt,
          origin: item.origin,
          ...(options.requestedBy === undefined ? {} : { requestedBy: options.requestedBy }),
        })),
      )
      return { ok: true, sourceId, episodes: result.episodes.length, suggestions, refused }
    })
  }

  /** Why a proposal could never be accepted, or `undefined` when it could be. */
  #refusalOf(
    proposal: Proposal,
    from: { readonly proposedBy: string; readonly rationale: string },
  ): MutationRefusal | undefined {
    if (from.rationale.trim() === '') {
      return { code: 'missing_rationale', message: 'a suggestion must say why it is proposed' }
    }
    if (from.proposedBy.trim() === '' || from.proposedBy === HUMAN) {
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
        : this.#episteme.graph.getNode(asId<NodeId>(id)) === undefined
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
          tags: learnTags('general'),
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
          tags: learnTags('general'),
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
        const dimension = RECORDABLE_DIMENSIONS.find(
          (candidate) => candidate.id === proposal.dimension,
        )
        if (dimension === undefined) {
          return {
            code: 'unregistered_dimension',
            message: `"${proposal.dimension}" is not a dimension the learner records. Available: ${RECORDABLE_DIMENSIONS.map((d) => d.id).join(', ')}`,
          }
        }
        if (!dimension.levels.includes(proposal.level)) {
          return {
            code: 'invalid_dimension_value',
            message: `"${proposal.level}" is not a level of ${dimension.id}. Available: ${dimension.levels.join(', ')}`,
          }
        }
        return undefined
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
      this.#closed = true
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
export type DecisionChannel = 'learn-review' | 'mcp-elicitation'

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

export type ProposeResult =
  | { readonly ok: true; readonly suggestion: Suggestion }
  | { readonly ok: false; readonly refusal: MutationRefusal }

/** Material longer than this is split by the learner before it is distilled. */
export const MAX_MATERIAL = 20_000
/** A queue holding this many suggestions takes no more distillations until some are decided. */
export const MAX_PENDING = 500

/** A candidate distillation found and did not offer, with why, and the words it came from. */
export interface DistillRefusal {
  readonly ref: string
  readonly code: string
  readonly message: string
  readonly origin: SuggestionOrigin
}

export type DistillOutcome =
  | {
      readonly ok: true
      readonly sourceId: string
      readonly episodes: number
      /** What now waits for the learner. */
      readonly suggestions: readonly Suggestion[]
      readonly refused: readonly DistillRefusal[]
    }
  | { readonly ok: false; readonly refusal: MutationRefusal }

/** The property under which an accepted node records the suggestion it came from. */
const PROVENANCE_KEY = 'suggestion'

/** What an accepted node keeps of its suggestion: which one it was, and the words it came from. */
function provenanceOf(suggestion: Suggestion): Record<string, unknown> {
  return {
    [PROVENANCE_KEY]: suggestion.id,
    ...(suggestion.origin === undefined ? {} : { origin: suggestion.origin }),
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
