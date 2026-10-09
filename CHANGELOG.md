# 更新日志

本文件记录 Episteme 各版本中使用者能感知到的变化。版本号遵循语义化版本，目前处于 0.x 阶段：次版本号带来新能力，修订号只用于修复。条目依据 `git log` 整理，详细说明见各版本的发布说明。

## [0.1.0] - 2026-10-09

**First Real Learning Loop**，第一个开发预览版（Developer Preview），不是面向普通用户的稳定版本。发布说明见 [docs/releases/v0.1.0.md](docs/releases/v0.1.0.md)。

本版第一次把下面这个闭环完整实现，并用自动化测试证明：

```text
Agent A 提交带原文证据的候选理解
  → Episteme 校验引用并保存来源
  → 学习者审阅确认
  → 理解进入图谱
  → Agent B 通过 recall 取回已确认的理解
```

这个闭环尚未由真实的 Claude Code Host 和真实学习者走通过。

### 新增

- **认知图谱核心**（`@episteme/core`）：注册制词汇表、图谱、守卫（guard）、只追加的状态事件日志、分支（fork）、投影与检索。理解是多维状态，没有单一的掌握度分数。
- **持久化**（`@episteme/storage-local`）：图谱与事件历史写入本地 JSONL 文件，重启后完整恢复；同一图谱同时只能被一个进程打开。
- **检索**：词法、语义、图结构、认知状态与时间多信号混合排序，每条结果附带各信号的贡献；另有基于 HTTP 的 embedding 适配器（`@episteme/embeddings-http`）。
- **Learn 场景**（`@episteme/domain-learn`、`apps/learn`）：中英文学习界面，可以提问、查看检索依据、记录自己的理解，并查看"已经理解了什么"。
- **Agent 接入**（`@episteme/mcp`）：通过 MCP 提供 `recall`、`propose`、`reflect`、`distill` 四个工具，没有任何确认工具。
- **人工审阅**（`@episteme/application`）：所有建议先作为待审草稿保存，只有学习者接受、修改后才进入图谱；决策过程有预写记录，崩溃后可恢复，且不会重复生效。
- **蒸馏**（`@episteme/distillation`）：把学习材料或对话切分为学习片段，由规则型读取器提取候选的问题、论断、证据与术语，每条候选都附带原文出处。
- **Host 辅助蒸馏**（ADR 0011）：Host 的模型可以提交自己对材料的解读。Episteme 在规范化后的原文中逐字核对每一条引用，要求每条候选标明 `stated` 或 `inferred`，支持跨片段的修正关系（`revises`）。按 `submissionId` 重试是幂等的，草稿写入失败后可以恢复。
- **Episteme Service**（`apps/service`，ADR 0010）：唯一持有图谱的进程，在 `/mcp` 提供 MCP，在 `/api/v1` 提供带版本的 REST，并托管 Workspace 页面。
- **跨 Agent 验收测试**：两个 MCP 客户端共享一个 Service，证明一个 Agent 提出、学习者确认的理解，能被另一个 Agent 取回。

### 修复

- 决策过程在写入失败或进程中断后不会重复生效，也不会丢失（`fix(application): make decisions crash-consistent and idempotent`）。
- 同一会话中的修改按顺序执行，两个决定不会同时作用于同一条草稿。
- 带 `submissionId` 的提交只有在草稿真正入队后才算完成；草稿写入失败后重试会重新处理，而不是报告为已提交。
- Service 的 HTTP 边界拒绝来自其他网页的请求（Host、Origin、`Sec-Fetch-Site` 检查），Workspace 静态文件不会越出其目录。

### 已知限制

真实 Host 尚未验证；REST 审阅接口没有身份授权；Workspace 尚未显示 `basis` 与说话人；检索受确定性 embedding 限制；`not_pending` 不等于已驳回；数据以明文保存在本地。详见[发布说明](docs/releases/v0.1.0.md#已知限制与安全说明)。

[0.1.0]: https://github.com/SAIR-club/Episteme/releases/tag/v0.1.0
