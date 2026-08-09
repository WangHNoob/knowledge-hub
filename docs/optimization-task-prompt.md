# 任务提示词：优化 knowledge-hub 性能、工具质量与 Token 消耗

> 本文件是交给**另一个 agent** 的任务提示词。你的职责范围仅限 `knowledge-hub` 工程（`C:\Users\aaaab\Desktop\个人项目\knowledge-hub`），**禁止修改 design-agent-ts 与 agent-observe 的任何代码**。

---

## 一、背景

三工程协作栈：design-agent-ts（Agent，端口 13000）通过 MCP 调用 knowledge-hub（端口 4174）的 `kb_*` 工具做知识查询。2026-08-09 知识库升级 v0.2（49 篇文档 / 204 张 CSV）后，78 题黄金评测暴露了 knowledge-hub 侧三类问题：**工具返回体过大（token 爆炸）**、**工具设计缺陷（模型重复调用、参数类型不兼容）**、**MCP 工具缺失（kb_faq_match 未暴露）**。

评测结果与失败归因见 `evals/eval_report_2026-08-09_query-mode-v02.md`。你的优化目标是把工具侧的平均返回体、无效调用率和性能提上来，让 Agent 单题 token 消耗显著下降。

## 二、已证实的证据（来自 2026-08-09 评测 trace）

### 1. 工具返回体过大 —— 最大 token 杠杆
- Agent 单题上下文从 ~11k 增长到 65k~167k token，主要被工具结果（KB envelope）撑大；6 题因累计消耗超 500k 预算失败（EV-021/027/060/065/071/077）。
- 已知结构问题（`knowledgeQueryService.ts` 的 envelope 构造）：
  - 每个工具响应都带完整 `contract` + `release` + `trust`（含 breakdown/reasons/caps）+ `trace` 元数据段，对模型是噪声；
  - `toolResult` 存在**双重 JSON 编码**（外层字符串 + 内层转义 `\"`）与 `[来自黑板缓存]` 前缀（agent 端 `parseJsonWithPrefix` 已做兼容，但模型侧看到的仍是双重编码文本）；
  - `kb_list_tables` 返回全部 204 张表的 schema（一张表就几十个字段），一次调用上万 token；
  - 观测用属性（qualityFlags、trust 详情）与模型消费共用同一份结果，没有"模型视图"与"观测视图"的区分。

### 2. 工具设计缺陷 —— 模型重复调用
- EV-021 trace：模型对 `ShopItem` 表**连续 5 次**重复调用 `kb_query_table`/`kb_get_table_raw`（参数几乎相同），最终仍失败 —— 说明工具结果没有让模型"一次看明白"。
- 参数类型不兼容：模型经常发 `{"limit": "40"}`（字符串）而 schema 要求 number（zod 虽然兼容了，但说明 schema 不够宽容/文档化不足）。
- `kb_get_table_raw` 暴露 headerRows 参数但模型需要反复摸索。

### 3. MCP 工具缺失
- `kb_faq_match` 未在 MCP 工具列表中暴露（agent 端 FAQ 快速通道 78/78 次 `faq.unavailable tool missing`），FAQ 快路径完全未生效。

### 4. 性能/稳定性
- 评测轮中 `tool.circuit.kb_query_table` 熔断打开过（Agent 连续失败触发熔断后仍继续调用）。

## 三、任务范围与目标

### P0：工具输出瘦身（模型视图 vs 观测视图分离）
1. 为 `kb_*` 工具增加**精简输出模式**（或默认精简 + `detail=full` 参数显式开启）：模型视图只保留 `result` + 必要 ID/来源，去掉 contract/release/trust/trace 等元数据段；观测/审计需要全量时通过现有观测通道（qualityFlags、audit）保留，不进模型上下文。
2. 修复双重 JSON 编码：`toolResult` 保持单一 JSON 序列化层级，去掉字面量 `\"` 转义与 `[来自黑板缓存]` 前缀（或把前缀移入非内容字段）。
3. `kb_list_tables` 增加分页/过滤（按表名前缀、按关键词），默认不返回全量字段；`kb_get_table_schema` 已有单表能力，评估 list 是否可只返回 `[{table, rowCount}]` 清单。
4. 全工具结果增加**可配置 token 上限**（如单次 ≤ 4000 token），超出部分截断/折叠，返回时标注 `truncated: true`。

### P1：工具质量
5. 参数 schema 宽容化：`limit`、`offset`、`headerRows` 等数字参数接受字符串自动转型；所有布尔/枚举参数给出清晰描述。
6. 检查 `kb_query_table`/`kb_get_table_raw` 结果对"查找单行答案"场景的友好度：是否可返回"表头 + 命中行 + 行号"的精简结构，减少模型二次调用。
7. 熔断与限流：评估 `mcpRateLimit` 与工具级熔断配置是否合理，避免评测并发下误熔断。

### P2：FAQ 快速通道
8. 暴露 `kb_faq_match` 工具（若 FAQ 数据源已就绪），或在 agent 端 FAQ 通道未就绪时明确降级标记（不要在日志里静默 unavailable 78 次）。

### 性能
9. 检索链路（okf search / hybrid search / 表查询）耗时剖析：评测单题 45~51s 中工具往返占比多少；索引加载、查询、序列化各耗多少；给出 ≥20% 的端到端检索延迟优化（或证明瓶颈在 agent 侧）。

## 四、硬性约束

- **只改 knowledge-hub**：不修改 design-agent-ts（LLM 重试/上下文压缩由另一个 agent 负责）与 agent-observe。
- **不破坏协议**：`knowledge-envelope/v1` 的稳定字段（contract/release/result/qualityFlags/trust/trace）在"观测视图"或 `detail=full` 下必须保留；agent 端已有 `parseJsonWithPrefix` 兼容逻辑，你的改动**不得依赖**它的行为，但可以配合其简化。
- **回归门槛**：
  1. `npm run build` + `npm test` 通过；
  2. `python evals/audit_evals.py --kb-dir knowledge --evals evals/golden_evals.json` 仍 47/47 通过（不得因输出改动改变审计所需数据）；
  3. 用 `design-agent-ts/scripts/probe-kb-v02.mjs`（MCP SDK 探测）验证改造后各 `kb_*` 工具返回体的 token 量级（改造前后对比表）。
- 改完**不启动评测**（评测由主会话统一跑），但需提供"改造前后单工具返回 token 对比"的量化报告。

## 五、输出要求

1. 变更清单（文件级）与每个变更的动机；
2. 工具返回体 token 对比表（改造前 → 后，至少覆盖 kb_list_tables / kb_search / kb_query_table / kb_get_page / kb_get_table_raw）；
3. 性能剖析结论（若做了）；
4. 已知权衡（如精简模式对审计/评分的影响）；
5. 若某项 P0/P1 无法完成，说明原因与替代方案。
