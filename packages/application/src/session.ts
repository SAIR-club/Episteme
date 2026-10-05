import { randomUUID } from 'node:crypto'
import {
  DeterministicEmbeddingAdapter,
  InMemoryEmbeddingCache,
  asId,
  isEpistemeError,
  systemClock,
  type ActorId,
  type DimensionId,
  type EdgeId,
  type EdgeTypeId,
  type MutationRefusal,
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
import { SuggestionStore, type Proposal, type Resolution, type Suggestion } from './suggestions.js'
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
  /** The tail of the mutation queue. See `#exclusive`. */
  #mutations: Promise<unknown> = Promise.resolve()
  #closed = false
  readonly #recovered: RecoveredDecision[] = []

  private constructor(
    episteme: Episteme,
    retriever: Retriever,
    suggestions: SuggestionStore,
    store?: Store,
  ) {
    this.#episteme = episteme
    this.#retriever = retriever
    this.#suggestions = suggestions
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
      )
    }

    const storage = await openLocalStorage(options.filePath)
    let episteme: Episteme
    let suggestions: SuggestionStore
    try {
      episteme = await openEpisteme(storage, { actors, actorId: HUMAN })
      // Opened only after the graph's lock is held, so the drafts have the same single owner as the graph.
      suggestions = await SuggestionStore.open(suggestionsPathFor(options.filePath))
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
  #nextId(kind: 'claim' | 'concept' | 'question'): string {
    const prefix = `${kind}_`
    let highest = 0
    for (const node of this.#episteme.graph.listNodes()) {
      if (!node.id.startsWith(prefix)) continue
      const suffix = Number.parseInt(node.id.slice(prefix.length), 10)
      if (Number.isFinite(suffix) && suffix > highest) highest = suffix
    }
    // `listNodes` leaves out revoked nodes, but their ids are still taken.
    let next = highest + 1
    while (this.#episteme.graph.getNode(asId<NodeId>(`${prefix}${next}`)) !== undefined) next += 1
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
      properties: { text: label },
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
    const run = this.#mutations.then(() => {
      if (this.#closed)
        throw new Error('this session is closed; open a new one to change the graph')
      return work()
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

    const proposal = normalized(
      decision.action === 'accept' ? suggestion.proposal : decision.proposal,
    )
    if (proposal.kind !== suggestion.proposal.kind) {
      return {
        ok: false,
        refusal: {
          code: 'kind_changed',
          message: `a ${suggestion.proposal.kind} suggestion can only be modified into another ${suggestion.proposal.kind}`,
        },
      }
    }
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
      case 'claim': {
        const node = this.#addNodeNow({
          id: planned.nodeId ?? this.#nextId('claim'),
          label: proposal.label,
          type: NODE.claim,
          tier: 'thought',
          source,
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
    const missing = (id: string): MutationRefusal | undefined =>
      this.#episteme.graph.getNode(asId<NodeId>(id)) === undefined
        ? { code: 'unknown_node', message: `node "${id}" does not exist` }
        : undefined

    switch (proposal.kind) {
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

/** A node to add, as a batch or an addition gives it. */
export interface NodeInput {
  readonly id: string
  readonly label: string
  readonly type: Parameters<Episteme['graph']['addNode']>[0]['type']
  readonly tier: 'draft' | 'thought' | 'reference'
  readonly topic?: string
  readonly source?: string
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
