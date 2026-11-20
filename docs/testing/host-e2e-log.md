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

## 复现

需要已认证的 Claude Code，会花费真实模型额度。

```bash
pnpm exec tsc -b
```

```bash
node scripts/host-e2e.mjs --scene hypothesis --model haiku
```
