# MCP 回归测试报告（部署后复测 · 2026-07-06）

> 依据：`docs/claudecode-mcp-loop-regression-plan-20260706.md`
> 仅通过 MCP 工具复测，未直接读取数据库/源码/OKF/构建产物/后台 API
> **被测环境：云端 MCP（本地修复已部署）** ｜ 项目：`default_project`（航海王）｜ 当前发布：`rel_20260703033246_AHJdTP` ｜ manifestHash：`sha256:bf2dc0a9…747b1efe`
> 执行日期：2026-07-06

## 6 个修复点复测结论

| 修复点 | 内容 | 结果 |
|---|---|---|
| 1 | `kb_list_projects` 可发现项目 | ✅ **pass** |
| 2 | `kb_get_release` 默认 summary + `includeManifest`，不再 session expired | ⚠️ **partial**（默认 summary ✓；`includeManifest=true` 仍 session expired ✗）|
| 3 | 表工具统一 schema 字段，返回 `row/rawRow/fieldMap`，validate 不误报 | ✅ **pass** |
| 4 | correction 锚定 componentId 优先、多候选拒绝 | ⚠️ **partial**（锚定 ✓；Wiki 页一站式 govern apply ✗）|
| 5 | flywheel status 含 `exceptions/recentActivity/gates.reasons` | ✅ **pass** |
| 6 | 弱匹配显式降级 `near_miss/low_confidence_hit` + qualityFlags | ✅ **pass** |

---

## Loop 0 - 项目发现与发布基线

Conclusion: **partial**

Project: currentProjectId `default_project`｜testedProjectId `default_project`

Tool chain: `kb_list_projects` → `kb_get_release` → `kb_get_release(includeManifest)` → `kb_get_flywheel_status`

Key observations:
- `kb_list_projects` ✓ 返回 `currentProjectId` + 项目「航海王」（status active）。
- `kb_get_release` 默认 ✓ 返回轻量 summary（releaseId/projectId/version/publishedAt/manifestHash/packageIds/quality/okf/componentCount），**不含大 manifest**，**不 session expired**。
- `kb_get_release(includeManifest=true)` ✗ **两次均 session expired**——完整 manifest 分支仍未修好。
- `kb_get_flywheel_status` ✓ 含 `exceptions/recentActivity/gates.reasons`。

Problems found: `includeManifest=true` 仍触发 session expired（修复点 2 未完全落地）。
Platform fixes needed: 修复 includeManifest 分支的大响应体导致的 session expired（分页/流式/裁剪）。

## Loop 1 - Wiki 查询、证据与可信度

Conclusion: **pass**

Tool chain: `kb_search`×N → `kb_get_page` → `kb_get_evidence` → `kb_get_page_tables`

Key observations: 荣耀连战/阵法特权/排行榜等主题均命中且对策划可读；页面正文与 Data Dependencies/`kb_get_page_tables`（Equipment 848 行规范 schema）一致；`trust.summary` level high，`trace.{componentIds,sourceVersionIds,evidenceIds}` 齐全。

Problems found: none。

## Loop 2 - 表格字段映射复测

Conclusion: **pass**（本轮最重要回归点，上一轮 fail）

Tool chain: `kb_query_table` → `where` → `kb_check_table_value` → `kb_validate_table`

Key observations:
- `kb_query_table.rows[*]` 现以 **schema 字段名**为键（`equipId:"600010"`, `nameIndex:"木质长剑"`），并含 `row` + `rawRow` + `fieldMap` ✓
- `where:{equipId:"600010"}` schema 字段命中 ✓；`kb_check_table_value(equipId=600010)` 命中 ✓
- `kb_validate_table` 不再全字段误报：`mappedFields` 43 个，`missingFields` 仅 4 个（脏表头残留），并给出 `unmappedRawColumns`/`headerRowGuess:5`/`rowCount:{schema:848,data:732}`/`diagnostics` 可执行诊断 ✓

Problems found: none（4 个 missingFields 是源表脏表头，诊断已解释，非工具缺陷）。

## Loop 3 - 弱匹配与知识缺口

Conclusion: **pass**

Tool chain: `kb_search(不存在)` → `kb_search(高相关)` → `kb_report_gap` → `kb_get_flywheel_status`

Key observations:
- 「跨服婚姻活动结构」→ `guidance.status:"near_miss"`，`qualityFlags:["weak_match","missing_core_terms"]`，`match.matchedCoreTerms:[]`，`nextStep` 建议上报 gap ✓
- 「荣耀连战 活动结构」→ `status:"hit"`，未被误降级；弱相关页标 `supporting_hit` ✓
- gap 上报成功（`task_mcp_knowledge_gap_hoy4Cl`），飞轮 `negativeFeedback` 累加 ✓

Problems found: none。

## Loop 4 - Correction 锚定复测

Conclusion: **partial**

Tool chain: `kb_submit_correction(A: componentId+误导sourcePath)` → `kb_submit_correction(B: 仅多候选sourcePath)` → `kb_govern_flywheel(C)` → `kb_get_correction_status`

Governance / audit:
- correctionId: `corr_…wmqDdh`（A，pending_review）
- 执行 A ✓：Wiki 组件可提交（上轮直接拒绝），`anchor.matchMethod:"componentId"`，componentId **未被 sourcePath 覆盖**。
- 执行 B ✓：多候选 sourcePath **被拒绝**并列出候选清单（"provide componentId or knowledgePath"）。
- lifecycle ✓：`kb_get_correction_status` 返回 submitted→created 事件链 + `boundSourceHash`。
- 执行 C ✗：`kb_govern_flywheel` 的 apply 阶段稳定报 `当前资料版本中未找到该源文件，无法应用修正`——**纯 componentId 也失败**，非 sourcePath 干扰。

Problems found: Wiki 页组件一站式 govern 的 apply/scoped-rebuild 无法定位源文件（apply 仍按 sourcePath 而非 componentId 解析源）。
Platform fixes needed: govern apply 对 Wiki 组件应用 componentId 解析源文件路径（当前对表/processed_doc 可用，Wiki 页不可用）。

## Loop 5 - 飞轮状态可观测性

Conclusion: **pass**

Tool chain: `kb_get_flywheel_status` → `kb_publish_if_ready`

Key observations:
- `exceptions:{blockingTasks:0,pendingReviewTasks:7,negativeFeedback:9,pendingCorrections:3,failedLintRemediations:0}` ✓
- `recentActivity.{latestBuild,latestCorrection,latestFeedback,latestPublishSkip}` 全可见 ✓
- `gates.canAttemptPublish:false` + 结构化 reasons ✓
- `kb_publish_if_ready` → `status:"skipped"`，`reason` 为 code（`trust_score_declined_or_missing`,`has_pending_review_corrections`），`reasonDetails` 每条含 severity/description/**action**/count/**sampleIds**（"90%→85%"）✓

Problems found: `kb_publish_if_ready` 响应 1.1MB（target.componentIds 全量），体积偏大（次要）。
Platform fixes needed: 精简 publish_if_ready 返回体（componentIds 采样或分页）。

## Loop 6 - 多项目隔离抽测

Conclusion: **skipped**（仅 1 个项目，符合计划前提，不算失败）

Key observations: 负向确认通过——非默认 projectId `ship_project_B_nonexistent` fail-closed，无 default_project 泄漏；省略/显式 projectId 一致走 default_project。

Problems found: none（无第二项目可做交叉对照）。

## Loop 7 - 发布资产不可变边界

Conclusion: **pass**

Key observations: MCP 无直接改 published release/OKF/channel 的工具；correction 仅写 staged 链路；发布仅经 `kb_publish_if_ready`（结构化 skip reason）；历史 release manifestHash `sha256:bf2dc0a9…` 经多次 correction submit/apply/govern **全程未变**。

Problems found: none。

---

# MCP Loop Regression Final Report

```text
Overall result: partial（接近 pass；核心链路全部打通，2 处非阻断残留）

Passed:
- Loop 1 Wiki 查询与可信度
- Loop 2 表格字段映射（row/rawRow/fieldMap + validate 诊断）★上轮 fail→本轮 pass
- Loop 3 弱匹配降级（near_miss + weak_match/missing_core_terms）★新增修复
- Loop 5 飞轮可观测性（exceptions/recentActivity/gates.reasons + 结构化 publish skip）★新增修复
- Loop 7 发布不可变边界
- 修复点 1 kb_list_projects ★新增上线

Partial:
- Loop 0 / 修复点 2：kb_get_release 默认 summary 已修好且不再 session expired；
  但 includeManifest=true 仍 session expired。
- Loop 4 / 修复点 4：componentId 优先锚定 ✓ + 多候选拒绝 ✓ + lifecycle 可追踪 ✓；
  但 Wiki 页一站式 govern 的 apply 阶段仍无法定位源文件。

Skipped:
- Loop 6 多项目隔离（仅 1 个项目；负向 fail-closed 通过）

Highest priority fixes:
1. kb_get_release(includeManifest=true) 修复大响应体导致的 session expired。
2. kb_govern_flywheel 对 Wiki 页组件的 apply/scoped-rebuild 按 componentId 解析源文件。
3. kb_publish_if_ready 返回体瘦身（componentIds 全量 → 采样/分页，当前 1.1MB）。

Useful ids:
- projectIds: default_project（航海王）
- releaseIds: rel_20260703033246_AHJdTP（manifestHash sha256:bf2dc0a9…747b1efe，全程未变）
- componentIds: cmp_...wiki_systems_md_eb26566283（荣耀连战.md，Loop 4 锚定目标）
- correctionIds: corr_...wmqDdh（Loop 4-A，pending_review）；corr_...N3kqij（latestCorrection）
                 ；前轮遗留 corr_...4rEINV
- feedbackTaskIds: task_mcp_knowledge_gap_hoy4Cl（Loop 3 gap）
- buildRunIds: run_20260706112251402_VaXblw

Recommendation:
- 接近 Ready for planner trial。6 个修复点中 4 个完全落地（含上轮阻断级的表消费与
  Wiki 修正锚定的提交层），2 个部分落地且均为非阻断（有可用替代路径：release 用默认
  summary、correction 用 kb_submit_correction）。建议修完上述 3 项后转正式试用；
  当前状态已可让策划以「查询+反馈+暂存修正」方式试用。
```

---

## 留痕（建议平台侧审计/清理）

- 本轮修正：`corr_…wmqDdh`（荣耀连战.md，pending_review，测试用，勿当真实结论）
- 本轮反馈：`task_mcp_knowledge_gap_hoy4Cl`（跨服婚姻活动结构 gap）
- 前轮遗留：`corr_…4rEINV`（误锚 processed_doc，可清理）

## 复测方法学说明

- 严格仅用 MCP 工具，未直接读取数据库/源码/OKF/构建产物/后台 API。
- 对每个修复点做了正向 + 负向双向验证（如 Loop 4 用「componentId+误导 sourcePath」证明不被覆盖、用「纯 componentId」隔离 apply 失败根因；Loop 6 用不存在 projectId 验证 fail-closed）。
- 与上一轮「部署前云端基线」对照：表消费（Loop 2）与 Wiki 修正锚定提交层（Loop 4）两处上轮阻断级缺陷本轮已修复。
