// Writes this fixture with the build that kept graphs in JSONL files: run it from a checkout of commit fed1075, after
// `pnpm build`, as `node <this file> <that checkout> <output directory>`. Synthetic words only.
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [checkout, output] = process.argv.slice(2).map((each) => resolve(each))
const from = (path) => import(pathToFileURL(join(checkout, path)).href)
const { CognitiveSession, LearnSession } = await from('packages/application/dist/index.js')

const FRAGMENT = [
  '[00:05] 学生：为什么 Transformer 需要位置编码？',
  '[00:12] 老师：因为自注意力本身不区分词的顺序。例如把句子里的词打乱，注意力的输出只是跟着重新排列。',
  '[00:40] 学生：我明白了。',
].join('\n')

const session = await LearnSession.open({ filePath: join(output, 'learn.jsonl') })

const outcome = await session.distill({ title: '位置编码', text: FRAGMENT }, { scope: 'space_a' })
if (!outcome.ok) throw new Error(outcome.refusal.message)
const [taken, dismissed] = outcome.suggestions
await session.decide(taken.id, { action: 'accept' }, 'learn-review')
await session.decide(dismissed.id, { action: 'dismiss', reason: '已经知道了' }, 'learn-review')

const made = await session.addNode({
  label: '校验和不对时必须停止重放',
  kind: 'claim',
  source: '资料第三节',
})
const other = await session.addNode({ label: '日志保留', kind: 'concept', source: '资料第二节' })
await session.link(made.nodeId, other.nodeId)
await session.record(made.nodeId, { confidence: 'medium' }, { reason: '自己讲了一遍' })
await session.record(made.nodeId, { confidence: 'high' }, { reason: '又讲了一遍' })

const thread = await session.openThread({ title: '第一天', scope: 'space_a' })
await session.appendTurn(thread.id, { speaker: 'learner', text: '校验和不对时跳过这条' })
await session.appendTurn(thread.id, { speaker: 'agent', text: '协议要求遇到错误就停下' })
await session.grantDelegation('space_a')
await session.putSceneRecord('learn', 'note_1', { text: '场景自己的记录' })
await session.close()

// What an older build shows for this graph, for the conversion to be held to.
const reopened = await CognitiveSession.open({ filePath: join(output, 'learn.jsonl') })
const nodes = reopened.listNodes()
const expected = {
  nodes,
  understanding: nodes.map(({ nodeId }) => reopened.understandingOf(nodeId) ?? null),
  history: nodes.map(({ nodeId }) => reopened.historyOf(nodeId) ?? null),
  sources: reopened.sources(),
  threads: reopened.threads().map(({ id }) => reopened.threadView(id)),
  pending: reopened.pendingSuggestions(),
  reviews: reopened.reviews(),
  delegations: reopened.delegations(),
  sceneRecords: reopened.sceneRecords('learn'),
}
await reopened.close()
writeFileSync(join(output, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`)
for (const [name, value] of Object.entries(expected)) console.log(name, value.length)
