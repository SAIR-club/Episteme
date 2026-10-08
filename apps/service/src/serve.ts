#!/usr/bin/env node
import { resolve } from 'node:path'
import { GraphLockedError } from '@episteme/application'
import { BLANK_TOPIC, loadTopicFile } from '@episteme/application/topic-file'
import type { SeedTopic } from '@episteme/application/seed'
import { learnProfile } from './profile.js'
import { DEFAULT_GRAPH, startService, type EpistemeService } from './server.js'

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
      `    -p, --port <端口>       监听端口（默认 4321）\n` +
      `    -t, --topic <路径>      首次启动时载入你自己的主题文件，而不是内置的示例主题\n` +
      `        --blank             从空图谱开始，什么都不载入\n` +
      `    -w, --workspace <目录>  在 / 托管一个已构建的 Workspace\n` +
      `    -h, --help              显示这份说明\n` +
      `\n  环境变量：EPISTEME_FILE 与 --graph 等效，PORT 与 --port 等效；命令行参数优先。\n` +
      `\n  只监听本机回环地址。这里没有身份验证：任何本机进程都能连上它，也能尝试确认建议。\n` +
      `  不要把它暴露到网络上。\n\n`,
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

/** Why the graph could not be opened, in words a person can act on. */
function lockedMessage(error: GraphLockedError): string {
  if (error.holderRunning) {
    return `这个图谱已经被另一个进程（PID ${error.holderPid}）打开了，比如正在运行的 Episteme 服务或 Learn 终端。\n请直接使用那个进程，或者先把它停掉。一个图谱同时只能有一个进程写入。`
  }
  return (
    `这个图谱被一个锁占着，但持有它的${error.holderPid === undefined ? '进程无法识别' : `进程（PID ${error.holderPid}）已经不在运行了`}。\n` +
    `这通常是上次被强行结束留下的。如果确定没有别的程序在用这个图谱，删除下面这个文件后再试：\n  ${error.lockPath}`
  )
}

const graph =
  optionValue(argv, '--graph', '-g', '--file', '-f') ?? process.env.EPISTEME_FILE ?? DEFAULT_GRAPH
const portText = optionValue(argv, '--port', '-p') ?? process.env.PORT ?? '4321'
const port = Number.parseInt(portText, 10)
const topicPath = optionValue(argv, '--topic', '-t')
const workspacePath = optionValue(argv, '--workspace', '-w')
const blank = argv.includes('--blank')

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
    profile: learnProfile(topic),
    ...(workspacePath === undefined ? {} : { workspace: resolve(workspacePath) }),
  })
} catch (error) {
  // Only the one failure a person can act on is translated. Anything else is a bug and keeps its stack.
  if (!(error instanceof GraphLockedError)) throw error
  process.stderr.write(`${lockedMessage(error)}\n`)
  process.exit(1)
}

process.stdout.write(
  `\nEPISTEME · 服务\n` +
    (service.workspaceUrl === undefined ? '' : `\n  Workspace：${service.workspaceUrl}\n`) +
    `\n  MCP：      ${service.mcpUrl}  （给 agent：读取你的理解、提出建议；它不能替你确认）\n` +
    `  REST API： ${service.apiUrl}\n` +
    `  图谱：     ${service.graph}\n` +
    (topic === undefined ? '' : `  主题：     ${topic.title}\n`) +
    `\n  你记录的一切都会写入磁盘，关掉进程也不会丢。\n` +
    `  只监听本机回环地址。这里没有身份验证：任何本机进程都能连上它，也能尝试确认建议。\n` +
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
