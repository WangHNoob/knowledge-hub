# MCP 知识库循环测试报告

> 测试对象：Knowledge Hub 知识飞轮（仅通过 MCP 工具访问，未直接读取数据库/源码/OKF/构建产物）
> 项目：`default_project` ｜ 当前发布：`rel_20260703033246_AHJdTP` ｜ manifestHash：`sha256:bf2dc0a9…747b1efe`
> 执行日期：2026-07-06
> 测试依据：`docs/claudecode-mcp-loop-test-plan.md`

---

## Loop 0 - 连接与基线

结论：**partial（部分通过）**

工具链：
`kb_get_flywheel_status` -> `kb_get_release` -> `kb_list_pages` -> `kb_list_tables` -> `kb_list_entities`

命中：
- Page：1454 个组件，Wiki 页面可枚举（如 pvp活动模板.md、庆典服专属活动.md）
- Table：`totalMatched: 1254`，含 `_AccumulativePay`、`Equipment` 等
- Graph entity：可枚举（Activity/Bag/Boss/config 等）

信任（Trust）：
- level：unknown（基线聚合态，正常）
- evidenceCount：0（基线态）
- sourceRefs：[]
- lastPublishedAt：Fri Jul 03 2026 11:32:46 +0800
- negativeFeedbackCount：0
- lintStatus：unknown
- correctionStatus：none
- ruleProfileHash：`sha256:2fa8d8e2…bdfb8d29`

发现的问题：
- **`kb_get_release` 持续报错 `MCP server "knowledge-hub" session expired`**，全程 5 次尝试（含全新 sessionId）全部失败，而同批次其余全部工具正常。属工具级确定性缺陷。
- 缓解项：`release` 信封块（releaseId/version/manifestHash/publishedAt）在**每个**其他工具的返回中都存在，因此发布信息实际可获取——未触发硬停止条件。

治理结果：
- correctionId：—
- checkRun：—
- publishResult：—
- skipReason：—

平台需修复项：
- 修复 `kb_get_release` 的会话/鉴权处理，使其与其他工具一致可用。

---

## Loop 1 - Wiki 知识查询

结论：**pass（通过）**

工具链：
`kb_search` ×5 -> `kb_get_page` -> `kb_get_evidence` -> `kb_get_quality` -> `kb_get_page_tables`

命中（5 个主题全部命中且相关）：
- 荣耀连战 → `荣耀连战.md`（system_rule，score 207，trust 0.861）
- 竞技狂欢 → `pvp活动模板.md`（total 5）
- 阵法特权 → `阵法特权.md`（trust 0.9）
- PVP 活动 → `pvp活动模板.md`（total 5）
- 奖励/商店/排行榜/体力 → `战至巅峰.md`/`神秘商店.md` 等（total 5）

信任：
- level：high ｜ evidenceCount：1–6 ｜ sourceRefs：均有（如 `processed/parsed/荣耀连战.md`）
- lintStatus：passed ｜ correctionStatus：none ｜ negativeFeedbackCount：0
- ruleProfileHash：`sha256:2fa8d8e2…bdfb8d29`

发现的问题：
- none。页面正文（装备/宝石更换拦截规则）与结构化依赖（Equipment、Gem）一致；证据可追溯；`why` 字段对策划可读。

治理结果：全部 —

平台需修复项：
- 建议：`unresolvedDependencies` 里大量中文口语依赖（如「宝箱奖励配置（config）」）未解析为规范表名，会削弱下游表工具的可用性（非阻断）。

---

## Loop 2 - 表消费

结论：**fail（不通过）**

工具链：
`kb_get_table_schema` -> `kb_query_table` -> `kb_validate_table` -> `kb_check_table_value` -> `kb_list_tables(装备)`

命中：
- Table：`Equipment`（schema 46 字段，row_count 848）、`MysteryShop/MysteryShopBuy`（7 字段）

信任：level high，table trust 0.938（`证据非强制 100% / 规格全面性 75% / 一致性 100%`）

发现的问题（核心缺陷）：
1. **schema 字段名与可查询行键完全脱节**：`kb_get_table_schema` 声明规范字段（`equipId`、`equipType`…），但 `kb_query_table` 返回的行是按**位置/中文表头**键化的（`"1"`、`"7"`、`"__EMPTY"`、`"装备id"`…）。二者无法对应。
2. **`kb_validate_table` 把全部 schema 字段列为 `missingFields` 且 `valid:false`**：Equipment（schema 848 行 / validate 报 828 行、46 字段全「缺失」）、MysteryShopBuy（7 字段全「缺失」）。校验错误**不可执行**——只堆列字段，未解释表头行偏移导致的比对错位。
3. **`kb_check_table_value(equipId=1)` 返回 `matches:[]`**：因行数据无 `equipId` 键，按规范字段名过滤必然落空。
4. 中文别名 `装备` 经 `kb_query_table` 返回 `found:false`（该表未配置别名，属可接受，但叠加上面问题使表路径整体不可用）。

治理结果：—

平台需修复项（最高优先级）：
- 统一「schema 规范字段名」与「`kb_query_table` 行键」：查询结果应以规范字段名（或提供字段名↔列位映射），使 `validate`/`check_table_value`/`filters` 可按 schema 字段工作。
- 修复 `kb_validate_table` 的表头行识别，使其不再把正常表全部字段误报为缺失。

---

## Loop 3 - 图谱消费

结论：**pass（通过）**

工具链：
`kb_resolve_topic` -> `kb_get_entity` -> `kb_get_neighbors` -> `kb_get_relations`

命中：
- Graph entity：`荣耀连战`（topic 解析出 entity + page 双候选）、`Equipment`（config_table，回链 `荣耀连战.md`）
- 邻居/关系：`荣耀连战限制状态 --affects--> Equipment/Gem`、`--produces--> 装备更改限制弹窗`、`--configured_by_field--> 段位惩罚配置表`

信任：level high，trust 0.938，标签充分可用于推理。

发现的问题：
- none（功能性）。`kb_get_relations(source=Equipment)` 返回 `edges:[]` 属正确——Equipment 仅有入边；换 `source=荣耀连战限制状态` 即正常返回出边。关系与页面正文一致。

治理结果：—

平台需修复项：none。

---

## Loop 4 - 反馈回流

结论：**pass（通过，含产品建议）**

工具链：
`kb_search(不存在主题)` -> `kb_report_gap` -> `kb_report_bad_hit` -> `kb_get_flywheel_status`

命中：
- 探针查询「跨服婚姻系统结婚流程」→ 平台返回 `status:hit`（弱匹配，仅命中通用词「系统/流程」，`why` 标注「缺少核心词」）

信任：反馈后 `negativeFeedbackCount` 由 1→2，correctionStatus none→pending。

发现的问题：
- **弱匹配伪命中**：明显不存在的主题被判为 `status:"hit"`，可能误导策划。建议对「仅命中通用词/缺少核心词」的结果降级为 `low_confidence`/`near_miss`。

治理结果：
- correctionId：—（本 Loop 为反馈）
- 反馈记录：`task_mcp_knowledge_gap_lqliH0`（gap，warning）、`task_mcp_bad_hit_uMuDnM`（bad_hit，warning），均带 `targetComponentId` + 可执行 `suggestedAction`
- checkRun：反馈自动触发**定向重建** `run_20260706111650283`（`rebuildTaskId: task_rebuild_…6b3ef02b9d`，已完成）——事件驱动自动化验证有效
- **注意**：`kb_get_flywheel_status` 的 `gates.blockingTasks:0`、`corrections` 为空，未把这两条 review 任务/负反馈作为「例外」暴露在该信封中。

平台需修复项：
- 弱匹配应显式降级，不应统一报 `hit`。
- flywheel status 信封应可见 pending review 任务/负反馈计数（当前仅触发重建，未在状态里体现例外）。

---

## Loop 5 - 分级修正治理

结论：**partial（部分通过）**

工具链：
`kb_govern_flywheel(wiki, 失败)` -> `kb_submit_correction(wiki, 失败)` -> `kb_govern_flywheel(table, 成功)` -> `kb_get_correction_status` -> `kb_govern_flywheel(check+publish)`

命中：修正锚定组件 `…processed_parsed_1014_md…`（家园装饰优化1014.md）

信任：table trust 0.938。

发现的问题：
1. **Wiki 页面组件无法创建修正**：对 `荣耀连战.md`、`阵法特权.md` 均报 `has no source reference; correction cannot be anchored`，即便其证据记录含 `sourceVersionId` 与 `okfPath`。`kb_submit_correction` 对 Wiki 组件不可用。
2. **源路径锚定到错误组件（mis-anchoring）**：我以 `sourcePath=gamedata/Equipment.xlsx` 提交，系统却锚到「家园装饰优化1014.md」（只是其 sourceRefs 里恰好含 Equipment.xlsx），而非目标表——锚定取「首个引用该源的组件」。

正向验证（通过部分）：
- 修正在**暂存态**创建：`state: pending_review` → `apply` 后 `active`，带 `boundSourceHash`（不可变锚）。
- 生命周期可追踪：`kb_get_correction_status` 返回 `correction.submitted` 事件链。
- 增量检查可启动：`incremental_check status: started`（`run_20260706112251402`）。
- 发布门禁按可接受原因跳过：`publish_if_ready status: skipped, reason: "no_completed_build"`（重建未完成，属白名单原因）；`check=false/publish=false` 时跳过原因为 `check=false`/`publish=false`，明确可执行。
- **已发布快照未被改写**：`rel_20260703033246`、manifestHash 全程不变。

治理结果：
- correctionId：`corr_mcp_gamedata_equipment_xlsx_mcp_agent_correction_4rEINV`
- checkRun：`run_20260706112251402_VaXblw`（started/scoped rebuild）
- publishResult：skipped
- skipReason：`no_completed_build`（可接受）

平台需修复项：
- 支持对 Wiki 页面组件锚定修正（当前「无 source reference」直接拒绝）。
- 修正 `sourcePath`/`knowledgePath` 的锚定解析，命中**目标组件**而非首个引用源的组件。

---

## Loop 6 - 边界测试

结论：**pass（通过）**

工具链：
工具面清点 + `kb_govern_flywheel` 门禁行为观察

发现的问题：none。
- MCP **未暴露**任何直接改写/删除已发布 release、直接重写 OKF bundle、直接切换 release channel 的工具。
- 所有治理均须经 `修正 → scoped check → publish 门禁`。
- 跳过发布均带审计事件与显式原因（Loop 5 见 `no_completed_build`、`check=false`、`publish=false`）。
- 已发布 manifestHash 在整个测试期间保持不变。

治理结果：publish 仅经 `kb_publish_if_ready` 门禁；无旁路。

平台需修复项：none。

---

## Loop 7 - 多项目隔离

结论：**partial（部分通过）**

工具链：
`kb_search(projectId=default_project)` -> `kb_search(projectId=nonexistent_project_zzz)`

命中：
- `default_project`：正常命中 `荣耀连战.md`，且 `correctionStatus:"pending"`（反映本会话 active 修正，归属正确项目）
- `nonexistent_project_zzz`：**fail-closed**，报 `No current published release`，无任何 default_project 数据泄漏

发现的问题：
- 环境仅有单一真实项目（`default_project`），无法执行 A/B 两真实项目的交叉泄漏对照；负向测试（伪项目 fail-closed）通过。

治理结果：默认项目一致（省略 projectId 时统一走 `default_project`）。

平台需修复项：
- 无缺陷；建议提供 `kb_list_projects` 类工具以便 Agent 发现可用项目并做真正的多项目对照。

---

# MCP Loop Test Final Report

```text
Overall result: partial

Passed:
- Loop 0（基线可用，release 字段经信封可见）
- Loop 1（Wiki 查询：5/5 命中、相关、证据可追溯、trust 可见）
- Loop 3（图谱：topic 解析、实体回链、邻居/关系一致可用）
- Loop 4（反馈回流：记录成功、自动触发定向重建、动作可执行）
- Loop 6（边界：无直接改写已发布资产的工具，门禁不可旁路，有审计）

Failed:
- Loop 2（表消费：schema 字段名与查询行键脱节；validate 全字段误报缺失；check_table_value 落空）

Partial:
- Loop 0（kb_get_release 工具持续 session expired）
- Loop 5（分级修正：链路/门禁/不可变性正确，但 Wiki 组件不可修正 + 源路径锚定错组件）
- Loop 7（隔离负向测试通过，但无第二真实项目做交叉对照）

Highest priority fixes:
1. 【表消费】统一 kb_get_table_schema 的规范字段名与 kb_query_table 行键（或给出字段↔列位映射），
   并修复 kb_validate_table 的表头行识别——当前整条结构化数据消费路径对策划不可用。
2. 【修正锚定】支持 Wiki 页面组件锚定修正；修正 sourcePath/knowledgePath 解析使其命中目标组件而非首个引用源的组件。
3. 【kb_get_release】修复该工具持续 "session expired"，与其余工具行为一致。

次要修复：
- 弱匹配伪命中降级（Loop 4）；flywheel status 信封暴露 pending review 任务/负反馈（Loop 4）；
  中文口语依赖解析为规范表名（Loop 1）；提供 kb_list_projects（Loop 7）。

Evidence:
- releaseId: rel_20260703033246_AHJdTP
- projectId: default_project
- correctionIds: corr_mcp_gamedata_equipment_xlsx_mcp_agent_correction_4rEINV
- buildRunIds: run_20260706111650283_G3j0T6（反馈触发重建）, run_20260706112251402_VaXblw（修正 scoped check）
- feedbackTaskIds: task_mcp_knowledge_gap_lqliH0, task_mcp_bad_hit_uMuDnM
- audit observations: 已发布 manifestHash 全程不变；publish 跳过原因均白名单化
  （no_completed_build/check=false/publish=false）；伪项目 fail-closed 无泄漏

Recommendation:
- needs another fix pass（需再修一轮）。
  平台的可审计、可追溯、可治理、发布安全性均已达标（Loop 4/5/6/7 证明飞轮与门禁工作正常），
  但「表结构化数据消费」（Loop 2）与「Wiki 修正锚定」（Loop 5）两条 Agent 关键路径存在阻断级缺陷，
  修复第 1、2 项后建议复测 Loop 2 与 Loop 5 再进入策划试用。
```

---

## 测试方法学说明

- 全程仅通过 Knowledge Hub MCP 工具访问，未直接读取本地数据库、源码、OKF 文件或构建产物。
- 对 Loop 6 的破坏性动作采用「工具面清点 + 门禁行为观察」验证，未实际执行任何危险写操作。
- 本次测试留痕（如需可在评审中心处置或回收）：
  - 修正 `corr_mcp_gamedata_equipment_xlsx_mcp_agent_correction_4rEINV`（当前 `active`）
  - 反馈任务 `task_mcp_knowledge_gap_lqliH0`、`task_mcp_bad_hit_uMuDnM`
