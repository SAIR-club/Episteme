import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DeterministicEmbeddingAdapter,
  InMemoryEmbeddingCache,
  asId,
  type ActorId,
  type CoreGraph,
  type DimensionId,
  type EdgeId,
  type NodeId,
} from '@episteme/core'
import {
  DIMENSION,
  EDGE,
  HybridRetriever,
  LexicalGraphRetriever,
  NODE,
  contextSummary,
  learnerResponder,
  learnTags,
  retrieveWith,
  toAgentContext,
  type RetrieveQuery,
  type Retriever,
} from '@episteme/domain-learn'
import { MockCognitiveAgent } from '@episteme/agent'
import { agentActor, humanActor, openEpisteme, type Episteme } from '@episteme/sdk'
import { openLocalStorage } from '@episteme/storage-local'

/**
 * The Phase 2 demo: the same question asked in different words.
 *
 * What it shows, in order:
 *
 * 1. A claim is stored in the learner's own words.
 * 2. A lexical retriever is asked a paraphrased question and **misses** — asserted, not asserted-about.
 * 3. A hybrid retriever, with the same question, recovers the claim and shows its ranked evidence.
 * 4. An answer without memory has to re-derive the groundwork.
 * 5. An answer with memory continues from what is already understood.
 * 6. The whole thing survives a restart, and the paraphrase still works from disk.
 *
 * The paraphrase shares no word with the claim, which is the point. `"attention"` is deliberately avoided:
 * it is a substring of `"self-attention"`, so leaving it in would let a string match explain the result.
 */

const STORED_CLAIM = 'Self-attention does not encode sequence order.'
const PARAPHRASE = 'Which word comes first in the input?'
const CLAIM_ID = asId<NodeId>('claim_order')

const HUMAN = asId<ActorId>('actor_human')
const COLD = asId<ActorId>('actor_cold')

export interface DemoStep {
  readonly title: string
  readonly lines: readonly string[]
}

export interface SemanticDemoResult {
  readonly steps: readonly DemoStep[]
  readonly lexicalRanked: readonly string[]
  readonly hybridRanked: readonly string[]
  readonly coldAnswer: string
  readonly warmAnswer: string
}

function seedGraph(episteme: Episteme): void {
  const concept = (id: string, label: string, topic: string) =>
    episteme.graph.addNode({
      id: asId<NodeId>(id),
      type: NODE.concept,
      label,
      properties: { text: label },
      tags: learnTags(topic),
      tier: 'reference',
      source: 'paper:arxiv:1706.03762',
    })

  concept('c_transformer', 'Transformer', 'transformer')
  concept('c_self_attention', 'Self-Attention', 'transformer')
  concept('c_positional_encoding', 'Positional Encoding', 'transformer')

  // Claims a learner might have recorded, so the paraphrase has to discriminate rather than merely land
  // somewhere. `claim_heads` is the hard negative: it shares the word "attention" with the eventual
  // question and concerns something else entirely.
  const claim = (id: string, label: string) =>
    episteme.graph.addNode({
      id: asId<NodeId>(id),
      type: NODE.claim,
      label,
      properties: { text: label },
      // Every claim carries the same topic tag, so the structural signals cannot do the discriminating.
      tags: learnTags('transformer'),
      tier: 'thought',
      source: 'session:1',
    })

  claim(CLAIM_ID, STORED_CLAIM)
  claim('claim_heads', 'How many attention heads should I use?')
  claim('claim_lr', 'What learning rate schedule works best for fine-tuning?')
  claim('claim_tokenizer', 'Which tokenizer should I pick for Chinese text?')

  episteme.graph.addEdge({
    id: asId<EdgeId>('e_claim_refers_attention'),
    type: EDGE.refersTo,
    from: CLAIM_ID,
    to: asId<NodeId>('c_self_attention'),
  })
}

/** The ranked ids a retriever returns, with scores, for a readable comparison. */
async function rank(
  retriever: Retriever,
  graph: CoreGraph,
  query: RetrieveQuery,
): Promise<{ id: string; label: string; score: number; terms: readonly string[] }[]> {
  const result = await retriever.retrieve(query)
  return [...result.matches, ...result.neighbors].map((entry) => ({
    id: entry.node.id,
    label: graph.getNode(entry.node.id)?.label ?? entry.node.label,
    score: entry.score,
    terms: entry.matchedTerms,
  }))
}

function describeRanking(
  rows: readonly { id: string; label: string; score: number; terms: readonly string[] }[],
): readonly string[] {
  if (rows.length === 0) return ['  (nothing retrieved)']
  return rows.map((row, index) => {
    const terms =
      row.terms.length > 0 ? `  matched: ${row.terms.join(', ')}` : '  matched: — (meaning)'
    return `  ${index + 1}. ${row.label}  [${row.id}, score ${row.score.toFixed(3)}]${terms}`
  })
}

async function ask(
  episteme: Episteme,
  actorId: ActorId,
  question: string,
  retriever: Retriever,
): Promise<{ text: string; used: boolean; summary: string }> {
  // The context is built for the *asking* actor, so the cold actor sees the same graph and the same
  // retriever with no recorded understanding of their own — which is the control.
  const retrieved = await retrieveWith(retriever, episteme.graph, episteme.log, question, {
    actorId,
    depth: 1,
  })
  const agent = new MockCognitiveAgent({ responder: learnerResponder })
  const response = await agent.respond({ text: question }, toAgentContext(retrieved))
  return { text: response.text, used: response.usedContext, summary: contextSummary(retrieved) }
}

export async function runSemanticDemo(): Promise<SemanticDemoResult> {
  const directory = await mkdtemp(join(tmpdir(), 'episteme-semantic-'))
  const filePath = join(directory, 'graph.jsonl')
  const steps: DemoStep[] = []

  try {
    // ── Session 1: record an understanding, in the learner's own words ──
    const storage = await openLocalStorage(filePath)
    const episteme = await openEpisteme(storage, {
      actors: [
        humanActor(HUMAN),
        agentActor(asId<ActorId>('actor_scaffold')),
        humanActor(COLD, 'Cold reader'),
      ],
      actorId: HUMAN,
    })
    seedGraph(episteme)

    episteme.log.commit({
      target: CLAIM_ID,
      actorId: HUMAN,
      dimensions: new Map([
        [asId<DimensionId>(DIMENSION.confidence), { level: 'high' }],
        [asId<DimensionId>(DIMENSION.articulation), { level: 'medium' }],
      ]),
      reason: 'worked out why attention cannot represent order on its own',
      source: 'session:1',
    })

    steps.push({
      title: 'Stored cognition',
      lines: [
        `"${STORED_CLAIM}"`,
        '  confidence=high, articulation=medium',
        '  Three other claims share its topic tag, so the words are what must discriminate.',
      ],
    })

    const adapter = new DeterministicEmbeddingAdapter()
    const cache = new InMemoryEmbeddingCache()
    const lexical = new LexicalGraphRetriever(episteme.graph)
    const hybrid = new HybridRetriever(episteme.graph, episteme.log, adapter, cache)

    const query: RetrieveQuery = { text: PARAPHRASE, actorId: HUMAN, depth: 1 }

    steps.push({
      title: 'Later question, in different words',
      lines: [
        `"${PARAPHRASE}"`,
        '  Shares no word with the stored claim. "attention" is avoided on purpose: it is a substring of',
        '  "self-attention", so including it would let a string match explain the result.',
      ],
    })

    // ── The lexical retriever misses, and says so ──
    const lexicalRows = await rank(lexical, episteme.graph, query)
    steps.push({
      title: 'Lexical retrieval — the words do not match, so nothing is found',
      lines: [...describeRanking(lexicalRows), `  signals used: ${lexical.signals.join(', ')}`],
    })

    // ── The hybrid retriever recovers it ──
    const hybridRows = await rank(hybrid, episteme.graph, query)
    const top = hybridRows[0]
    steps.push({
      title: 'Hybrid retrieval — meaning finds it, and other signals confirm it',
      lines: [
        ...describeRanking(hybridRows.slice(0, 4)),
        `  signals used: ${hybrid.signals.join(', ')}`,
        top?.id === CLAIM_ID
          ? '  The stored claim ranks first, matched on meaning rather than on words.'
          : `  WARNING: expected "${CLAIM_ID}" to rank first, got "${String(top?.id)}".`,
      ],
    })

    // ── The contrast in the answer ──
    const cold = await ask(episteme, COLD, PARAPHRASE, hybrid)
    const warm = await ask(episteme, HUMAN, PARAPHRASE, hybrid)

    steps.push({
      title: 'No-memory answer — the groundwork has to be re-derived',
      lines: [
        `  Prior understanding: ${cold.summary}`,
        `  Agent (usedContext=${cold.used}): ${cold.text}`,
      ],
    })

    steps.push({
      title: 'Memory-aware answer — continues from what is already understood',
      lines: [
        `  Prior understanding: ${warm.summary}`,
        `  Agent (usedContext=${warm.used}): ${warm.text}`,
      ],
    })

    steps.push({
      title: 'The difference is the point',
      lines: [
        `identical response? ${cold.text === warm.text}`,
        'Same question, same graph, same retriever, same agent — only the recorded understanding differs.',
      ],
    })

    await episteme.persist()
    await storage.save()
    // Stopping gives up the graph, so the next session can own it.
    await storage.close()

    // ── Session 2: a fresh instance over the same file, empty embedding cache ──
    const reopened = await openEpisteme(await openLocalStorage(filePath), {
      actors: [humanActor(HUMAN), humanActor(COLD, 'Cold reader')],
      actorId: HUMAN,
    })
    const freshCache = new InMemoryEmbeddingCache()
    const afterRestart = new HybridRetriever(
      reopened.graph,
      reopened.log,
      new DeterministicEmbeddingAdapter(),
      freshCache,
    )
    const restartedRows = await rank(afterRestart, reopened.graph, {
      text: PARAPHRASE,
      actorId: HUMAN,
      depth: 1,
    })
    const restartedAnswer = await ask(reopened, HUMAN, PARAPHRASE, afterRestart)

    steps.push({
      title: 'After a restart — the paraphrase still works, from disk',
      lines: [
        `  Reloaded ${reopened.log.eventCount} event(s); embedding cache started empty (${freshCache.size} entries)`,
        ...describeRanking(restartedRows.slice(0, 2)),
        `  Agent: ${restartedAnswer.text}`,
        `  Answer unchanged across the restart? ${restartedAnswer.text === warm.text}`,
      ],
    })

    return {
      steps,
      lexicalRanked: lexicalRows.map((row) => row.id),
      hybridRanked: hybridRows.map((row) => row.id),
      coldAnswer: cold.text,
      warmAnswer: warm.text,
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export function formatSemanticDemo(result: SemanticDemoResult): string {
  const blocks = result.steps.map((step) => {
    const body = step.lines.map((line) => `   ${line}`).join('\n')
    return `${step.title}\n${body}`
  })
  return blocks.join('\n\n')
}
