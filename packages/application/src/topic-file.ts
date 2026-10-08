import { readFile } from 'node:fs/promises'
import { EDGE, NODE } from '@episteme/domain-learn'
import type { SeedTopic } from './seed.js'

/**
 * A learner's own starting topic, loaded from a JSON file.
 *
 * The seeded transformer topic is a demonstration; a learner working on chemistry should not have to read
 * about attention heads to understand the interface. This lets the surface start from the material they are
 * actually working with, without a code change and without a build step.
 *
 * ## Format
 *
 * ```json
 * {
 *   "title": "有机化学：反应机理",
 *   "about": "从电子推动看反应为什么这样发生。",
 *   "source": "textbook:clayden",
 *   "nodes": [
 *     { "label": "亲核取代（SN2）" },
 *     { "label": "离去基团" },
 *     { "label": "为什么 SN2 会发生构型翻转？", "kind": "question" }
 *   ]
 * }
 * ```
 *
 * `kind` is `concept` (default), `question` or `claim`. A claim here is material the learner is *given*, so
 * it is seeded at `reference` tier rather than `thought` — the tier decides whether a node counts as the
 * learner's own understanding, and seeding an authored claim as `thought` would put words in their mouth.
 * Nodes carry no cognitive state: nothing here can tell a learner what they understand.
 *
 * Validation is strict and loud. A malformed topic file is a mistake the learner can see and fix; skipping
 * a line would leave them looking at a graph that silently disagrees with the file they wrote.
 */

interface TopicFileNode {
  readonly label?: unknown
  readonly kind?: unknown
  readonly source?: unknown
}

interface TopicFile {
  readonly title?: unknown
  readonly about?: unknown
  readonly source?: unknown
  readonly nodes?: unknown
}

const KINDS = ['concept', 'question', 'claim'] as const
type TopicKind = (typeof KINDS)[number]

/** A stable, readable id derived from the label, so reusing a topic file is idempotent. */
function topicNodeId(kind: TopicKind, label: string, index: number): string {
  const slug = label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 32)
  return `${kind}_${slug === '' ? index : slug}`
}

/** Reads and validates a topic file. Throws with the offending value, rather than guessing. */
export async function loadTopicFile(path: string): Promise<SeedTopic> {
  const text = await readFile(path, 'utf8')

  let parsed: TopicFile
  try {
    parsed = JSON.parse(text) as TopicFile
  } catch (error) {
    throw new Error(`主题文件不是合法 JSON：${(error as Error).message}`, { cause: error })
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('主题文件的最外层必须是一个对象')
  }
  if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
    throw new TypeError('主题文件需要一个非空的 "nodes" 数组')
  }

  const concepts: { id: string; label: string }[] = []
  const questions: { id: string; label: string }[] = []
  const claims: { id: string; label: string }[] = []
  const source = typeof parsed.source === 'string' ? parsed.source : `file:${path}`

  parsed.nodes.forEach((raw: unknown, index: number) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new TypeError(`nodes[${index}] 必须是一个对象`)
    }
    const node = raw as TopicFileNode
    if (typeof node.label !== 'string' || node.label.trim() === '') {
      throw new TypeError(`nodes[${index}].label 必须是非空字符串`)
    }
    const kind = node.kind === undefined ? 'concept' : node.kind
    if (typeof kind !== 'string' || !KINDS.includes(kind as TopicKind)) {
      throw new TypeError(
        `nodes[${index}].kind 必须是 ${KINDS.join(' / ')} 之一，收到 ${JSON.stringify(node.kind)}`,
      )
    }

    const label = node.label.trim()
    const entry = { id: topicNodeId(kind as TopicKind, label, index), label }
    if (kind === 'question') questions.push(entry)
    else if (kind === 'claim') claims.push(entry)
    else concepts.push(entry)
  })

  const title =
    typeof parsed.title === 'string' && parsed.title.trim() !== ''
      ? parsed.title.trim()
      : '你的主题'

  return {
    id: `topic:file:${title}`,
    title,
    about:
      typeof parsed.about === 'string' && parsed.about.trim() !== ''
        ? parsed.about.trim()
        : '从你自己带来的一份材料开始。',
    source,
    concepts,
    questions,
    claims,
    edges: [],
  }
}

/**
 * A topic with nothing in it, for a learner who wants to start from a blank graph.
 *
 * Not the same as "no topic file": this is an explicit choice to begin empty, and the surface says so rather
 * than looking as though seeding failed.
 */
export const BLANK_TOPIC: SeedTopic = {
  id: 'topic:blank',
  title: '空白的图谱',
  about: '你还什么都没有加进来。写下你自己的第一个论断，或者给 --topic 一份材料。',
  source: 'session:blank',
  concepts: [],
  questions: [],
  claims: [],
  edges: [],
}

/** The node types a topic file may ask for, exposed so nothing else invents the mapping. */
export const TOPIC_NODE_TYPES: Readonly<Record<TopicKind, string>> = {
  concept: NODE.concept,
  question: NODE.question,
  claim: NODE.claim,
}

export { EDGE }
