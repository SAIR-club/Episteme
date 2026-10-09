# Contributing to Episteme

Thanks for helping build Episteme — open cognitive infrastructure for carrying, organizing, and evolving human understanding.

[English](#english) · [简体中文](#简体中文)

---

## English

### Ways to contribute

- **Bug reports & invariants** — state violations, invalid graph mutations, serialization bugs.
- **RFC & Architecture** — open an issue before submitting non-trivial API or ontology changes.
- **Domain extensions** — write pluggable domain packs that extend Episteme without modifying Core.
- **Docs & benchmarks** — improve documentation, architectural decision records (ADRs), or evaluation suites.

Security issues: do not open a public issue. Report privately via GitHub Security Advisories or contact maintainers directly.

### Development setup

Requirements:
- Node >= 20.11 (tested on Node 20 and Node 24)
- pnpm >= 11 (see `package.json` packageManager)

```bash
git clone https://github.com/SAIR-club/Episteme.git
cd Episteme
pnpm install
pnpm build
pnpm test
```

### Local checks (same as CI)

PR CI runs on GitHub Actions on both Node 20 and Node 24. Before opening a PR:

```bash
pnpm check
pnpm format:check
```

Or individual checks:
- `pnpm typecheck` — TypeScript build across all workspace projects
- `pnpm lint` — ESLint flat config inspection
- `pnpm format:check` — Biome format verification
- `pnpm test` — Vitest unit and integration test suite

### Project Invariants

Episteme is built around strict engineering invariants (see `AGENTS.md` for full definitions):
- **Core only does what the graph itself must do.** Application logic and recommendation algorithms belong outside.
- **Vocabulary must be registered before use.** Node types, edge types, and state dimensions must go through their registries.
- **History is append-only.** A `StateEvent` is never edited or deleted; current state is always folded from events (`reduce(events)`).
- **Understanding is multi-dimensional.** Never introduce a single scalar "mastery" score.
- **State belongs to the actor.** Two actors never share cognitive state.
- **AI is cognitive scaffolding, not the author of thinking.** AI inferences are suggestions requiring human confirmation.

### Pull requests & git workflow

1. One branch per task (`<type>/<short-topic>`).
2. Follow Conventional Commits: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`. PR title becomes the squash commit subject on merge.
3. Keep pull requests focused and include test coverage.

---

## 简体中文

### 参与贡献方式

- **缺陷反馈与不变量验证**：状态折叠错误、不合法图突变、持久化与序列化缺陷。
- **架构提案与 RFC**：涉及公共 API 或核心本体模型变动前，先开 Issue 讨论。
- **领域扩展包开发**：开发可插拔的领域 Pack（例如知识论坛、研究综述等），而非修改 Core。
- **文档与测试用例**：完善架构决策记录（ADR）、基准评测集与双语说明。

### 开发环境搭建

环境要求：
- Node >= 20.11（CI 矩阵覆盖 Node 20 与 Node 24）
- pnpm >= 11（查看 `package.json` 中的 packageManager）

```bash
git clone https://github.com/SAIR-club/Episteme.git
cd Episteme
pnpm install
pnpm build
pnpm test
```

### 本地检验命令（与 CI 门禁一致）

提交 PR 前必须确保本地检查全绿：

```bash
pnpm check
pnpm format:check
```

单独运行各子命令：
- `pnpm typecheck`：全工作区 TypeScript 增量编译与类型推导
- `pnpm lint`：ESLint 代码规范扫描
- `pnpm format:check`：Biome 极速格式校验
- `pnpm test`：Vitest 单元测试与端到端集成测试

### 核心工程不变量

- **底层微内核最小化**：Core 仅实现图谱基础设施，不侵入业务推荐、UI 交互与教学策略。
- **词汇必先注册**：节点类型、边类型、状态维度均须经过注册表校验，严禁代码动态拼接未经注册的类型。
- **事件日志只增不改**：`StateEvent` 永久只增追加，当前状态始终为事件流折叠导出结果。
- **认知状态多维正交**：认知状态由确信度、表达度、证据强度等多维向量构成，绝不压缩为单一分数。
- **状态归属于 Actor**：每个 Actor 拥有独立认知状态，两 Actor 间永不共享状态。
- **AI 是认知脚手架而非代笔人**：AI 推理内容均为建议状态（`suggested`），需由人类确认方可入图。
