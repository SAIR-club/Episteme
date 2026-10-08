#!/usr/bin/env node
import { homedir } from 'node:os'
import { join } from 'node:path'
import { GraphLockedError } from '@episteme/application'
import { lockedMessage, optionValue } from './cli.js'
import { startLearnServer } from './server.js'
import type { SeedTopic } from '@episteme/application/seed'
import { BLANK_TOPIC, loadTopicFile } from '@episteme/application/topic-file'

/**
 * Starts the Learn surface and prints where it is.
 *
 * The printed line is the whole interface: it says where to look and what is behind it. Nothing is opened
 * automatically, because a program that opens a browser is a program that acts without being asked.
 */
const DEFAULT_PATH = join(homedir(), '.episteme', 'learn.jsonl')

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(
    `EPISTEME · Learn —— 本地网页界面\n` +
      `\n  用法：pnpm learn:web [选项]\n` +
      `\n  选项：\n` +
      `    -f, --file <路径>    指定图谱文件（默认 ${DEFAULT_PATH}）\n` +
      `    -p, --port <端口>    监听端口（默认 4321）\n` +
      `    -t, --topic <路径>   从你自己的主题文件开始，而不是内置的示例主题\n` +
      `        --blank          从空图谱开始，什么都不载入\n` +
      `    -h, --help           显示这份说明\n` +
      `\n  环境变量：EPISTEME_FILE 与 --file 等效，PORT 与 --port 等效；命令行参数优先。\n` +
      `\n  主题文件是一个 JSON：{ "title": ?, "nodes": [{ "label": ?, "kind": ? }] }，\n` +
      `  kind 可以是 concept（默认）/ question / claim。\n` +
      `\n  只监听本机回环地址。这里没有身份验证，所以不要把它暴露到网络上。\n\n`,
  )
  process.exit(0)
}

const filePath = optionValue(argv, '--file', '-f') ?? process.env.EPISTEME_FILE ?? DEFAULT_PATH
const portText = optionValue(argv, '--port', '-p') ?? process.env.PORT ?? '4321'
const port = Number.parseInt(portText, 10)
const topicPath = optionValue(argv, '--topic', '-t')
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

let server: Awaited<ReturnType<typeof startLearnServer>>
try {
  server = await startLearnServer({
    port,
    filePath,
    ...(topic === undefined ? {} : { topic }),
  })
} catch (error) {
  // Only the one failure a learner can act on is translated. Anything else is a bug and keeps its stack.
  if (!(error instanceof GraphLockedError)) throw error
  process.stderr.write(`${lockedMessage(error)}\n`)
  process.exit(1)
}

process.stdout.write(
  `\nEPISTEME · Learn\n` +
    `\n  界面：  ${server.url}\n` +
    `  MCP：   ${server.mcpUrl}  （让 agent 读取你的理解、提出建议；它不能替你确认）\n` +
    `  图谱：  ${filePath}\n` +
    (topic === undefined ? '' : `  主题：  ${topic.title}\n`) +
    `\n  这是你自己认知图谱上的一个本地界面。你记录的一切都会写入磁盘，关掉进程也不会丢。\n` +
    `  只监听本机回环地址：这里没有身份验证，所以没有什么是可以暴露到网络上的。\n` +
    `\n  按 Ctrl+C 停止。\n\n`,
)

let stopping = false
const stop = (): void => {
  if (stopping) return
  stopping = true
  process.stdout.write('\n已保存。你记录的所有内容都在磁盘上。\n')
  server
    .close()
    .then(() => process.exit(0))
    .catch(() => process.exit(1))
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)
