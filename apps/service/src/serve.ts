#!/usr/bin/env node
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  GraphConversionError,
  GraphLockedError,
  UnreadableGraphError,
  convertGraph,
} from '@episteme/application'
import { describeEmbeddings, EmbeddingSettingsError } from './embeddings.js'
import { addPerson, addToken, revokeToken, type CredentialKind } from './identity.js'
import { BLANK_TOPIC, defaultProfile, type SeedTopic } from './profile.js'
import { DEFAULT_GRAPH, startService, type EpistemeService } from './server.js'

const DEFAULT_USERS = join(homedir(), '.episteme', 'users.json')

async function loadTopicFile(filePath: string): Promise<SeedTopic> {
  const { readFile } = await import('node:fs/promises')
  const content = await readFile(filePath, 'utf8')
  return JSON.parse(content) as SeedTopic
}

/**
 * Starts the Episteme service and prints where it is.
 *
 * The printed lines are the whole interface: where an agent connects, where a client connects, and which
 * graph is owned. Nothing is opened automatically, because a program that opens a browser is a program that
 * acts without being asked.
 */

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(
    `EPISTEME · 服务 —— 一个图谱的唯一持有者\n` +
      `\n  用法：pnpm serve [选项]\n` +
      `\n  选项：\n` +
      `    -g, --graph <路径>      指定图谱文件，一个 SQLite 数据库（默认 ${DEFAULT_GRAPH}；--file / -f 等效）\n` +
      `    -p, --port <端口>       监听端口（默认 4321）\n` +
      `    -t, --topic <路径>      首次启动时载入你自己的主题文件，而不是内置的示例主题\n` +
      `        --blank             从空图谱开始，什么都不载入\n` +
      `    -w, --workspace <目录>  在 / 托管一个已构建的 Workspace\n` +
      `        --mode shared       共享部署：多人、走网络，放在 HTTPS 反向代理后面（ADR 0012）\n` +
      `        --users <路径>      用户文件（共享模式必需；默认 ${DEFAULT_USERS}）\n` +
      `        --public-origin <地址>  共享部署对外的地址，例如 https://episteme.example.edu\n` +
      `        --host <地址>       监听地址（默认 127.0.0.1）\n` +
      `        --trust-elicitation 共享模式下仍把 agent 弹出的表单回答当作本人的决定\n` +
      `        --sharing           允许发布理解（ADR 0014）；第一次发布前会先备份图谱文件\n` +
      `    -h, --help              显示这份说明\n` +
      `\n  管理用户和令牌（作用于 --users 指定的文件）：\n` +
      `    pnpm serve users add <名字>\n` +
      `    pnpm serve tokens add <actorId> --kind human|agent --label <用途，例如 claude-code>\n` +
      `    pnpm serve tokens revoke <令牌 id>\n` +
      `\n  把旧版图谱（JSONL 或第 1 版 SQLite）转换成新文件。旧文件只读，不会被改动，目标已存在时拒绝：\n` +
      `    pnpm serve graph convert <旧图谱> <新图谱>\n` +
      `\n  环境变量：EPISTEME_FILE 与 --graph 等效，PORT 与 --port 等效；命令行参数优先。\n` +
      `\n  语义检索（默认关闭）：\n` +
      `    EPISTEME_EMBEDDINGS_URL         嵌入服务地址，例如 http://127.0.0.1:11434\n` +
      `    EPISTEME_EMBEDDINGS_MODEL       嵌入模型名（与 URL 一起设置才开启）\n` +
      `    EPISTEME_EMBEDDINGS_PROTOCOL    openai（默认）、ollama 或 tei\n` +
      `    EPISTEME_EMBEDDINGS_API_KEY     托管服务的密钥，可不设\n` +
      `    EPISTEME_EMBEDDINGS_TIMEOUT_MS  单次请求超时，默认 10000\n` +
      `    嵌入服务出错时，这次检索退回到关键词和图谱，并在结果里写明原因。\n` +
      `\n  本地模式只监听本机回环地址。确认建议、记录理解需要你本人的令牌：托管的 Workspace 会自动带上，\n` +
      `  其他客户端用启动时打印的令牌。它能防止误操作，但挡不住以你的身份运行、能用 shell 的 agent。\n\n`,
  )
  process.exit(0)
}

/** The value after `--name` or `-n`, or in `--name=value`. A copy of Learn's, since no app imports another. */
function optionValue(args: readonly string[], ...names: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === undefined) continue
    for (const name of names) {
      if (argument === name) {
        const next = args[index + 1]
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

/** Why the graph could not be opened, in words a person can act on, or `undefined` for any other failure. */
function refusalMessage(error: unknown): string | undefined {
  if (error instanceof GraphLockedError) {
    return `这个图谱已经被另一个进程打开了，比如正在运行的 Episteme 服务：\n  ${error.graphPath}\n请直接使用那个进程，或者先把它停掉。一个图谱同时只能有一个进程写入。`
  }
  if (error instanceof UnreadableGraphError) {
    return `这个版本打不开这个文件，文件没有被改动：\n  ${error.message}\n如果它是旧版图谱，可以转换成一个新文件：\n  pnpm serve graph convert <旧图谱> <新图谱>`
  }
  if (error instanceof EmbeddingSettingsError) {
    return `语义检索的设置有误，服务没有启动：\n  ${error.message}`
  }
  return undefined
}

const usersPath = optionValue(argv, '--users') ?? process.env.EPISTEME_USERS ?? DEFAULT_USERS

// Administration of people and tokens: one command, then exit. Nothing here starts the service.
if (argv[0] === 'users' || argv[0] === 'tokens') {
  await administer(argv)
  process.exit(0)
}

// Conversion of an older graph: one command, then exit. The older files are only read.
if (argv[0] === 'graph') {
  const [, action, from, to] = argv
  if (action !== 'convert' || from === undefined || to === undefined) {
    process.stderr.write('用法：pnpm serve graph convert <旧图谱> <新图谱>\n')
    process.exit(1)
  }
  try {
    const done = await convertGraph(from, to)
    const counts = (found: Readonly<Record<string, number | undefined>>): string =>
      Object.entries(found)
        .map(([name, count]) => `${name} ${count ?? 0}`)
        .join('，') || '无'
    process.stdout.write(
      `已转换（${done.sourceFormat}）：\n  新图谱：${done.to}\n  记录：${counts(done.records)}\n  伴生数据：${counts(done.companions)}\n` +
        `  旧文件没有改动，校验值前后一致，可以保留：\n` +
        Object.entries(done.source)
          .map(([file, sha256]) => `    ${file}  ${sha256}\n`)
          .join('') +
        done.notes.map((note) => `  注意：${note}\n`).join(''),
    )
    process.exit(0)
  } catch (error) {
    if (!(error instanceof GraphConversionError)) throw error
    process.stderr.write(`没有转换。旧文件没有改动，目标也没有被写入：\n  ${error.message}\n`)
    process.exit(1)
  }
}

/** `users add`, `tokens add` and `tokens revoke`, on the user file. A token is printed once and never again. */
async function administer(args: readonly string[]): Promise<void> {
  const [area, action, subject] = args
  if (area === 'users' && action === 'add' && subject !== undefined) {
    const actorId = await addPerson(usersPath, subject)
    process.stdout.write(`已添加：${subject}\n  actorId：${actorId}\n  用户文件：${usersPath}\n`)
    return
  }
  if (area === 'tokens' && action === 'add' && subject !== undefined) {
    const kind = optionValue(args, '--kind')
    const label = optionValue(args, '--label')
    if ((kind !== 'human' && kind !== 'agent') || label === undefined) {
      throw new Error('用法：tokens add <actorId> --kind human|agent --label <用途>')
    }
    const token = await addToken(usersPath, subject, kind satisfies CredentialKind, label)
    process.stdout.write(
      `令牌（只显示这一次，请妥善保存）：\n  ${token}\n` +
        (kind === 'agent'
          ? `  这是 agent 令牌：能读取、提议、蒸馏，不能替本人做决定。\n`
          : `  这是本人的令牌：能确认建议、记录理解。不要交给 agent。\n`),
    )
    return
  }
  if (area === 'tokens' && action === 'revoke' && subject !== undefined) {
    await revokeToken(usersPath, subject)
    process.stdout.write(`已撤销令牌 ${subject}。运行中的服务从下一个请求起拒绝它。\n`)
    return
  }
  throw new Error(
    '用法：users add <名字> | tokens add <actorId> --kind … --label … | tokens revoke <id>',
  )
}

const graph =
  optionValue(argv, '--graph', '-g', '--file', '-f') ?? process.env.EPISTEME_FILE ?? DEFAULT_GRAPH
const portText = optionValue(argv, '--port', '-p') ?? process.env.PORT ?? '4321'
const port = Number.parseInt(portText, 10)
const topicPath = optionValue(argv, '--topic', '-t')
const workspacePath = optionValue(argv, '--workspace', '-w')
const blank = argv.includes('--blank')
const shared = optionValue(argv, '--mode') === 'shared'
const publicOrigin = optionValue(argv, '--public-origin')
const host = optionValue(argv, '--host')

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write(`端口 "${portText}" 不是有效端口。\n`)
  process.exit(1)
}

if (topicPath !== undefined && blank) {
  process.stderr.write('--topic 和 --blank 不能同时使用：一个要载入材料，一个要什么都不载入。\n')
  process.exit(1)
}

let topic: SeedTopic | undefined
try {
  topic = blank ? BLANK_TOPIC : topicPath === undefined ? undefined : await loadTopicFile(topicPath)
} catch (error) {
  // Reported before the socket opens, so a broken topic file fails loudly and immediately rather than
  // serving a graph that silently disagrees with the file the learner wrote.
  process.stderr.write(`${(error as Error).message}\n`)
  process.exit(1)
}

let service: EpistemeService
try {
  service = await startService({
    graph,
    port,
    profile: defaultProfile(topic),
    ...(workspacePath === undefined ? {} : { workspace: resolve(workspacePath) }),
    ...(host === undefined ? {} : { host }),
    sharing: argv.includes('--sharing'),
    ...(shared
      ? {
          mode: 'shared' as const,
          users: usersPath,
          ...(publicOrigin === undefined ? {} : { publicOrigin }),
          trustElicitation: argv.includes('--trust-elicitation'),
        }
      : {}),
  })
} catch (error) {
  // Only the failures a person can act on are translated. Anything else is a bug and keeps its stack.
  const message = refusalMessage(error)
  if (message === undefined) throw error
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

process.stdout.write(
  `\nEPISTEME · 服务\n` +
    (service.workspaceUrl === undefined ? '' : `\n  Workspace：${service.workspaceUrl}\n`) +
    `\n  MCP：      ${service.mcpUrl}  （给 agent：读取你的理解、提出建议；它不能替你确认）\n` +
    `  REST API： ${service.apiUrl}\n` +
    `  图谱：     ${service.graph}\n` +
    (topic === undefined ? '' : `  主题：     ${topic.title}\n`) +
    `  ${describeEmbeddings(service.embeddings)}\n` +
    (service.humanToken === undefined
      ? `  模式：     共享（用户文件 ${usersPath}）\n`
      : `  你的令牌： ${service.humanToken}\n` +
        `             （本次运行有效。托管的 Workspace 会自动带上；其他客户端用 Authorization: Bearer 传入。\n` +
        `              它能替你确认建议，不要交给 agent。）\n`) +
    `\n  你记录的一切都会写入磁盘，关掉进程也不会丢。\n` +
    (service.humanToken === undefined
      ? ''
      : `  只监听本机回环地址。它能防止误操作，但挡不住以你的身份运行、能用 shell 的 agent。\n`) +
    `\n  按 Ctrl+C 停止。\n\n`,
)

let stopping = false
const stop = (): void => {
  if (stopping) return
  stopping = true
  process.stdout.write('\n已保存。你记录的所有内容都在磁盘上。\n')
  service
    .close()
    .then(() => process.exit(0))
    .catch(() => process.exit(1))
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)
