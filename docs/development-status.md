# 开发状态

本文是 v0.1.0 之后暂停开发时的交接记录：哪些部分已经定型、源码从哪里读起、哪些假设还没有验证、恢复开发时先做什么。它描述的是一个时刻的状态，项目恢复开发后应当随之更新或删除。

截至 2026-10-09，`main` 对应 v0.1.0（First Real Learning Loop），项目处于暂时维护状态，不再主动开发新功能。

## 已经定型的部分

以下部分由已接受的 ADR 决定，并有测试守护。改动其中任何一项都需要新的 ADR。

- **Core 只做图谱本身必须做的事**（ADR 0001）：词汇表先注册后使用，历史只追加，当前状态由事件归约得到，理解是多维状态而不是一个分数。
- **Agent 只能提出，学习者才能确认**（ADR 0008）：MCP 上没有确认工具；`confirmedBy` 只由服务端注入；所有决定经由唯一的决策路径。
- **蒸馏只产生建议**（ADR 0009）：原始材料保存在图谱之外，每条候选都带有原文出处。
- **单一持有者的 Service**（ADR 0010）：只有一个进程拥有图谱，在 `/mcp` 提供 MCP，在 `/api/v1` 提供 REST；Workspace 只是一个客户端。
- **Host 读，Episteme 校验**（ADR 0011）：引用在规范化后的原文中逐字核对，Host 必须显式标明 `basis`，提交可以幂等地重试。

## 核心源码入口

| 想了解                                   | 从这里读起                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| 图谱、状态事件、守卫                     | `packages/core/src/index.ts`                                            |
| Learn 词汇表、检索与蒸馏策略             | `packages/domain-learn/src/index.ts`、`retriever.ts`、`distillation.ts` |
| 用例层：recall、propose、decide、distill | `packages/application/src/session.ts`（`LearnSession`）                 |
| 草稿、决策预写记录、提交落地记录         | `packages/application/src/suggestions.ts`                               |
| 原始材料与提交记录                       | `packages/application/src/sources.ts`                                   |
| 蒸馏引擎与引用定位                       | `packages/distillation/src/engine.ts`、`quotes.ts`                      |
| Host 解读的校验与读取                    | `packages/distillation/src/host-reader.ts`                              |
| MCP 工具                                 | `packages/mcp/src/server.ts`                                            |
| Service、REST 与网络边界                 | `apps/service/src/server.ts`、`api.ts`、`boundary.ts`                   |
| Workspace 页面                           | `apps/learn/public/index.html`                                          |
| 闭环的可执行定义                         | `tests/cross-agent-loop.test.ts`                                        |

开发约定见 [AGENTS.md](../AGENTS.md)，架构全貌见[目标架构](architecture/target.md)，各版本的变化见 [CHANGELOG](../CHANGELOG.md)。

## 尚未验证的关键假设

v0.1.0 的闭环只在自动化测试中成立。以下假设决定它在真实使用中是否有意义，目前都没有证据。

1. **Claude Code 能连上 Service。** 它的 MCP 客户端能与本 Service 的 Streamable HTTP 握手，并能看到 4 个工具。
2. **Agent 的身份能被识别。** 提议者被记为 `actor_agent_claude-code`，而不是 `actor_agent_unidentified`。
3. **真实模型能逐字引用。** 它能把对话原文整理成 `说话人: 内容` 的形式，并逐字复制引用，被拒绝的比例可以接受。
4. **`basis` 被如实标注。** 模型只把学习者自己的原话标为 `stated`，其余都标为 `inferred`。
5. **审阅成本可以接受。** 学习者愿意审阅一次学习对话产生的候选，并能分辨哪些是自己的理解。
6. **理解会被复用。** 在一次全新的会话里，`recall` 能取回第一次确认的理解，回答也确实建立在它之上（路线图中的门槛 C）。
7. **确定性 embedding 够用。** 真实提问的措辞仍能匹配到已记录的理解。

## 已知风险

| 风险                                                 | 后果                                           | 跟踪                                                               |
| ---------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------ |
| REST 审阅接口没有身份授权                            | 带有 Shell 权限的 Agent 可以确认自己提出的建议 | [#17](https://github.com/SAIR-club/Episteme/issues/17)（ADR 0012） |
| Workspace 不显示 `basis` 与说话人                    | 学习者可能把 Agent 的推断当成自己的原话        | [#26](https://github.com/SAIR-club/Episteme/issues/26)             |
| `propose` 可以提议解决冲突；`resolved` 仍被读作冲突  | 违背"冲突保留而不被裁决"的精神；回答可能误判   | [#23](https://github.com/SAIR-club/Episteme/issues/23)             |
| `not_pending` 被误读为已驳回；`landing` 记录持续累积 | 错误的审阅统计；草稿文件持续增长               | [#25](https://github.com/SAIR-club/Episteme/issues/25)             |
| 数据以明文保存                                       | 本机其他进程和用户可以读取学习记录             | 路线图 Phase 4                                                     |
| `recall` 不区分作用域                                | 任何连上的 Agent 都能读到全部理解              | 路线图 Phase 4                                                     |
| `LearnSession` 职责过多                              | 加入第二个场景前必须拆分                       | 路线图加固事项                                                     |

## 恢复开发时先做什么

第一件事不是开发新功能，而是让真实学习者通过真实的 Claude Code Host 完成一次端到端的学习验证。

1. **准备。** 在仓库之外单独建一个图谱，从空图谱启动 Service：

   ```bash
   pnpm serve --graph "$HOME/.episteme/trial/learner-1.jsonl" --blank
   ```

2. **接入前检查。** 在 Claude Code 中接入 `http://127.0.0.1:4321/mcp`，确认能看到 4 个工具，`reflect` 能正常返回，以及提议者被记为哪个身份。任何一项不通过，就先修复，不进行后面的步骤。
3. **第一次学习会话。** 用一段提示词规定 Host 的行为：回答前先调用 `recall`；学完一段后调用 `distill` 提交带引用的候选；只把学习者原话标为 `stated`；不得调用 REST 审阅接口。
4. **审阅。** 学习者在 Workspace 中逐条决定。页面不显示 `basis`，所以观察者需要对照 `/api/v1/suggestions` 的数据检查。
5. **第二次学习会话。** 在全新的会话中提出相关问题，并与没有接入 Episteme 的会话对比，确认 `recall` 取回了第一次确认的理解，且回答建立在它之上。
6. **记录。** 按 [docs/testing/diagnosis.md](testing/diagnosis.md) 的流程诊断，结果写入 [docs/testing/human-validation-log.md](testing/human-validation-log.md)。

在这次验证完成之前，不要先开发插件、skill、对话树或新的理解评价机制。下一步做什么，应当由这次验证的结果决定。

## 仓库中需要知道的其他事项

- 协作者的 PR #4–#7 尚未处理，各自的影响说明见 [#14](https://github.com/SAIR-club/Episteme/issues/14#issuecomment-6065666922)。
- 主 checkout 中有一份 2026-10-04 的未提交工作，已经备份（`refs/backup/main-wip-20261008`，以及仓库外的备份目录）。哪些部分迁移、推迟或放弃，记录在 #14 中。
- 在 Windows 上，如果 `core.autocrlf=true`，直接运行 `pnpm format:check` 会因为 CRLF 报告所有文件不符合格式。应在按 LF 导出的提交上检查，或以 CI 的结果为准。
