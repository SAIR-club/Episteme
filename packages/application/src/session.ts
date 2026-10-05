import {
  DeterministicEmbeddingAdapter,
  InMemoryEmbeddingCache,
  asId,
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
import { SuggestionStore, type Proposal, type Suggestion } from './suggestions.js'
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

export interface AskResult {
  readonly question: string
  readonly answer: string
  /** Whether the answer was shaped by recorded prior understanding. Data, not prose. */
  readonly usedContext: boolean
  readonly retriever: string
  readonly summary: string
  readonly known: readonly UnderstandingView[]
  readonly ranked: readonly RankedView[]
  readonly rules: readonly RankRule[]
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
  #saveChain: Promise<void> = Promise.resolve()

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
    return new LearnSession(
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
    const context = await retrieveWith(
      this.#retriever,
      this.#episteme.graph,
      this.#episteme.log,
      question,
      { actorId: HUMAN, depth: 1, limit: 8 },
    )

    const response = await this.#agent.respond({ text: question }, toAgentContext(context))

    return {
      question,
      answer: response.text,
      usedContext: response.usedContext,
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

    await this.flush()

    return {
      eventId: event.id,
      recorded: entries.map(([id, level]) => ({ id, level })),
    }
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
    const node = this.addNodeSync({
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
    await this.flush()
    return node
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
    return `${prefix}${highest + 1}`
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
   * The unflushed half of `addNode`.
   *
   * Exists so a batch 鈥?seeding a topic 鈥?is one write rather than one write per node. Callers that use it
   * must `flush()` themselves; every path in this file that does is listed next to its `flush()` call.
   */
  addNodeSync(input: {
    readonly id: string
    readonly label: string
    readonly type: Parameters<Episteme['graph']['addNode']>[0]['type']
    readonly tier: 'draft' | 'thought' | 'reference'
    readonly topic?: string
    readonly source?: string
  }): NodeView {
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
    const edge = this.linkSync(from, to, type, id)
    await this.flush()
    return edge
  }

  /** The unflushed half of `link`. See `addNodeSync`. */
  linkSync(
    from: string,
    to: string,
    type: Parameters<Episteme['graph']['addEdge']>[0]['type'] = EDGE.refersTo,
    id?: string,
  ): { readonly edgeId: string } {
    const edge = this.#episteme.graph.addEdge({
      id: asId<EdgeId>(id ?? `edge_${this.#episteme.log.eventCount}_${slug(from)}_${slug(to)}`),
      type,
      from: asId<NodeId>(from),
      to: asId<NodeId>(to),
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

  /**
   * Writes the history through the store, if there is one.
   *
   * Serialised behind a promise chain because two concurrent callers could otherwise interleave a read of
   * the log with a partial write of the file. `LocalStorageAdapter.save` is already atomic per write; this
   * keeps the *sequence* ordered too.
   */
  flush(): Promise<void> {
    const next = this.#saveChain.then(() => this.#persistNow())
    // The chain must survive a failed write without becoming permanently rejected, while the caller still
    // sees the failure.
    this.#saveChain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
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
    const refusal = this.#refusalOf(proposal, from)
    if (refusal !== undefined) return { ok: false, refusal }

    const suggestion = await this.#suggestions.add({
      proposal,
      rationale: from.rationale.trim(),
      proposedBy: from.proposedBy,
      proposedAt: systemClock.now(),
    })
    return { ok: true, suggestion }
  }

  /** Every draft still waiting for the learner, oldest first. */
  pendingSuggestions(): readonly Suggestion[] {
    return this.#suggestions.list()
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
        const preview = this.#episteme.graph.previewEdge({
          id: asId<EdgeId>(`edge_proposed_${slug(proposal.from)}_${slug(proposal.to)}`),
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
  async close(): Promise<void> {
    await this.flush()
    await this.#store?.close()
  }

  async #persistNow(): Promise<void> {
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

export type ProposeResult =
  | { readonly ok: true; readonly suggestion: Suggestion }
  | { readonly ok: false; readonly refusal: MutationRefusal }

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

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '_')
      .replace(/^_+|_+$/gu, '')
      .slice(0, 40) || 'node'
  )
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
