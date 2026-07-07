# Claude Code MCP Loop Regression Test Plan - 2026-07-06

本文档给 Claude Code 使用，用来通过 Knowledge Hub MCP 复测本轮修复后的知识飞轮链路。

严格要求：只通过 MCP 工具测试。不要直接读取本地数据库、源代码、OKF bundle 文件、构建产物目录或后台 API。测试目标是验证“消费端 Agent 是否能独立完成知识查询、可信度判断、反馈、修正、检查、发布门禁请求”。

## 测试目标

本轮重点复测 6 个修复点：

1. `kb_list_projects` 可发现项目，且未发布项目也能查询项目列表。
2. `kb_get_release` 默认返回轻量 release summary，不再导致 MCP session expired；`includeManifest=true` 才返回完整 manifest。
3. 表格工具统一使用 schema 字段，`kb_query_table` 返回 `row/rawRow/fieldMap`，`kb_validate_table` 不再误报全部字段缺失。
4. correction 锚定可解释、可预测：`componentId` 优先，`sourcePath` 不能反向改写目标组件，多候选必须要求补充目标。
5. `kb_get_flywheel_status` 能看到 `exceptions`、`recentActivity`、`gates.reasons`。
6. 弱匹配不再伪装成普通命中：能看到 `near_miss` / `low_confidence_hit`、`weak_match`、`missing_core_terms`。

## 输出格式

每个 Loop 都输出以下格式：

```text
## Loop N - <name>

Conclusion: pass / partial / fail

Project:
- currentProjectId:
- testedProjectId:

Tool chain:
- ...

Key observations:
- ...

Trust / trace:
- releaseId:
- manifestHash:
- trust.summary.level:
- evidenceCount:
- sourceRefs:
- qualityFlags:

Governance / audit:
- correctionId:
- buildRunId:
- publishStatus:
- gateReasons:

Problems found:
- none / specific issue

Platform fixes needed:
- none / specific fix
```

最终输出：

```text
# MCP Loop Regression Final Report

Overall result: pass / partial / fail

Passed:
- ...

Failed:
- ...

Highest priority fixes:
1. ...
2. ...
3. ...

Useful ids:
- projectIds:
- releaseIds:
- componentIds:
- correctionIds:
- buildRunIds:

Recommendation:
- Ready for planner trial / needs another fix pass
```

## Loop 0 - 项目发现与发布基线

目的：确认 Agent 能在不知道游戏项目的情况下发现项目，并稳定读取当前发布。

步骤：

1. 调 `kb_list_projects`，不传 `projectId`。
2. 记录 `currentProjectId` 和所有 `projects[].projectId/name/status`。
3. 选择 `currentProjectId` 作为本轮默认测试项目。
4. 调 `kb_get_release`，只传 `{ "projectId": "<currentProjectId>" }`。
5. 调 `kb_get_release`，传 `{ "projectId": "<currentProjectId>", "includeManifest": true }`。
6. 调 `kb_get_flywheel_status`，传 `{ "projectId": "<currentProjectId>" }`。

通过标准：

- `kb_list_projects` 成功返回项目列表。
- `kb_get_release` 默认结果包含 `releaseId/projectId/version/publishedAt/manifestHash/packageIds/quality/okf`。
- 默认 `kb_get_release` 不应返回完整 `manifest` 大对象。
- `includeManifest=true` 时可以返回完整 `manifest`。
- 不出现 `session expired`。
- `kb_get_flywheel_status` 返回 `currentRelease`、`exceptions`、`recentActivity`、`gates.reasons`。

失败标准：

- 项目列表必须依赖 current release 才能返回。
- `kb_get_release` 默认返回体巨大或 session expired。
- 项目上下文不明确，且无法通过 `projectId` 显式指定。

## Loop 1 - Wiki 查询、证据与可信度

目的：确认常规知识查询仍可用，且结果对策划可读。

选择 3 到 5 个真实业务主题，例如：

- 荣耀连战
- 竞技狂欢
- 阵法特权
- PVP 活动
- 排行榜
- 奖励商店

每个主题执行：

1. `kb_search`：`{ "projectId": "<projectId>", "query": "<topic>", "limit": 5 }`
2. 对最相关命中调用 `kb_get_page`。
3. 对该 component 调 `kb_get_evidence`。
4. 对该 component 调 `kb_get_quality`。
5. 如果页面有表依赖，调 `kb_get_page_tables`。

通过标准：

- search 的 `result.cards` 能让策划理解命中的知识文件或内容，不只是一串 componentId。
- envelope 中有 `trust.summary`。
- `trace.componentIds`、`trace.sourceVersionIds`、`trace.evidenceIds` 能解释来源链路。
- 证据不足时，`qualityFlags` 或 `trust.summary` 明确表达风险。
- 页面正文和 `Data Dependencies` / `kb_get_page_tables` 结果不明显冲突。

失败标准：

- 明显存在的知识反复 miss。
- 有引用/证据但 MCP 显示证据 0 且没有解释。
- 依赖表只显示中文名，后续表工具无法消费。

## Loop 2 - 表格字段映射复测

目的：重点验证本轮表格修复是否生效。

选择 3 张表，优先从 Loop 1 的 `kb_get_page_tables` 中选择；如果没有，使用 `kb_list_tables` 搜索。

每张表执行：

1. `kb_get_table_schema`
2. 从 `schema.fields` 中选择 1 到 2 个字段。
3. `kb_query_table`：不带 where，limit 3。
4. 如果有返回行，取第一行 `row` 中一个字段和值，再调用 `kb_query_table` with `where`。
5. 调 `kb_check_table_value`，使用同一个字段和值。
6. 调 `kb_validate_table`。
7. 必要时调 `kb_get_table_raw` 验证原始表头。

重点检查：

- `kb_query_table.result.rows[*].row` 使用 schema 字段名。
- `kb_query_table.result.rows[*].rawRow` 保留原始列名或原始表头。
- `kb_query_table.result.rows[*].fieldMap` 能说明 schema 字段来自哪个原始列。
- `where` 使用 schema 字段能命中。
- `kb_check_table_value` 使用 schema 字段能命中。
- `kb_validate_table.result.missingFields` 不能把全部 schema 字段误报缺失。
- `kb_validate_table.result.diagnostics` 对不可映射字段给出解释。

通过标准：

- 至少 2 张表完整通过 schema -> query -> where -> check -> validate。
- 对中文表头/多行表头，`fieldMap` 可解释。
- 无法映射时结果是 actionable diagnostics，而不是静默空结果。

失败标准：

- schema 字段存在，但 row 里只能看到 `"1"`、`"__EMPTY"`、中文列名等原始键。
- `where` 用 schema 字段查不到刚从 row 里拿到的值。
- `kb_validate_table` 对正常表误报大量 missingFields。

## Loop 3 - 弱匹配与知识缺口

目的：确认不存在或低相关主题不会伪装成普通 hit。

执行以下查询：

1. 一个明显不存在但包含通用词的查询，例如：`跨服婚姻活动结构`、`跨服结婚系统流程`。
2. 一个真实高相关查询，例如：`荣耀连战 活动结构`。

每个查询执行：

1. `kb_search`
2. 观察 `result.guidance.status`
3. 观察 `qualityFlags`
4. 如果是缺口或弱匹配，调用 `kb_report_gap`
5. 再调 `kb_get_flywheel_status`

通过标准：

- 不存在主题如果只命中“活动/系统/结构/流程”等通用词，应显示 `near_miss` 或 `low_confidence_hit`。
- `qualityFlags` 应包含 `weak_match` 或 `missing_core_terms`。
- `result.guidance.nextStep` 应建议上报 gap 或细化查询。
- 高相关查询仍应是正常 hit，不应被误降级。
- `kb_report_gap` 后，`kb_get_flywheel_status.exceptions.negativeFeedback` 或 `recentActivity.latestFeedback` 有体现。

失败标准：

- 不存在主题被普通 hit 掩盖，且没有低置信提示。
- 高相关查询被错误标为 near_miss。
- gap 反馈提交后在 flywheel status 中完全不可见。

## Loop 4 - Correction 锚定复测

目的：确认 Agent 修改中间态资产时不会误锚。

先通过 `kb_search` 找一个低风险 Wiki 页面，记录：

- `componentId`
- `title`
- `okfPath`
- `sourceRefs`

执行 A：componentId 优先

1. 调 `kb_submit_correction`：

```json
{
  "projectId": "<projectId>",
  "componentId": "<componentId>",
  "sourcePath": "gamedata/SomeTable.xlsx",
  "issue": "Loop correction anchor test: componentId must remain the target even when sourcePath points to a table.",
  "suggestion": {
    "field": "summary",
    "value": "Loop test staged correction. Do not publish directly."
  },
  "confidence": 0.8
}
```

2. 检查返回 `anchor`。

通过标准 A：

- 返回的 `component.componentId` 仍是显式传入的 Wiki componentId。
- `anchor.matchMethod` 是 `componentId`。
- `sourcePath` 只是来源锚点，不应把目标改成表组件或其他 Wiki。

执行 B：仅 sourcePath 多候选

1. 选择一个多个组件共用的 sourcePath，例如页面 sourceRefs 中的通用 gamedocs/gamedata 路径。
2. 只传 `sourcePath`，不传 `componentId` / `knowledgePath`，调用 `kb_submit_correction`。

通过标准 B：

- 如果 sourcePath 被多个组件引用，工具应拒绝并要求补充 `componentId` 或 `knowledgePath`。
- 错误信息应列出候选或至少说明 multiple components。

执行 C：一站式治理

1. 调 `kb_govern_flywheel`，使用显式 `componentId`。
2. 建议 payload：

```json
{
  "projectId": "<projectId>",
  "componentId": "<componentId>",
  "issue": "Loop governance correction: staged correction should be traceable.",
  "suggestion": {
    "field": "summary",
    "value": "Loop test correction created through MCP governance."
  },
  "confidence": 0.8,
  "check": true,
  "publish": true
}
```

3. 调 `kb_get_correction_status`。
4. 调 `kb_get_flywheel_status`。
5. 调 `kb_get_release`。

通过标准 C：

- `kb_govern_flywheel.result.steps` 至少包含 submit/apply/check/publish_if_ready。
- submit 结果里有 `anchor`。
- correction lifecycle 可查询。
- 如果发布跳过，必须有明确 gate reason。
- 如果发布成功，应创建新 revision，不直接改历史 release。

失败标准：

- 显式 componentId 被 sourcePath 覆盖。
- sourcePath 多候选时系统随便选一个组件。
- correction 可提交但不可追踪。
- scoped correction 让无关 wiki 分组消失。

## Loop 5 - 飞轮状态可观测性

目的：确认 Agent 不登录平台也能知道反馈、修正、检查、发布门禁状态。

执行：

1. 调 `kb_get_flywheel_status` 记录初始状态。
2. 做一次 `kb_report_bad_hit` 或 `kb_report_gap`。
3. 做一次 `kb_submit_correction`，但可以先不 apply。
4. 再调 `kb_get_flywheel_status`。
5. 如果已有 correctionId，调 `kb_get_correction_status`。
6. 调 `kb_publish_if_ready`。
7. 再调 `kb_get_flywheel_status`。

重点检查：

- `exceptions.blockingTasks`
- `exceptions.pendingReviewTasks`
- `exceptions.negativeFeedback`
- `exceptions.pendingCorrections`
- `exceptions.failedLintRemediations`
- `recentActivity.latestBuild`
- `recentActivity.latestCorrection`
- `recentActivity.latestFeedback`
- `recentActivity.latestPublishSkip`
- `gates.canAttemptPublish`
- `gates.reasons`

通过标准：

- Agent 能通过一个工具判断飞轮是否可发布。
- publish 跳过原因是结构化 code，例如 `pending_review_tasks`、`pending_corrections`、`lint_failed`。
- 最近反馈和最近修正能看到。

失败标准：

- 反馈或 correction 后 status 没变化。
- publish skip 只有泛化失败信息，没有 gate reason。
- 状态必须登录 UI 才能理解。

## Loop 6 - 多项目隔离抽测

目的：确认多游戏项目不串库。

前提：如果 `kb_list_projects.projects` 少于 2 个，记录为 skipped，不算失败。

如果至少两个项目存在，选择 A、B 两个项目：

1. 对 A 调 `kb_get_release`。
2. 对 B 调 `kb_get_release`。
3. 对 A 调 `kb_search`。
4. 对 B 调同样 query 的 `kb_search`。
5. 对 A 提交一个低风险 `kb_submit_correction`。
6. 分别调 A、B 的 `kb_get_flywheel_status`。

通过标准：

- A 的 releaseId/projectId 与 B 不混淆。
- A 的 search 不返回 B 的知识。
- A 的 correction 不出现在 B 的 flywheel status。
- 未传 projectId 时使用 `kb_list_projects.currentProjectId` 所示默认项目。

失败标准：

- 查询、反馈、correction、审计跨项目泄漏。
- current/default project 在不同工具中不一致。

## Loop 7 - 发布资产不可变边界

目的：确认统一 MCP 权限下，安全边界仍在“只能改中间态 + 发布门禁”。

尝试完成以下动作：

1. 查找是否存在能直接修改 published release / OKF bundle / release channel 的 MCP 工具。
2. 尝试通过 correction 工具修改已发布资产。
3. 调 `kb_publish_if_ready`，观察是否绕过门禁。

通过标准：

- MCP 没有直接改发布资产的工具。
- correction 只能写入 staged/intermediate correction 链路。
- 发布只能通过 `kb_publish_if_ready`，且返回 pass/skip 的结构化原因。
- 历史 release manifestHash 不应因为 correction submit/apply 直接变化。

失败标准：

- Agent 能直接写 OKF bundle。
- Agent 能直接切 release channel。
- submit/apply correction 立即改变当前发布内容，且没有 release revision / gate 记录。

## Stop Conditions

遇到以下任意情况，停止后续测试并输出失败报告：

- MCP 无法连接。
- `kb_list_projects` 不可用。
- `kb_get_release` 仍出现 `session expired`。
- 当前项目没有 release，且没有可解释的 no current release 错误。
- `trust.summary` 在常规查询 envelope 中缺失。
- 表工具仍无法用 schema 字段消费。
- correction 锚定出现误目标。
- 飞轮状态缺少 gate reasons。
- 多项目测试出现串库。

## 注意事项

- 本文档是回归测试，不要求真实修改业务知识。
- correction 建议内容必须标明是 loop test，避免被误认为真实策划结论。
- 如果 `publish_if_ready` 成功发布 revision，记录新旧 `releaseId`、`manifestHash`。
- 如果测试产生了负反馈或 correction，请在最终报告列出对应 id，方便平台侧清理或审计。
