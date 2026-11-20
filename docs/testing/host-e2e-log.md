# 真实宿主端到端记录

用真实的 Claude Code 连接真实的 Episteme 服务。脚本：[`scripts/host-e2e.mjs`](../../scripts/host-e2e.mjs)。

## 2026-11-02：Claude Code 2.1.316

**环境。** Windows 11，Node 24，分支 `feat/boundary-and-recovery`。空图放在仓库外的临时目录。内容是合成的。

**宿主配置。** `claude -p`，独立空目录，`--strict-mcp-config`，`--setting-sources project`，`--tools ""`，只允许 `mcp__episteme`，`--max-turns 8`，`--max-budget-usd 0.3`，`--no-session-persistence`。

**模型。** 通过本地 magpie 网关路由到 `auto/deepseek-v4.1-flash`，**不是 Anthropic 的模型**。MCP 客户端行为来自 Claude Code 本身，但工具选择和回答的措辞来自这个模型，换模型可能不同。

**步骤。** 脚本在宿主和服务之间放了一个记录代理：

1. 第一个宿主会话：`recall` → `propose` → `reflect`，告诉用户什么记录了、什么没记录。
2. 人通过 REST 接受建议。
3. 全新的第二个宿主会话，不共享上下文，只用 `recall` 回答。

分别在默认服务场景和研究假设场景各跑一遍。修复前后共 4 轮，每轮两个会话；修复后两轮共 $0.14（CLI 报告的估算）。

### 结果

| 问题 | 结果 | 证据 |
| ---- | ---- | ---- |
| 能连上 `/mcp` 吗 | 能，状态 `connected` | 宿主的 init 事件 |
| 工具列表 | 9 个工具全部可见 | `distill, expand, propose, recall, reflect, thread_append, thread_fork, thread_open, thread_summarize` |
| 用什么协议 | 2026-07-28。没有 `initialize`，身份和能力在每个请求的 `_meta` 里 | 代理记录：`server/discover`、`subscriptions/listen`、`tools/list`、`tools/call` |
| 提议者身份 | `actor_agent_claude-code` | `GET /suggestions` 的 `proposedBy` |
| 代理能替人决定吗 | 不能。第一个会话后什么都没写入图，建议处于 pending；模型也如实说明未记录 | `reflect` 和最终回答 |
| 新会话能复用吗 | 能（修复后），见下 | 第二个会话的回答 |

### Claude Code 支持 MCP elicitation 吗

**声明支持，`-p` 模式下自动取消。** 客户端声明 `elicitation: {form: {}, url: {}}`。`propose` 因此返回 `input_required`，宿主用 `inputResponses: {decision: {action: "cancel"}}` 重试了一次。这解释了记录里为什么有两次 `propose`。取消后草稿留在审阅队列，符合设计：取消不算决定。

**没有验证：** 交互模式下用户是否真的会看到表单、接受后能否走通。这需要真人在终端操作，本记录未覆盖。

### Codex

**未测试。** 不能据此对 Codex 下结论。

### 真实宿主发现的缺陷

修复前，第二个会话的模型回答：

> there is no recorded understanding to base an answer on

人明明接受了这条主张。原因是 `recall` 把“没有标记理解程度”说成“没有记录过任何东西”。Mock 测试看不出来，因为断言只检查节点 id 是否返回。

修复后（`kept` 字段和新措辞），第二个会话回答出了主张内容，同时说明 “this is recorded material rather than confirmed understanding”，既复用了内容，也没有说成已掌握。见[边界审计](../architecture/boundary-audit.md)。

### 局限

- 只验证了一个模型路由，单次运行，没有统计意义。
- 只验证了无头模式，没有真人在 Claude Code 里操作过。
- 回答的内容判断靠人工阅读。脚本的 `recalled` 只检查回答里出现关键词。

## 2026-11-19：OpenCode 2.3.0

**环境。** Windows 11，Node 24，分支 `scripts/host-e2e`（基于 `4d88f48`）。空图放在仓库外的临时目录。内容是合成的。

**宿主配置。** `opencode run --standalone --format json --archived --auto`，在独立的空目录里运行。该目录里的 `opencode.json` 只声明 Episteme 这一个 remote MCP，并禁用 `bash`、`edit`、`webfetch`。用户的全局 OpenCode 配置只读取，不修改。见 [`scripts/opencode-host.mjs`](../../scripts/opencode-host.mjs)。

**模型。** `magpie/auto/deepseek-v4.1-flash`，通过用户本机 OpenCode 里已经配好的 Magpie provider 调用，**不是 Anthropic 的模型**。

**限额。** OpenCode 没有预算参数，所以由脚本在外面强制：每个会话最多 8 步，OpenCode 估算的费用超过 `--budget`（0.025 美元）或超时（180 秒）就结束进程。费用是 OpenCode 按自己的价格表算出的估算值，不是 Magpie 的账单，这次没有和账单核对过。最大输出 token 没有限制。

### 结果

| 场景 | 步数 | 输入 / 输出 / 推理 token | 估算费用 | MCP 工具调用（都成功返回） | `recalled` |
| ---- | ---- | ---- | ---- | ---- | ---- |
| service | 5 + 3 | 10546 / 1003 / 222 | $0.0027 | `recall, propose, reflect, recall` | true |
| hypothesis | 5 + 5 | 11640 / 1222 / 732 | $0.0034 | `recall, propose, reflect, recall, expand` | true |

| 问题 | 结果 | 证据 |
| ---- | ---- | ---- |
| 能连上 `/mcp` 吗 | 能 | 代理记录：`initialize`、`notifications/initialized`、`tools/list`、`tools/call` |
| 用什么协议 | 2025-11-25，带 `initialize`。`clientInfo` 是 `opencode 2.3.0`，声明了 `elicitation: {form, url}` | 代理记录 |
| 怎么调工具 | OpenCode 先用 `search` 找到工具，再在一个 `execute` 代码工具里调用 `tools.episteme.recall(...)` 等工具。代理看到的是标准的 `tools/call` | OpenCode 的 JSON 事件 |
| 代理能替人决定吗 | 不能。第一个会话结束后只有一条 pending 建议，模型也如实说明还没有记录 | `GET /suggestions`，第一个会话的回答 |
| 新会话能复用吗 | 能。人接受建议后，新的会话通过 `recall` 拿到这条主张，并说明它“只是被保存，没有记录理解程度” | 第二个会话的回答，`recall` 返回的内容里有这条主张 |
| 提议者身份 | **`actor_agent_unidentified`**。用 Claude Code 时是 `actor_agent_claude-code` | `GET /suggestions` 的 `proposedBy` |

### 发现：OpenCode 的提议记成了“身份不明”

OpenCode 走的是带 `initialize` 的 2025-11-25 协议，`clientInfo.name` 是 `opencode`，但建议的提议者记成了 `actor_agent_unidentified`。原因是服务按无状态方式处理 MCP：`initialize` 和之后的 `tools/call` 是两个互不相关的请求，而 2025 年那一版协议的 `tools/call` 里不带身份。`agentActorFor`（`packages/mcp/src/server.ts`）的处理是有意的：宁可写“身份不明”，也不去猜。Claude Code 走的是 2026-07-28 协议，每个请求的 `_meta` 里都带身份，所以能认出来。这不影响“提议 → 人决定 → 复用”这个闭环，只是审阅队列里看不出是哪个代理提议的。这里只做记录，没有改内核。

### 局限

- 只验证了一个模型路由，每个场景只跑了一次，没有统计意义。
- OpenCode 声明支持 elicitation，但这次 `propose` 没有发起表单，所以表单流程没有验证。
- 费用是 OpenCode 自己的估算，没有和网关账单核对。

## 复现

用 Claude Code 作宿主：需要已登录的 Claude Code，会花费真实模型额度。

```bash
pnpm exec tsc -b
```

```bash
node scripts/host-e2e.mjs --scene hypothesis --model haiku
```

用 OpenCode 作宿主：需要 OpenCode 里已经配好可用的 provider。`--model` 填你自己配置里的 `provider/model`。

```bash
node scripts/host-e2e.mjs --scene service --host opencode --model magpie/auto/deepseek-v4.1-flash --budget 0.025
```
