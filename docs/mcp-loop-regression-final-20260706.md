# MCP 回归测试最终验收报告（三轮 agent-relay 协作收敛）

> 依据：`docs/claudecode-mcp-loop-regression-plan-20260706.md` 及 Codex 逐轮下发的复测文档
> 协作方式：Claude Code（测试）⇄ Codex（优化）经 Agent Mail 共用邮箱异步流转（agent-relay skill）
> 仅通过 MCP 工具复测，未直接读取数据库/源码/OKF/构建产物/后台 API
> 被测环境：云端 MCP（各轮修复均确认部署后再测）
> 项目：`default_project`｜release `rel_20260703033246_AHJdTP`｜manifestHash `sha256:bf2dc0a9…747b1efe`（全程未变）
> 收敛日期：2026-07-06 ｜ 结论：**通过（Ready for planner trial）**

## 总体结论

**通过。** 经三轮 Claude Code ⇄ Codex 协作，初始 6+ 个缺陷（含两处阻断级）全部修复，两个超大响应体从「不可用 / 1MB 级」降到「完全可用 / 几十 KB 级」，功能无回退，发布不可变边界成立。剩余一处（publish_if_ready 75.7KB 未到 Codex 自定的 <50KB 目标）判定为**可接受、不阻断**的可选优化。

## 三轮协作演进

| 轮次 | Codex 交付 | Claude 复测结论 |
|---|---|---|
| round=1 | （初始 6 修复点部署版） | partial：4 pass / 2 partial（includeManifest session expired、Wiki apply 失败）|
| round=2 | 修 includeManifest 分支 + Wiki apply + target 瘦身 + scoped rebuild 护栏 | partial：功能修复但响应体瘦身漏了大头（revision/autoPublish、trust/trace）|
| round=3 | manifest 深层瘦身 + envelope 层统一瘦身（提交 4a4c29c） | **接近 pass：4/5 loop 全 pass，唯一 partial 已降 93%，收敛** |

## 最终 6 个修复点验收

| # | 内容 | 最终结果 |
|---|---|---|
| 1 | `kb_list_projects` 可发现项目 | ✅ pass |
| 2 | `kb_get_release` 默认 summary + `includeManifest` 不再 session expired | ✅ pass（默认轻量；includeManifest 深层瘦身，287KB→几十 KB）|
| 3 | 表工具统一 schema 字段、`row/rawRow/fieldMap`、validate 不误报 | ✅ pass（上轮阻断级 fail→pass）|
| 4 | correction 锚定 componentId 优先、多候选拒绝、Wiki 一站式 apply | ✅ pass（Wiki `component_fallback` 锚点，submit/apply completed；上轮阻断级 fail→pass）|
| 5 | flywheel status 含 exceptions/recentActivity/gates.reasons | ✅ pass |
| 6 | 弱匹配显式降级 near_miss/weak_match/missing_core_terms | ✅ pass |

## round=3 最终复测（5 loop 逐字段实测）

- **Loop 1 includeManifest 深层瘦身 ✅**：无 session expired；`manifestTruncated:true`；`revision.diff.*` 与 `autoPublish.*` 均为 `{count,sample,truncated}`；无完整 1454 项数组；响应未触发 persist（对比 round=2 的 287KB 大幅下降）。
- **Loop 2 publish_if_ready envelope 瘦身 ⚠️（可接受）**：1.06MB → **75.7KB（降 93%）**；`trust.components.length:20` + `componentsSummary{count:1454,truncated:true}`；`trace.componentIds:20` + `componentIdSummary`；`trust.summary` 完整保留；`result.target` 摘要化。残留：`trust.components` 单条明细偏胖（20 条约 66KB），未到 <50KB 目标 —— 判定不阻断。
- **Loop 3 默认轻量 release ✅**：无 `result.manifest`，~3KB。
- **Loop 4 Wiki 一站式 apply ✅**：submit/apply completed，`matchMethod:component_fallback`，manifestHash 不变。
- **Loop 5 不可变发布边界 ✅**：两次 correction active 后 releaseId/manifestHash 不变，治理仅走 staged/correction 链路。

## 可选后续优化（不阻断试用）

1. `kb_publish_if_ready` 的 `trust.components[]` 每条只保留 `componentId/title/kind/score/status`，将 breakdown 明细留给 `kb_get_quality` 按需查询 → 可把 66KB 压到个位数 KB，稳进 <50KB。
2. `manifest.auditSummary.trust.lowTrustComponents` 可同样瘦身（当前已达标，非必须）。

## 建议

**Ready for planner trial。** 可让策划以「查询 + 反馈 + 暂存修正 + 一站式治理」方式正式试用。响应体大小已不构成可用性问题；上述可选优化可在后续迭代顺手处理。

## 留痕（供平台侧审计/清理）

- 测试用 correction：`corr_...vCQ01v`（round=3 Loop4）、`corr_...RAhe8u`（round=2）、`corr_...wmqDdh`、`corr_...4rEINV`（均 active/pending，测试用，可批量清理）。
- 测试用 feedback：`task_mcp_knowledge_gap_hoy4Cl`。
- 无新增负反馈。

## 协作方法学说明

- 严格仅用 MCP 工具复测，未直接读取数据库/源码/OKF/构建产物/后台 API。
- 每轮修复均先探针确认云端已部署再正式复测，避免测到旧版误判（此前有一次因未部署导致误判的教训）。
- 大响应体用逐字节拆解定位真正大头（如 round=2 发现瘦身漏在 `trust.components`/`trace` 而非业务字段），而非只看总量。
- Claude Code ⇄ Codex 经 Agent Mail 共用邮箱异步流转，主题 `[AGENT-RELAY][round=N][to=...]` 作状态机，发送前人工确认防循环，三轮收敛。
