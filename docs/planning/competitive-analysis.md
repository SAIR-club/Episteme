# 竞品调研（2026-10-17）

市场上与"沉淀理解"相关的产品做到了哪一步，Episteme 和 MindLink 的差异在哪里，"共享理解"能不能成为护城河。很多数字来自
二手报道或厂商自己发的文章，引用前请核对原始来源。

## 一、各类产品做到了什么

| 类别 | 代表 | 做到了什么 | 对我们意味着什么 |
| --- | --- | --- | --- |
| 资料理解与学习 | NotebookLM | 基于来源的问答与引用；闪卡、测验、进度；Learning Guide 导师模式；公开分享笔记本、专家精选笔记本 | "导入资料 → 学 → 分享知识库"已经被做了 |
| 开源 NotebookLM | Open Notebook（MIT）、Khoj（AGPL）、SurfSense（Apache） | 自部署、多模型、播客、团队协作 | 资料摄取可以借鉴，不必重写 |
| LLM wiki 模式 | Karpathy llm-wiki（2026-04）及几十个实现 | LLM 把资料增量编译成互链的 markdown wiki | 被批评的问题是 LLM 的错误被固化、压缩失真、内容过时，而且没有人确认这一层 |
| Agent 记忆 | Mem0（OpenMemory MCP）、Letta、Zep/Graphiti、Supermemory | 跨工具共享记忆，时序知识图谱 | "所有 agent 共享一份记忆"有成熟方案；它们存的是给机器检索的碎片，不是人确认过的理解 |
| 结构化笔记 | Heptabase（含 MCP）、Tana、RemNote | 个人知识图谱、AI 问答、间隔复习 | 只服务个人 |
| 引导式学习 | ChatGPT Study Mode、Gemini Guided Learning、Claude Learning Mode | 都是苏格拉底式提问、不直接给答案 | 引导式提问单独拿出来不构成差异 |
| AI 课程生成 | Oboe | 一句话生成课程、播客、闪卡 | 与"领域地图、路径规划"模块重叠 |
| 国内学生入口 | 夸克、豆包爱学 | 拍题、搜索、讲题、错题整理 | 不正面竞争 |
| 工作流市场 | Dify 模板市场、Coze | 模板发布、安装、图结构预览 | 分享 workflow 的形态可以照搬 |
| 共享学习内容 | Studocu、Quizlet、AnkiHub/AnKing、Knowunity、Glasp | 见下节 | 护城河问题的关键证据 |

## 二、共享生态的证据

**通用答案的共享正在被 AI 替代**：Chegg 2025 年第一季度订阅用户下降 31%、营收下降 30%，随后裁员 22%；Stack Overflow
2025 年 12 月月提问数 3,862，同比下降 78%；Wikipedia 2025 年真人浏览量同比下降约 8%。

**这类共享仍然活得很好**：Studocu（据称月活约 6000 万，共享具体课程的笔记和往年题）、AnkiHub/AnKing（有人持续维护、
付费订阅的考试卡组）、Knowunity（数百万学生的笔记社区）、Quizlet。

规律：AI 能当场生成的内容，共享就没有价值。共享仍然活着，是因为内容**本地且具体**（这门课、这个老师怎么考），**有人维护、
可信**，而且**绑定明确的目标**（考试）。

## 三、结论

1. **共享通用知识不是护城河**，它会和 Stack Overflow、Wikipedia 一样被 AI 替代；"分享知识库"NotebookLM 也已经做了。
2. **别人没有共享过的，是 Episteme 的结构**：某人从不懂到懂的提问路径；一门课里大家普遍卡住的点和误解；理解的修正历史；
   哪条理解是人确认的，哪条只是 AI 推断的。
3. **护城河的形成机制，是共享数据驱动引导**："AI 比你都懂你想问什么"只靠一个人的数据做不到，大厂的学习模式也拿不到同一门课
   群体的数据。用的人越多，预测的问题越准，这是数据网络效应。所以共享是引导的燃料，不是一个独立功能。
4. **冷启动要窄**：网络效应靠密度，不靠规模。第一步只做一门课 × 一个年级。
5. **开源项目的护城河是数据和社区**，不是代码。

一句话定位：**一个记得你理解到哪、也记得别人卡在哪的学习层。**

## 四、可以直接借鉴的

| 借鉴对象 | 借什么 |
| --- | --- |
| Open Notebook、NotebookLM | 资料摄取与引用的交互（我们的引用逐字校验已经更严格，见 ADR 0011） |
| Mem0 OpenMemory | 跨工具记忆的 MCP 分发方式 |
| Dify 模板市场 | workflow 分享页：详情页直接展示工作流的图结构 |
| Studocu、AnkiHub | 按学校、课程、考试打标签；设维护者角色 |

## 五、对计划的影响

- 对外定位从"共享知识图谱"改为"同一门课同学之间的共享理解"。
- 引导式提问的指标：被预测的问题被点选的比例；从开始学到通过自测所用的时间。
- 1k star 来自开发者，不来自学生，所以由 Episteme 以 MCP 插件的形式承担。本月比赛优先，Episteme 的对外发布（英文 README、一行安装、演示）排在最后一周，见 [#46](https://github.com/SAIR-club/Episteme/issues/46)。

## 来源

- NotebookLM：[Android Authority](https://androidauthority.com/notebooklm-flashcards-edit-learning-3680276)、[Chrome Unboxed](https://chromeunboxed.com/massive-notebooklm-update-adds-ai-powered-flashcards-quizzes-and-a-personal-tutor-mode/)、[公开与精选笔记本](https://support.google.com/notebooklm/answer/16322204)
- 学习模式对比：[Glasp](https://glasp.ai/articles/ai-study-modes-compared)、[Tom's Guide](https://www.tomsguide.com/ai/i-tested-chatgpt-5-study-mode-vs-claude-learning-mode-with-7-prompts-heres-the-winner)
- LLM wiki：[DenserAI](https://denser.ai/blog/llm-wiki-karpathy-knowledge-base/)、[Neo4j](https://neo4j.com/?p=429386)
- 开源 NotebookLM：[对比](https://rohitraj.tech/en/notes/open-notebook-vs-khoj-vs-surfsense-notebooklm-2026)
- Agent 记忆：[Braintrust](https://www.braintrust.dev/articles/best-ai-agent-memory-tools-2026)
- 结构化笔记：[Fabric](https://fabric.so/comparison/heptabase-vs-tana)
- 共享生态：[Chegg](https://www.maginative.com/article/chegg-slashes-22-of-workforce-amid-ai-disruption-in-edtech/)、[Stack Overflow](https://devclass.com/2026/01/05/dramatic-drop-in-stack-overflow-questions-as-devs-look-elsewhere-for-help)、[Wikipedia](https://techcrunch.com/2025/10/18/wikipedia-says-traffic-is-falling-due-to-ai-search-summaries-and-social-video)、[Studocu](https://tech.eu/2026/01/27/how-studocu-is-redefining-exam-prep-with-ai-and-over-50-million-documents/)、[AnkiHub](https://www.mheducation.com/about-us/news-insights/press-releases/mcgraw-hill-begins-collaboration-with-ankihub.html)、[Knowunity](https://www.cognee.ai/blog/case-studies/cognee-knowunity-connects-learners)
- 其他：[Oboe](https://korben.info/en/oboe-ai-generates-courses-seconds.html)、[Dify 模板市场](https://dify.ai/blog/build-share-earn-dify-creator-center-and-template-marketplace-are-now-live)、[夸克（品玩）](https://www.pingwest.com/w/307513)
