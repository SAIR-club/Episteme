import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearnSession } from '@episteme/application'
import { seedTopic, TRANSFORMERS } from '@episteme/app-learn/seed'
import { BLANK_TOPIC, loadTopicFile } from '@episteme/app-learn/topic-file'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * A learner's own starting topic.
 *
 * The built-in transformer topic is a demonstration. A learner working on chemistry should not have to read
 * about attention heads to understand the interface — this is what makes the surface usable on the material
 * they are actually working with, without a code change.
 *
 * Validation is strict on purpose: a malformed topic file is a mistake the learner can see and fix, and
 * skipping a bad line would leave them looking at a graph that silently disagrees with the file they wrote.
 */

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-topic-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function topicFile(content: unknown, name = 'topic.json'): Promise<string> {
  const path = join(directory, name)
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
  return path
}

describe('loading a topic file', () => {
  it('reads a topic and separates its node kinds', async () => {
    const path = await topicFile({
      title: '有机化学：反应机理',
      about: '从电子推动看反应为什么这样发生。',
      source: 'textbook:clayden',
      nodes: [
        { label: '亲核取代（SN2）' },
        { label: '离去基团' },
        { label: '为什么 SN2 会发生构型翻转？', kind: 'question' },
        { label: 'SN2 是一步完成的', kind: 'claim', source: 'lecture:3' },
      ],
    })

    const topic = await loadTopicFile(path)
    expect(topic.title).toBe('有机化学：反应机理')
    expect(topic.about).toContain('电子推动')
    expect(topic.source).toBe('textbook:clayden')
    expect(topic.concepts.map((node) => node.label)).toEqual(['亲核取代（SN2）', '离去基团'])
    expect(topic.questions.map((node) => node.label)).toEqual(['为什么 SN2 会发生构型翻转？'])
    expect(topic.claims.map((node) => node.label)).toEqual(['SN2 是一步完成的'])
    // A readable id derived from the label, so reusing the same file is idempotent.
    expect(topic.concepts[0]?.id).toContain('亲核取代')
  })

  it('defaults an unspecified kind to concept', async () => {
    const path = await topicFile({ nodes: [{ label: 'a thing' }] })
    const topic = await loadTopicFile(path)
    expect(topic.concepts).toHaveLength(1)
    expect(topic.concepts[0]?.id).toBe('concept_a_thing')
  })

  it('falls back to sensible defaults rather than failing on optional fields', async () => {
    const path = await topicFile({ nodes: [{ label: 'only a label' }] })
    const topic = await loadTopicFile(path)
    expect(topic.title).toBe('你的主题')
    expect(topic.about.length).toBeGreaterThan(0)
    // The source still identifies where the material came from, so provenance is never silently absent.
    expect(topic.source).toContain('topic.json')
  })

  it('refuses invalid JSON with the parse error, not a silent empty graph', async () => {
    const path = await topicFile('{ not json', 'broken.json')
    await expect(loadTopicFile(path)).rejects.toThrow(/不是合法 JSON/)
  })

  it('refuses a missing or empty node list', async () => {
    await expect(loadTopicFile(await topicFile({ title: 'x' }))).rejects.toThrow(/"nodes"/)
    await expect(loadTopicFile(await topicFile({ nodes: [] }))).rejects.toThrow(/非空/)
  })

  it('refuses a node without a label, naming which one', async () => {
    const path = await topicFile({ nodes: [{ label: 'fine' }, { kind: 'question' }] })
    await expect(loadTopicFile(path)).rejects.toThrow(/nodes\[1\]\.label/)
  })

  it('refuses an unknown kind, naming the value it saw', async () => {
    const path = await topicFile({ nodes: [{ label: 'x', kind: 'theorem' }] })
    await expect(loadTopicFile(path)).rejects.toThrow(/nodes\[0\]\.kind/)
  })

  it('refuses a node that is not an object', async () => {
    const path = await topicFile({ nodes: ['just a string'] })
    await expect(loadTopicFile(path)).rejects.toThrow(/nodes\[0\] 必须是一个对象/)
  })
})

describe('seeding from a custom topic', () => {
  it('places the nodes and can be found by a question about them', async () => {
    const path = await topicFile({
      title: '有机化学：反应机理',
      nodes: [
        { label: '亲核取代（SN2）' },
        { label: '离去基团' },
        { label: '溶剂极性对反应速率的影响' },
        { label: 'SN2 和 SN1 有什么区别？', kind: 'question' },
      ],
    })
    const topic = await loadTopicFile(path)
    const opened = await LearnSession.open({ filePath: join(directory, 'learn.jsonl') })
    const seeded = await seedTopic(opened, topic)

    expect(seeded.seeded).toBe(true)
    expect(seeded.nodeCount).toBe(4)
    expect(opened.listNodes().map((node) => node.label)).toContain('亲核取代（SN2）')

    // The point of the feature: a question about the learner's own material retrieves their own material.
    const answer = await opened.ask('为什么溶剂会影响反应速率')
    expect(answer.ranked.length).toBeGreaterThan(0)
    expect(answer.ranked[0]?.label).toBe('溶剂极性对反应速率的影响')
  })

  it('answers without naming anything from the demo topic', async () => {
    // The responder has no idea what the topic is, so it must not name one. An earlier version said the
    // answer depended on "what self-attention can and cannot represent" — true for the built-in topic and
    // nonsense the moment a learner brought chemistry, which is what exposed the leak.
    const path = await topicFile({ nodes: [{ label: '亲核取代（SN2）' }] })
    const opened = await LearnSession.open({ filePath: join(directory, 'learn.jsonl') })
    await seedTopic(opened, await loadTopicFile(path))

    const answer = await opened.ask('为什么溶剂会影响反应速率')
    for (const word of ['自注意力', '注意力', 'Transformer', 'RoPE', '位置编码']) {
      expect(answer.answer, `the answer must not mention "${word}"`).not.toContain(word)
    }
  })

  it('seeds a given claim at reference tier, not as the learner\u2019s own thinking', async () => {
    const path = await topicFile({ nodes: [{ label: 'SN2 是一步完成的', kind: 'claim' }] })
    const topic = await loadTopicFile(path)
    const opened = await LearnSession.open({ filePath: join(directory, 'learn.jsonl') })
    await seedTopic(opened, topic)

    const claim = opened.listNodes().find((node) => node.type === 'claim')
    expect(claim?.tier).toBe('reference')
    // And it carries no understanding: nothing in a topic file may claim what the learner understands.
    expect(opened.understandingOf(claim?.nodeId ?? '')).toEqual([])
    expect(opened.progress().touched).toBe(0)
  })

  it('is idempotent, including for a topic of only questions', async () => {
    const path = await topicFile({ nodes: [{ label: 'why?', kind: 'question' }] })
    const topic = await loadTopicFile(path)
    const opened = await LearnSession.open({ filePath: join(directory, 'learn.jsonl') })

    expect((await seedTopic(opened, topic)).seeded).toBe(true)
    // A second seeding must not double the graph. Checking only concepts would have missed this, because a
    // question-only topic has none.
    expect((await seedTopic(opened, topic)).seeded).toBe(false)
    expect(opened.listNodes()).toHaveLength(1)
  })

  it('does not carry cognitive state from a topic file', async () => {
    // A topic file describes material, never understanding. A `state` key has no effect because it is not
    // read at all — asserted so nobody adds one thinking it works.
    const path = await topicFile({
      nodes: [{ label: 'a concept', state: { confidence: 'high' } }],
    })
    const topic = await loadTopicFile(path)
    const opened = await LearnSession.open({ filePath: join(directory, 'learn.jsonl') })
    await seedTopic(opened, topic)

    expect(opened.progress().touched).toBe(0)
    expect(opened.progress().summary).toContain('还没有记录过')
  })
})

describe('starting blank', () => {
  it('adds nothing and says so', async () => {
    const opened = await LearnSession.open({ filePath: join(directory, 'learn.jsonl') })
    const seeded = await seedTopic(opened, BLANK_TOPIC)

    expect(seeded.seeded).toBe(true)
    expect(seeded.nodeCount).toBe(0)
    expect(opened.listNodes()).toEqual([])

    // A blank graph must still work: the learner writes the first node themselves.
    const node = await opened.addNode({ label: '我的第一个论断', kind: 'claim' })
    expect(node.nodeId).toBe('claim_1')
    expect(opened.listNodes()).toHaveLength(1)
  })

  it('is distinguishable from the built-in topic', () => {
    expect(BLANK_TOPIC.concepts).toEqual([])
    expect(TRANSFORMERS.concepts.length).toBeGreaterThan(0)
  })
})
