import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { RECORDABLE_DIMENSIONS, LearnSession, type AskResult } from '@episteme/application'
import { seedTopic, TRANSFORMERS, type SeedTopic } from './seed.js'
import { BLANK_TOPIC, loadTopicFile } from './topic-file.js'

/**
 * A terminal Learn session.
 *
 * The point of this file is that the whole loop is usable before any UI exists: a learner types a
 * question, sees which of their own prior understanding was retrieved and **why**, records what they now
 * understand, and asks again. Everything is printed as text so the reasoning is inspectable rather than
 * presented.
 *
 * Commands are single letters because the loop is meant to be repeated, not studied. `?` lists them.
 */

const DEFAULT_PATH = join(homedir(), '.episteme', 'learn.jsonl')

interface Command {
  readonly name: string
  readonly usage: string
  /** What the command does, in Simplified Chinese — the language the learner reads. */
  readonly help: string
}

const COMMANDS: readonly Command[] = [
  { name: 'ask', usage: '<问题>', help: '提一个问题；直接输入文字也会被当成问题' },
  { name: 'explain', usage: '[序号]', help: '展开上一个回答背后的排序依据' },
  { name: 'record', usage: '<节点> <维度> <程度>', help: '记录你现在理解到什么程度' },
  { name: 'claim', usage: '<文字>', help: '把你自己的一个论断加进图谱' },
  { name: 'graph', usage: '', help: '列出你图谱里的全部节点' },
  { name: 'progress', usage: '', help: '总结你已经理解了什么、接下来该看什么' },
  { name: 'open', usage: '', help: '显示你还没收尾的线索' },
  { name: 'dimensions', usage: '', help: '列出可以记录的维度' },
  { name: 'help', usage: '', help: '显示这份列表' },
  { name: 'quit', usage: '', help: '离开（所有内容都已经保存）' },
]

/**
 * Commands, and the aliases that must not cost a learner their question.
 *
 * This list is why the evidence command is `explain` and not `why`. The first version used `why`, and
 * `why order matters for attention` — the most natural way anyone would phrase that question — was read as
 * the command plus an argument and silently discarded. A surface whose own vocabulary eats the learner's
 * question is worse than one that makes them learn a syntax.
 *
 * Every alias here is therefore a word nobody opens a question with.
 */
const ALIASES: Readonly<Record<string, string>> = {
  '?': 'help',
  help: 'help',
  explain: 'explain',
  record: 'record',
  claim: 'claim',
  graph: 'graph',
  list: 'graph',
  progress: 'progress',
  open: 'open',
  dimensions: 'dimensions',
  dims: 'dimensions',
  ask: 'ask',
  quit: 'quit',
  exit: 'quit',
  q: 'quit',
}

/**
 * The alias table is exported so a test can assert the property that matters about it.
 *
 * That property is negative and easy to lose: **no command name or alias may be a word a learner would
 * open a question with.** `why` was such a word, it was the name of this command, and every question
 * beginning "why …" was silently swallowed. Re-adding an alias like `what` or `how` would reintroduce the
 * same class of bug, so the test names the words that must never appear here.
 */
export const RESERVED_WORDS = [
  'why',
  'what',
  'how',
  'when',
  'where',
  'which',
  'who',
  'does',
  'is',
  'are',
  'can',
  'should',
] as const

/**
 * Commands that consume the rest of the line as their argument.
 *
 * Only these may swallow trailing words. Anything else that matches a command name takes no argument, so a
 * learner who writes `graph the attention concepts` gets a question rather than a puzzling graph listing.
 */
const TAKES_ARGUMENT = new Set(['ask', 'explain', 'record', 'claim'])

export interface CliOptions {
  readonly filePath?: string
  readonly quiet?: boolean
  /**
   * The topic to start from. Defaults to the transformer demonstration topic.
   *
   * Injected rather than read here, so a caller can point at a topic file without this class knowing about
   * the filesystem, and a test can hand it a topic directly.
   */
  readonly topic?: SeedTopic
}

/** How many nodes a topic will add, used to tell "blank" apart from "nothing matched". */
export function topicSize(topic: SeedTopic): number {
  return topic.concepts.length + topic.questions.length + topic.claims.length
}

/** Everything the CLI needs, so a test can drive it without a terminal. */
export interface CliOutput {
  write(text: string): void
}

/**
 * Runs one line of input and returns the text to print.
 *
 * Separated from the readline loop so the whole session is testable without a pty — the loop is the only
 * part that needs a terminal.
 */
export class LearnCli {
  readonly #session: LearnSession
  readonly #out: CliOutput
  #lastAsk: AskResult | undefined

  private constructor(session: LearnSession, out: CliOutput) {
    this.#session = session
    this.#out = out
  }

  static async open(out: CliOutput, options: CliOptions = {}): Promise<LearnCli> {
    const session = await LearnSession.open(
      options.filePath === undefined ? {} : { filePath: options.filePath },
    )
    const cli = new LearnCli(session, out)
    const seed = await seedTopic(session, options.topic)
    if (seed.seeded) {
      cli.#out.write(
        `已载入起始主题「${options.topic?.title ?? TRANSFORMERS.title}」：${seed.nodeCount} 个节点、${seed.edgeCount} 条连接。\n` +
          `还没有记录任何理解 —— 那部分是你的。\n\n`,
      )
    } else if (options.topic !== undefined && topicSize(options.topic) === 0) {
      // An explicit blank start must look deliberate rather than like a seeding failure.
      cli.#out.write(`图谱是空的。写下你自己的第一个论断：  claim <你的想法>\n\n`)
    }
    return cli
  }

  get session(): LearnSession {
    return this.#session
  }

  /** Handles one line. Returns whether the session should continue. */
  async handle(line: string): Promise<boolean> {
    const trimmed = line.trim()
    if (trimmed === '') return true

    const [head, ...rest] = splitFirst(trimmed)
    const command = ALIASES[head.toLowerCase()]

    // Not a command, or a command that takes no argument followed by words — either way it is a question.
    // Falling through to `ask` is deliberate: the cost of guessing wrong is one answer the learner did not
    // want, while the cost of *not* guessing is their question disappearing.
    if (command === undefined || (!TAKES_ARGUMENT.has(command) && rest.length > 0)) {
      await this.#ask(trimmed)
      return true
    }

    if (command === 'quit') return false

    if (command === 'help') {
      this.#printHelp()
      return true
    }

    if (command === 'ask') {
      const question = rest.join(' ').trim()
      if (question === '') {
        this.#out.write('ask 需要一个问题，例如：  ask 为什么这里会这样\n')
        return true
      }
      await this.#ask(question)
      return true
    }

    if (command === 'explain') {
      this.#printWhy(rest[0])
      return true
    }

    if (command === 'record') {
      await this.#record(rest)
      return true
    }

    if (command === 'claim') {
      const text = rest.join(' ').trim()
      if (text === '') {
        this.#out.write('claim needs some text, e.g.  claim self-attention cannot see order\n')
        return true
      }
      const node = await this.#session.addNode({ label: text, kind: 'claim' })
      this.#out.write(`Added claim ${node.nodeId}\n`)
      return true
    }

    if (command === 'graph') {
      this.#printGraph()
      return true
    }

    if (command === 'progress') {
      this.#printProgress()
      return true
    }

    if (command === 'open') {
      this.#printOpenEnds()
      return true
    }

    if (command === 'dimensions') {
      this.#printDimensions()
      return true
    }

    await this.#ask(trimmed)
    return true
  }

  async #ask(question: string): Promise<void> {
    const result = await this.#session.ask(question)
    this.#lastAsk = result

    this.#out.write(`\n${result.answer}\n`)
    this.#out.write(
      result.usedContext
        ? `\n  基于你已经记录过的 ${result.known.length} 项理解  [${result.retriever}]\n`
        : `\n  你记录过的内容都不相关，所以这个回答从头开始  [${result.retriever}]\n`,
    )

    if (result.ranked.length > 0) {
      this.#out.write(`  检索到的内容，按相关度排序：\n`)
      for (const entry of result.ranked.slice(0, 5)) {
        const why = entry.reasons[0]
        this.#out.write(
          `    ${entry.score.toFixed(3)}  ${entry.label}\n` +
            `           ${entry.nodeId} · ${shortKind(entry.type)} · ${why === undefined ? '没有信号' : why.explanationZh}\n`,
        )
      }
      this.#out.write(`  输入 "explain" 可以看到完整的分解。\n`)
    }
    this.#out.write('\n')
  }

  /**
   * Prints how each retrieved node earned its place.
   *
   * The contributions shown are the ones that produced the ranking, not a reconstruction, so a learner can
   * check the system's reasoning against the order it just presented.
   */
  #printWhy(which?: string): void {
    const result = this.#lastAsk
    if (result === undefined) {
      this.#out.write('还没有提过问题\n')
      return
    }

    const index = which === undefined ? undefined : Number.parseInt(which, 10) - 1
    const entries =
      index === undefined || Number.isNaN(index)
        ? result.ranked
        : result.ranked.slice(Math.max(0, index), Math.max(0, index) + 1)

    if (entries.length === 0) {
      this.#out.write('没有可以解释的内容\n')
      return
    }

    this.#out.write(`\n这些内容为什么会被检索到：${result.question}\n`)
    this.#out.write(
      `权重：${result.rules.map((rule) => `${rule.signal}=${rule.weight}`).join('  ')}\n`,
    )

    for (const entry of entries) {
      this.#out.write(`\n  ${entry.label}   [${entry.nodeId}]\n`)
      this.#out.write(`    合计 ${entry.score.toFixed(4)}  (${entry.origin})\n`)
      for (const reason of entry.reasons) {
        this.#out.write(
          `      ${reason.signal.padEnd(10)} 取值 ${reason.value.toFixed(3)} × 权重 ${reason.weight} = ` +
            `${reason.contribution.toFixed(4)}  (占 ${(reason.share * 100).toFixed(0)}%)\n` +
            `      ${' '.repeat(10)} ${reason.explanationZh}\n`,
        )
      }
    }
    this.#out.write('\n')
  }

  async #record(args: readonly string[]): Promise<void> {
    const [reference, dimension, level] = args
    if (reference === undefined || dimension === undefined || level === undefined) {
      this.#out.write('record 需要一个节点、一个维度和一个程度，例如：\n')
      this.#out.write('  record claim_1 confidence low\n\n')
      this.#printDimensions()
      return
    }

    const known = RECORDABLE_DIMENSIONS.find((candidate) => candidate.id === dimension)
    if (known === undefined) {
      this.#out.write(`「${dimension}」不是这里可以记录的维度。\n\n`)
      this.#printDimensions()
      return
    }
    if (!known.levels.includes(level)) {
      this.#out.write(
        `「${level}」不是 ${dimension} 的合法取值。可用：${known.levels.join(', ')}\n`,
      )
      return
    }

    // Resolved rather than assumed: an ambiguous reference must not silently attach the learner's
    // understanding to the wrong node, because a StateEvent is permanent.
    const matches = this.#session.resolveNodes(reference)
    if (matches.length === 0) {
      this.#out.write(`没有节点匹配「${reference}」。输入 "graph" 看看有什么。\n`)
      return
    }
    if (matches.length > 1) {
      this.#out.write(`「${reference}」匹配到 ${matches.length} 个节点 —— 请说得更具体：\n`)
      for (const match of matches) this.#out.write(`  ${match.nodeId}  ${match.label}\n`)
      return
    }

    const target = matches[0]
    if (target === undefined) return

    try {
      const result = await this.#session.record(target.nodeId, { [dimension]: level })
      const describe = (entry: { id: string; level: string }): string => {
        const definition = RECORDABLE_DIMENSIONS.find((candidate) => candidate.id === entry.id)
        const name = definition ? definition.labelZh : entry.id
        const label = definition
          ? (definition.levelLabelsZh.find((candidate) => candidate.level === entry.level) || {})
              .label
          : undefined
        return `${name}=${label ?? entry.level}`
      }
      this.#out.write(
        `已记录 ${target.nodeId} → ${result.recorded.map(describe).join('、')}` +
          `  [${result.eventId}]\n`,
      )
      this.#out.write(`你的理解现在进入了历史。再问一次就能看到它被使用。\n`)
    } catch (error) {
      this.#out.write(`记录失败：${(error as Error).message}\n`)
    }
  }

  #printGraph(): void {
    const nodes = this.#session.listNodes()
    this.#out.write(`\n共 ${nodes.length} 个节点：\n`)
    for (const node of nodes) {
      const state = this.#session.understandingOf(node.nodeId)
      const understood =
        state.length === 0
          ? ''
          : `  ← 你：${state
              .map((entry) => {
                const definition = RECORDABLE_DIMENSIONS.find(
                  (candidate) => candidate.id === entry.id,
                )
                const name = definition ? definition.labelZh : entry.id
                const label = definition
                  ? (
                      definition.levelLabelsZh.find(
                        (candidate) => candidate.level === entry.level,
                      ) || {}
                    ).label
                  : undefined
                return `${name}=${label ?? entry.level}`
              })
              .join('、')}`
      this.#out.write(
        `  ${node.nodeId.padEnd(28)} ${shortKind(node.type).padEnd(6)} ${node.label}${understood}\n`,
      )
    }
    this.#out.write('\n')
  }

  /**
   * Summarises what the learner has understood and what deserves attention next.
   *
   * The loop answers "what is relevant to this question"; `graph` answers "what exists". Neither answers
   * "what did I get out of this", which is the question a learner has after using it for a while.
   */
  #printProgress(): void {
    const progress = this.#session.progress()
    this.#out.write(`\n${progress.summary}\n`)

    if (progress.items.length === 0) {
      this.#out.write(
        `\n记录一条理解之后，这里会告诉你哪些已经稳了、哪些还需要处理。\n` +
          `例如：  record claim_1 confidence low\n\n`,
      )
      return
    }

    const labels: Readonly<Record<string, string>> = {
      conflict: '有未解决的冲突 —— 先处理它',
      unexplained: '说得出来但讲不清楚 —— 试着讲给别人听',
      shaky: '记录了，但还不足以往下建',
      settled: '已经可以往下建',
    }

    let current = ''
    for (const item of progress.items) {
      if (item.attention !== current) {
        current = item.attention
        this.#out.write(`\n  ${labels[current] ?? current}：\n`)
      }
      const state = item.dimensions
        .map((entry) => {
          const definition = RECORDABLE_DIMENSIONS.find((candidate) => candidate.id === entry.id)
          const name = definition ? definition.labelZh : entry.id
          const level = definition
            ? (definition.levelLabelsZh.find((candidate) => candidate.level === entry.level) || {})
                .label
            : undefined
          return `${name}=${level ?? entry.level}`
        })
        .join('、')
      this.#out.write(`    ${item.label}\n      ${item.nodeId} · ${state}\n`)
    }
    this.#out.write('\n')
  }

  #printOpenEnds(): void {
    const ends = this.#session.openEnds()
    if (ends.length === 0) {
      this.#out.write('\n还没有没收尾的线索 —— 记录一条，就会出现\n\n')
      return
    }
    this.#out.write(`\n${ends.length} 条还没收尾的线索：\n`)
    for (const end of ends) {
      this.#out.write(`  ${end.eventId}  ${end.label}\n`)
    }
    this.#out.write('\n')
  }

  #printDimensions(): void {
    this.#out.write('可以记录的维度（id 用英文，显示用中文）：\n')
    for (const dimension of RECORDABLE_DIMENSIONS) {
      const levels = dimension.levels
        .map((level) => {
          const label = dimension.levelLabelsZh.find((candidate) => candidate.level === level)
          return `${level}${label ? `(${label.label})` : ''}`
        })
        .join(' | ')
      this.#out.write(
        `  ${dimension.id.padEnd(13)} ${levels.padEnd(46)} ${dimension.labelZh}\n` +
          `  ${' '.repeat(13)} ${dimension.descriptionZh}\n`,
      )
    }
    this.#out.write('\n')
  }

  #printHelp(): void {
    this.#out.write('\n命令：\n')
    for (const command of COMMANDS) {
      this.#out.write(`  ${`${command.name} ${command.usage}`.trim().padEnd(30)} ${command.help}\n`)
    }
    this.#out.write('\n  其他任何一行都会被当成问题 —— 包括以「为什么」开头的问题。\n\n')
    this.#out.write('  提问 → 看检索到什么 → 记录理解 → 再问一次。\n')
    this.#out.write('  两个回答之间的差别，就是这个系统在起作用。\n\n')
  }
}

/** The node kind in Chinese, for a learner-facing listing. English stays in the data. */
function shortKind(type: string): string {
  return { concept: '概念', claim: '论断', question: '问题' }[type] ?? type
}

/** Splits on the first run of whitespace, so a command never swallows the rest of the line. */
function splitFirst(line: string): [string, ...string[]] {
  const match = /^(\S+)\s*([\s\S]*)$/u.exec(line)
  if (match === null) return [line]
  const head = match[1] ?? line
  const tail = (match[2] ?? '').trim()
  return tail === '' ? [head] : [head, ...tail.split(/\s+/u)]
}

/** The readline loop. The only part of this file that needs a terminal. */
async function main(): Promise<void> {
  const argv = process.argv.slice(2)

  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      `EPISTEME · Learn —— 一个最小的学习界面\n` +
        `\n  用法：pnpm learn [选项]\n` +
        `\n  选项：\n` +
        `    -f, --file <路径>    指定图谱文件（默认 ${DEFAULT_PATH}）\n` +
        `    -t, --topic <路径>   从你自己的主题文件开始，而不是内置的示例主题\n` +
        `        --blank          从空图谱开始，什么都不载入\n` +
        `    -h, --help           显示这份说明\n` +
        `\n  环境变量：EPISTEME_FILE 与 --file 等效，--file 优先。\n` +
        `\n  主题文件是一个 JSON：{ "title": ?, "nodes": [{ "label": ?, "kind": ? }] }，\n` +
        `  kind 可以是 concept（默认）/ question / claim。\n` +
        `\n  在里面输入 "?" 查看会话中的命令。任何其他一行都会被当成问题。\n\n`,
    )
    return
  }

  const filePath = optionValue(argv, '--file', '-f') ?? process.env.EPISTEME_FILE ?? DEFAULT_PATH
  const topicPath = optionValue(argv, '--topic', '-t')
  const blank = argv.includes('--blank')

  if (topicPath !== undefined && blank) {
    process.stderr.write('--topic 和 --blank 不能同时使用：一个要载入材料，一个要什么都不载入。\n')
    process.exit(1)
  }

  let topic: SeedTopic | undefined
  try {
    topic = blank
      ? BLANK_TOPIC
      : topicPath === undefined
        ? undefined
        : await loadTopicFile(topicPath)
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    process.exit(1)
  }

  const out: CliOutput = { write: (text) => process.stdout.write(text) }

  process.stdout.write(
    `EPISTEME · Learn\n` +
      `图谱文件：${filePath}\n` +
      `你记录的一切都会保存。先问一个问题；输入 "?" 查看命令。\n\n`,
  )

  const cli = await LearnCli.open(out, {
    filePath,
    ...(topic === undefined ? {} : { topic }),
  })

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false })
  process.stdout.write('> ')

  // `for await` over the interface rather than an event handler: it serialises input, so a question that
  // takes longer than the next keystroke cannot interleave two answers.
  for await (const line of rl) {
    const keepGoing = await cli.handle(line)
    if (!keepGoing) break
    process.stdout.write('> ')
  }

  rl.close()
  process.stdout.write('\n已保存。你记录的所有内容都在磁盘上。\n')
}

/**
 * Reads a flag's value, accepting both `--file path` and `--file=path`.
 *
 * Both spellings because which one works is a coin flip in most tools, and a learner who guesses wrong
 * would silently get the default file — writing their understanding somewhere they did not intend.
 */
export function optionValue(
  argv: readonly string[],
  ...names: readonly string[]
): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === undefined) continue
    for (const name of names) {
      if (argument === name) {
        const next = argv[index + 1]
        if (next !== undefined && !next.startsWith('-')) return next
      }
      if (argument.startsWith(`${name}=`)) {
        const value = argument.slice(name.length + 1)
        if (value !== '') return value
      }
    }
  }
  return undefined
}

// Only run when invoked directly, so importing this file in a test does not start a prompt. Comparing
// resolved file URLs rather than string suffixes: a path ending check matches on any same-named file.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
