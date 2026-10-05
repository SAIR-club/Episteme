import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asId, type ActorId, type DimensionId, type EdgeId, type NodeId } from '@episteme/core'
import {
  DIMENSION,
  EDGE,
  NODE,
  contextSummary,
  learnerResponder,
  learnTags,
  retrieveRelevantContext,
  toAgentContext,
} from '@episteme/domain-learn'
import { MockCognitiveAgent } from '@episteme/agent'
import { agentActor, humanActor, openEpisteme, type Episteme } from '@episteme/sdk'
import { openLocalStorage } from '@episteme/storage-local'

/**
 * Session 1 and session 2 do not share a running instance.
 *
 * `runSessionOne` returns only a file path. `runSessionTwo` builds its own adapter, its own graph and
 * its own event log from that file, with an empty in-memory state. That is the whole claim being
 * demonstrated: if any cognition lived only in a variable, session 2 would come back with nothing.
 *
 * To be explicit about what this is and is not: both sessions run inside one Node process here, because
 * a demo that spawns a child process is harder to read. The separation that matters is that no object
 * is carried between them — the *instance* is rebuilt from disk. `tests/restart-recovery.test.ts`
 * makes the same point with a second adapter object, and `node dist/main.js` genuinely starts a new
 * process each time you run it.
 */

const QUESTION = 'Then why does RoPE work?'
const CLAIM_ID = asId<NodeId>('claim_order')
const CLAIM_TEXT = 'Self-attention alone does not encode sequence order.'

export interface SessionStep {
  readonly title: string
  readonly lines: readonly string[]
}

export interface PersistentDemoResult {
  readonly steps: readonly SessionStep[]
  readonly filePath: string
  readonly answerWithoutMemory: string
  readonly answerFromMemory: string
}

function seedConcepts(episteme: Episteme): void {
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
  concept('c_rope', 'RoPE', 'rope')
}

/** Asks a question against whatever this instance currently knows, and returns the answer. */
async function ask(
  episteme: Episteme,
  question: string,
): Promise<{ text: string; used: boolean; summary: string }> {
  const retrieved = await retrieveRelevantContext(episteme.graph, episteme.log, question, {
    actorId: episteme.actorId,
    depth: 1,
  })
  const agent = new MockCognitiveAgent({ responder: learnerResponder })
  const response = await agent.respond({ text: question }, toAgentContext(retrieved))
  return {
    text: response.text,
    used: response.usedContext,
    summary: contextSummary(retrieved),
  }
}

/** Session 1: ask, form a claim, record it, explore a second line, then persist and stop. */
export async function runSessionOne(filePath: string): Promise<SessionStep[]> {
  const steps: SessionStep[] = []
  const storage = await openLocalStorage(filePath)
  const episteme = await openEpisteme(storage, {
    actors: [humanActor(asId<ActorId>('actor_human')), agentActor(asId<ActorId>('actor_scaffold'))],
  })

  seedConcepts(episteme)

  // The agent is asked before anything is understood, so the contrast is visible in one run.
  const cold = await ask(episteme, QUESTION)
  steps.push({
    title: 'Session 1 · the question, before anything is recorded',
    lines: [
      `Stored history: ${episteme.log.eventCount} event(s)`,
      `Prior understanding: ${cold.summary}`,
      `Agent (usedContext=${cold.used}): ${cold.text}`,
    ],
  })

  episteme.graph.addNode({
    id: asId<NodeId>('q_positional'),
    type: NODE.question,
    label: 'Why does Transformer need positional encoding?',
    properties: { text: 'Why does Transformer need positional encoding?' },
    tags: learnTags('transformer'),
    tier: 'thought',
    source: 'session:1',
  })

  episteme.graph.addNode({
    id: CLAIM_ID,
    type: NODE.claim,
    label: CLAIM_TEXT,
    properties: { text: CLAIM_TEXT },
    // Tagged under both topics so a later question about RoPE reaches it through the graph.
    tags: [...learnTags('transformer'), 'topic:rope'],
    tier: 'thought',
    source: 'session:1',
  })
  episteme.graph.addEdge({
    id: asId<EdgeId>('e_claim_refers_attention'),
    type: EDGE.refersTo,
    from: CLAIM_ID,
    to: asId<NodeId>('c_self_attention'),
  })

  const event = episteme.log.commit({
    target: CLAIM_ID,
    actorId: episteme.actorId,
    dimensions: new Map([
      [asId<DimensionId>(DIMENSION.confidence), { level: 'high' }],
      [asId<DimensionId>(DIMENSION.articulation), { level: 'medium' }],
      [asId<DimensionId>(DIMENSION.evidence), { level: 'reproduced' }],
    ]),
    reason: 'derived why attention cannot represent order on its own',
    source: 'session:1',
  })

  // A second line of inquiry, forked from the claim's own event, so lineage has something to restore.
  const forked = episteme.log.fork({
    from: event.id,
    target: CLAIM_ID,
    actorId: episteme.actorId,
    dimensions: new Map([[asId<DimensionId>(DIMENSION.conflict), { level: 'open' }]]),
    reason: 'relative position may answer this without absolute indices',
    source: 'session:1',
  })

  steps.push({
    title: 'Session 1 · the learner forms an understanding and records it',
    lines: [
      `Claim: ${CLAIM_TEXT}`,
      `StateEvent ${event.id} on branch ${event.branchId} → confidence=high, articulation=medium`,
      `Forked ${forked.event.id} on branch ${forked.branch.id}, continuing ${event.id}`,
      `Open ends for this learner: ${episteme.log.tips(episteme.actorId).length}`,
    ],
  })

  await episteme.persist()
  await storage.save()
  // Stopping gives up the graph, so the next session can own it.
  await storage.close()

  steps.push({
    title: 'Session 1 · writing to disk and stopping',
    lines: [
      `Persisted to ${filePath}`,
      'The event history and the graph are on disk; reduced state was not written, because it is derived.',
    ],
  })

  return steps
}

/** Session 2: a fresh instance over the same file, with no in-memory state carried over. */
export async function runSessionTwo(filePath: string): Promise<{
  steps: readonly SessionStep[]
  answerWithoutMemory: string
  answerFromMemory: string
}> {
  const steps: SessionStep[] = []

  // An instance over the *same file name* that was never written to, to show what the answer looks
  // like with no memory at all. Without this the contrast would have to be taken on trust.
  const emptyPath = join(filePath, '..', 'never-written.jsonl')
  const emptyInstance = await openEpisteme(await openLocalStorage(emptyPath), {
    actors: [humanActor(asId<ActorId>('actor_human'))],
  })
  seedConcepts(emptyInstance)
  const withoutMemory = await ask(emptyInstance, QUESTION)

  // A second adapter, built from scratch. Nothing is carried over from session 1.
  const storage = await openLocalStorage(filePath)
  const episteme = await openEpisteme(storage, {
    actors: [humanActor(asId<ActorId>('actor_human')), agentActor(asId<ActorId>('actor_scaffold'))],
  })

  const state = episteme.log.stateOf(CLAIM_ID, episteme.actorId)
  const levels = [...state.entries()]
    .map(([dimension, value]) => `${dimension}=${value.level}`)
    .join(', ')

  const currentBranch = episteme.log.currentBranch(episteme.actorId)

  steps.push({
    title: 'Session 2 · a new instance, built from the file',
    lines: [
      `Reloaded ${episteme.log.eventCount} event(s)`,
      `Reduced state of the claim: ${levels}`,
      `Open ends restored: ${episteme.log.tips(episteme.actorId).length}`,
      `Branch lineage: ${episteme.log.branchAncestry(currentBranch.id).join(' → ')}`,
      `The fork point of ${currentBranch.id} is still recorded: ${String(currentBranch.forkPoint)}`,
    ],
  })

  const fromMemory = await ask(episteme, QUESTION)

  steps.push({
    title: 'Session 2 · the same question, answered from the restored understanding',
    lines: [
      `Prior understanding: ${fromMemory.summary}`,
      `Agent (usedContext=${fromMemory.used}): ${fromMemory.text}`,
    ],
  })

  steps.push({
    title: 'Session 2 · the difference is the point',
    lines: [
      `without persisted memory: ${withoutMemory.text}`,
      `with persisted memory:    ${fromMemory.text}`,
      `identical response? ${withoutMemory.text === fromMemory.text}`,
      'Same question, same agent, same code — the memory came from disk.',
    ],
  })

  await rm(emptyPath, { force: true })

  return {
    steps,
    answerWithoutMemory: withoutMemory.text,
    answerFromMemory: fromMemory.text,
  }
}

/** Runs both sessions against one throwaway file and returns the whole narrative. */
export async function runPersistentDemo(): Promise<PersistentDemoResult> {
  const directory = await mkdtemp(join(tmpdir(), 'episteme-demo-'))
  const filePath = join(directory, 'graph.jsonl')
  try {
    const first = await runSessionOne(filePath)
    const second = await runSessionTwo(filePath)
    return {
      steps: [...first, ...second.steps],
      filePath,
      answerWithoutMemory: second.answerWithoutMemory,
      answerFromMemory: second.answerFromMemory,
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export function formatPersistentDemo(result: PersistentDemoResult): string {
  const blocks = result.steps.map((step) => {
    const body = step.lines.map((line) => `   ${line}`).join('\n')
    return `${step.title}\n${body}`
  })
  return blocks.join('\n\n')
}
