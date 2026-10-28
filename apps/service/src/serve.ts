#!/usr/bin/env node
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  GraphLockedError,
  UnfinishedGraphCopyError,
  copyGraph,
  isSqliteGraph,
} from '@episteme/application'
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
      `    -g, --graph <路径>      指定图谱文件（默认 ${DEFAULT_GRAPH}；--file / -f 等效）\n` +
      `                            以 .db / .sqlite / .sqlite3 结尾的路径用 SQLite 保存，其他用 JSONL\n` +
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
      `\n  在 JSONL 和 SQLite 之间搬图谱（连同旁边的建议、材料、对话和场景记录文件；原文件不动）：\n` +
      `    pnpm serve graph import <旧图谱.jsonl> <新图谱.db>\n` +
      `    pnpm serve graph export <图谱.db> <新图谱.jsonl>\n` +
      `\n  环境变量：EPISTEME_FILE 与 --graph 等效，PORT 与 --port 等效；命令行参数优先。\n` +
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
  if (error instanceof GraphLockedError) return lockedMessage(error)
  if (error instanceof UnfinishedGraphCopyError) {
    return (
      `这个图谱是一次没有完成的复制的目标，可能缺少记录或附属文件，所以不会打开：\n  ${error.graphPath}\n` +
      `请重新运行同一条 graph import / graph export 命令，它会清掉上次写了一半的文件再重来。原图谱不受影响。`
    )
  }
  return undefined
}

/** Why the graph is locked, in words a person can act on. */
function lockedMessage(error: GraphLockedError): string {
  if (error.holderRunning) {
    const holder = error.holderPid === undefined ? '' : `（PID ${error.holderPid}）`
    return `这个图谱已经被另一个进程${holder}打开了，比如正在运行的 Episteme 服务或 Learn 终端。\n请直接使用那个进程，或者先把它停掉。一个图谱同时只能有一个进程写入。`
  }
  return (
    `这个图谱被一个锁占着，但持有它的${error.holderPid === undefined ? '进程无法识别' : `进程（PID ${error.holderPid}）已经不在运行了`}。\n` +
    `这通常是上次被强行结束留下的。如果确定没有别的程序在用这个图谱，删除下面这个文件后再试：\n  ${error.lockPath}`
  )
}

const usersPath = optionValue(argv, '--users') ?? process.env.EPISTEME_USERS ?? DEFAULT_USERS

// Moving a graph, and administration of people and tokens: one command, then exit. Nothing here starts the service.
if (argv[0] === 'graph') {
  try {
    await moveGraph(argv)
  } catch (error) {
    process.stderr.write(`${refusalMessage(error) ?? (error as Error).message}\n`)
    process.exit(1)
  }
  process.exit(0)
}
if (argv[0] === 'users' || argv[0] === 'tokens') {
  await administer(argv)
  process.exit(0)
}

/** `graph import` and `graph export`: copies a graph between JSONL and SQLite, leaving the original as it is. */
async function moveGraph(args: readonly string[]): Promise<void> {
  const [, action, from, to] = args
  if ((action !== 'import' && action !== 'export') || from === undefined || to === undefined) {
    throw new Error(
      '用法：graph import <旧图谱.jsonl> <新图谱.db> | graph export <图谱.db> <新图谱.jsonl>',
    )
  }
  const toSqlite = action === 'import'
  if (isSqliteGraph(from) === toSqlite || isSqliteGraph(to) !== toSqlite) {
    throw new Error(
      toSqlite
        ? 'import 是从 JSONL 搬到 SQLite：第一个路径不能以 .db / .sqlite / .sqlite3 结尾，第二个必须以它们之一结尾。'
        : 'export 是从 SQLite 搬到 JSONL：第一个路径必须以 .db / .sqlite / .sqlite3 结尾，第二个不能。',
    )
  }
  const copied = await copyGraph(from, to)
  process.stdout.write(
    `已复制 ${copied.records} 条记录：${from} → ${to}\n` +
      copied.companions.map((path) => `  连同 ${path}\n`).join('') +
      `原图谱没有改动。确认新图谱没问题后，用 --graph ${to} 启动。\n`,
  )
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
