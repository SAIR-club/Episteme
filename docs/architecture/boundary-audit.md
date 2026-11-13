# 边界审计：学习业务有没有渗进通用层

审计日期：2026-11-02，分支 `feat/boundary-and-recovery`。方法：在 `packages/core`、`agent`、`distillation`、`application`、`mcp` 里搜 learner、learn、teach、student 和中文同义词，逐处判断是行为还是措辞，再写一个非学习场景实际跑一遍。

## 结论

**没有发现阻止其他场景的耦合。** `apps/hypothesis` 用约 140 行实现了研究假设场景，没有改动 Core 和 Application 的任何行为，能提出、审阅、记录可信度、检索、跨会话复用、导出和恢复（`tests/hypothesis-scene.test.ts`）。

但通用层里还留着学习词汇，其中一部分已经写进持久数据，改名需要迁移。下面逐项列出，没有清理的部分写明原因。

## 分层结果

| 层 | 发现 | 判断 | 处理 |
| ---- | ---- | ---- | ---- |
| Core | 只有注释里的例子，如 `scene:learn` | 没有行为耦合 | 不动 |
| Agent | `types.ts` 注释 | 没有行为耦合 | 不动 |
| Distillation | `rule-based.ts` 的 `DEFAULT_LEARNERS` 说话人列表和 `learnerSpeakers` 选项 | 只是默认值，场景可以覆盖 | 不动 |
| Application | `session.ts` 的 `options.scene ?? learnScene` 回退 | 忘记传场景时会静默变成学习场景，这是唯一有风险的默认值 | 列入待办，不在本轮改，现有 API 和测试依赖它 |
| Application | `LEARNER_LABEL`、`source: 'learn-surface'`、`DecisionChannel 'learn-review'`、`speaker: 'learner'`、`LearnSession` 别名 | **已持久化或上线的值**。假设场景的事件里也写着 `source: "learn-surface"`，语义不准确 | 2026-11-13 起新写入用 `review` 和 `session`，与团队仓一致；旧记录不改写，读取和 `?channel=` 筛选把 `learn-review` 当作 `review`（`tests/channel-names.test.ts`）。旧事件的 `source` 是来源记录，保持原样。其余几项不动 |
| MCP | 工具说明里约 49 处 “the learner”，每个宿主都会读到，不管是什么场景 | **真实的渗透**：会让宿主模型把研究者当学生 | **已改**为 “the person”。线上参数 `learner` 和 `speaker: 'learner'` 不变 |
| Service | 默认 profile 用 `learnScene` | 合理：这是这个产品的默认场景 | 不动 |
| `packages/domain-forum` | 只有 README 的占位包 | 名不副实，但无害 | 列入待办 |

## 扩展点

| 扩展点 | 状态 | 证据 |
| ---- | ---- | ---- |
| `DomainPack`（维度、节点类型、关系） | 可用 | 假设场景的 `credence` 维度。写入非本场景维度会被 422 拒绝 |
| `SessionScene`（包、蒸馏策略、可记录维度） | 可用 | `hypothesisScene`；`tests/scene-extensions.test.ts` 里还有一个辩论场景 |
| `SceneProfile.routes` | 可用 | 假设场景的三个路由。`SceneView` 只能读和提议，不能决定 |
| `EvaluationPolicy` | **代码里不存在** | PRD 提到这个名字，仓内没有这个类型。最接近的是 `DistillationPolicy`。本轮没有新增：还没有场景需要 |

## REST、MCP、SDK 一致性

`tests/hypothesis-scene.test.ts` 用同一个图验证：REST 写入并接受，MCP `recall` 读到同样的节点和可信度，服务关闭后 SDK `openEpisteme` 直接读文件，也得到同样的节点和状态。MCP 没有 `decide`、`accept`、`record` 工具。

文档核对后修正：`packages/mcp/README.md` 只列了 4 个工具，实际有 9 个，已补全。

## 真实宿主发现的问题

Mock 测试全过的情况下，真实 Claude Code 跑出一个语义缺陷：人已接受但没标记理解程度的主张，`recall` 说“没有记录过任何东西”，宿主模型因此把它当成无关文本，拒绝据此回答。跨会话复用在形式上通过，在含义上失败。

修复：`RankedView` 增加 `kept`，表示这段话在此人自己的图里；措辞改为“没有标记理解程度”；工具说明写明 kept 不等于理解。详见[宿主测试记录](../testing/host-e2e-log.md)。golden 文件 `tests/golden/v0.1/expected.json` 为此手工改了 `kept` 字段和一句措辞，存储数据的读取结果没有变。

## 待办（未在本轮处理）

1. `session.ts` 的 `learnScene` 回退改为必须显式传入，需要调整所有调用方。
2. ~~持久值 `learn-surface`、`learn-review` 的中性化~~：新写入已改名，旧值靠读取时的别名兼容，没有迁移。
3. `recall` 的中文摘要是写死的，英文场景也会读到中文。
4. 删除或实现 `packages/domain-forum`。
5. seed 节点的作者也是 human，所以在带示例种子的图里 `kept` 也为真。空图不受影响。
