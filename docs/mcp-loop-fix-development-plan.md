# MCP Loop 缺陷修复与 Agent-First 知识飞轮优化开发文档

## 1. 背景与目标

本开发文档基于 `docs/mcp-loop-test-report-20260706.md` 的 Claude Code MCP loop 测试结果。

本轮不扩展大功能，不做 UI 大改，不重构完整构建流水线。目标是修复阻断 Agent 使用知识库的关键链路，让平台达到以下最低可用标准：

- Agent 能稳定消费 Wiki、表格、图谱知识。
- Agent 能看到可信度、证据、来源和发布信息。
- Agent 能提交并应用中间态 correction。
- 系统能触发增量检查并通过发布门禁决定是否发布。
- 全链路可审计、可追踪、不可绕过已发布资产不可变边界。

本轮验收重点：

- Loop 2 从 fail 变为 pass。
- Loop 5 从 partial 变为 pass。
- Loop 0 的 `kb_get_release` 不再报 `session expired`。
- Loop 4 的弱匹配和飞轮状态可观测性改善。

## 2. 当前问题

### 2.1 表消费链路不可用

测试现象：

- `kb_get_table_schema` 返回规范字段，例如 `equipId`、`equipType`。
- `kb_query_table` 返回行数据却使用原始位置/中文表头键，例如 `"1"`、`"7"`、`"__EMPTY"`、`"装备id"`。
- `kb_validate_table` 因字段无法对齐，把全部 schema 字段误报为 `missingFields`。
- `kb_check_table_value(table=Equipment, field=equipId, value=1)` 返回空。

影响：

- Agent 无法按 schema 字段查表。
- Agent 无法可靠做配置校验。
- 表格知识虽然已发布，但结构化消费不可用。

### 2.2 Correction 锚定不可靠

测试现象：

- 对 Wiki 页面组件提交 correction 报 `has no source reference; correction cannot be anchored`。
- 显式传入 `sourcePath=gamedata/Equipment.xlsx` 时，系统锚到首个引用该源的无关 Wiki 组件。

影响：

- Agent 无法治理 Wiki 页面。
- 表/源文件相关 correction 可能污染错误组件。
- 中间态治理链路存在，但目标选择不可信。

### 2.3 `kb_get_release` 异常

测试现象：

- 其他 MCP 工具正常。
- `kb_get_release` 持续报 `MCP server "knowledge-hub" session expired`。
- 其他工具 envelope 中仍有 release 信息。

影响：

- Agent 无法通过标准工具做发布基线确认。
- 自动化测试和 Agent 心智受影响。

### 2.4 飞轮状态不够完整

测试现象：

- `kb_report_gap`、`kb_report_bad_hit` 能写入反馈并触发定向重建。
- `kb_get_flywheel_status` 未充分暴露 pending review task、负反馈计数、rebuild 状态。

影响：

- Agent 提交反馈后不知道系统是否接住。
- 用户仍可能需要登录平台查看多个页面。

### 2.5 弱匹配伪命中

测试现象：

- 明显不存在的主题可能因为命中“系统/流程”等通用词被标记为 `hit`。

影响：

- Agent 可能误用低相关知识。
- 策划问题被错误地认为已有答案。
- gap feedback 触发不够自然。

## 3. 实施方案

### Phase 1：修复表消费链路

目标：所有表工具使用同一套字段映射语义。

涉及能力：

- `kb_get_table_schema`
- `kb_query_table`
- `kb_validate_table`
- `kb_check_table_value`
- `kb_get_table_raw`

#### 3.1 行数据输出规则

`kb_query_table` 返回每一行时，应至少包含：

```json
{
  "row": {
    "equipId": "1",
    "equipType": "..."
  },
  "rawRow": {
    "装备id": "1",
    "__EMPTY": "...",
    "1": "..."
  },
  "fieldMap": {
    "equipId": {
      "rawKey": "装备id",
      "columnIndex": 0
    }
  }
}
```

规则：

- `row` 优先使用 schema 规范字段名。
- `rawRow` 保留原始数据，便于排查。
- `fieldMap` 说明规范字段来自哪个原始列。
- 如无法确定字段映射，不静默猜测，应在 diagnostics 中说明。

#### 3.2 字段映射来源

字段映射优先级：

1. 构建产物 schema 中的字段顺序。
2. 表头扫描得到的 header 行。
3. 字段别名或中文表头归一化匹配。
4. 无法匹配时返回 diagnostics。

#### 3.3 查询与校验行为

`kb_query_table`：

- `where` / `filters` 支持规范字段名。
- 过滤逻辑基于规范 `row`，不是原始 `rawRow`。
- 保留原始行排查信息。

`kb_check_table_value`：

- 使用与 `kb_query_table` 相同的字段映射。
- 支持按规范字段名查值。

`kb_validate_table`：

返回可行动诊断：

```json
{
  "valid": true,
  "mappedFields": ["equipId", "equipType"],
  "missingFields": [],
  "unmappedRawColumns": [],
  "headerRowGuess": 1,
  "rowCount": {
    "schema": 848,
    "data": 848
  },
  "diagnostics": []
}
```

最低验收：

- 不再把正常表的全部 schema 字段误报为 missing。
- 能解释字段缺失是表头错位、字段未映射，还是数据确实缺失。

### Phase 2：修复 Correction 锚定

目标：Agent 提交 correction 时，目标组件必须可解释、可预测、不可误锚。

#### 3.4 目标解析优先级

Correction 目标解析顺序：

1. 显式 `componentId`。
2. `knowledgePath` 精确匹配：
   - componentId
   - artifactId
   - OKF path
   - legacyPath
   - title
3. `sourcePath + componentId`。
4. `sourcePath + knowledgePath`。
5. 仅 `sourcePath`：
   - 若唯一组件引用该 source，允许锚定。
   - 若多个组件引用该 source，返回多候选错误，要求 Agent 补充 componentId 或 knowledgePath。

硬要求：

- 显式 `componentId` 是最高优先级，不允许被 `sourcePath` 改写目标组件。
- `sourcePath` 只作为来源锚点，不作为唯一目标选择依据。

#### 3.5 Wiki 组件锚定

Wiki 组件即使 `sourceRefs` 为空，也应尝试：

- evidence records 中的 source version。
- OKF page frontmatter/source meta。
- artifactId / legacyPath 中的来源线索。
- package 的 source version。
- fallback 到 component-level correction anchor。

如果仍无法定位源文件，可以允许 component-level correction，但必须标记：

```json
{
  "matchMethod": "component_fallback",
  "confidence": "low"
}
```

#### 3.6 返回锚定解释

`kb_submit_correction` 和 `kb_govern_flywheel` 返回：

```json
{
  "anchor": {
    "componentId": "...",
    "sourcePath": "...",
    "matchMethod": "componentId",
    "candidates": [],
    "confidence": "high"
  }
}
```

验收：

- 对 `荣耀连战.md` / `阵法特权.md` 的 Wiki componentId 可以提交 correction。
- 同一 `sourcePath` 被多个组件引用时不会误锚。
- `kb_govern_flywheel` 返回 anchor explanation。
- 已发布 release 仍不可变。

### Phase 3：修复 `kb_get_release`

目标：`kb_get_release` 在 HTTP MCP、stdio MCP、`/api/mcp/query` 模拟入口都稳定可用。

排查方向：

- 无参工具 schema 是否和 MCP client session 处理冲突。
- `kb_get_release` 返回体是否过大。
- 返回对象是否包含不可序列化字段。
- Streamable HTTP session 生命周期是否对某类工具调用特殊失败。

建议调整：

- `kb_get_release` 默认返回轻量 release summary。
- 增加 `includeManifest?: boolean` 参数，只有显式传入时返回完整 manifest。

默认返回：

```json
{
  "releaseId": "...",
  "projectId": "...",
  "version": "...",
  "publishedAt": "...",
  "manifestHash": "...",
  "packageIds": [],
  "quality": {},
  "okf": {}
}
```

验收：

- Claude Code 通过 MCP 调用 `kb_get_release` 成功。
- Web 模拟入口调用成功。
- 失败时返回正常 MCP error，不出现 session expired。

### Phase 4：增强 `kb_get_flywheel_status`

目标：Agent 能通过一个工具理解当前飞轮状态。

新增返回内容：

```json
{
  "exceptions": {
    "blockingTasks": 0,
    "pendingReviewTasks": 2,
    "negativeFeedback": 2,
    "pendingCorrections": 1,
    "failedLintRemediations": 0
  },
  "recentActivity": {
    "latestBuild": {},
    "latestCorrection": {},
    "latestFeedback": {},
    "latestPublishSkip": {}
  },
  "gates": {
    "canAttemptPublish": false,
    "reasons": ["pending_review_tasks"]
  }
}
```

验收：

- Loop 4 反馈后，status 能看到负反馈和相关任务。
- 反馈触发 rebuild 后，status 能看到 latest rebuild。
- publish skip 后，status 能看到 skip reason。

### Phase 5：弱匹配降级

目标：避免不存在的主题被普通 `hit` 掩盖。

策略：

- 如果搜索结果仅命中通用词，且缺少核心查询词，标记为：
  - `near_miss`
  - 或 `low_confidence_hit`
- envelope `status` 可保持兼容，但 result/guidance 必须明确提示低置信。
- `qualityFlags` 增加：
  - `weak_match`
  - `missing_core_terms`

验收：

- 查询“跨服婚姻系统结婚流程”时，Agent 能看到 near-miss / weak-match 提示。
- `kb_report_gap` 仍能正常提交。
- 高相关搜索不受影响。

### Phase 6：项目发现能力

目标：支持 Agent 显式选择项目，方便多游戏知识库使用。

新增 MCP 工具：

- `kb_list_projects`

返回：

```json
{
  "currentProjectId": "...",
  "projects": [
    {
      "projectId": "...",
      "name": "...",
      "status": "active"
    }
  ]
}
```

验收：

- Agent 可发现当前账号可用项目。
- 不存在的 projectId 仍 fail-closed。
- 不改变现有默认 projectId 行为。

## 4. 测试计划

### 4.1 后端关键测试

表工具：

- `kb_get_table_schema("Equipment")` 返回字段后，`kb_query_table("Equipment")` 的 row key 包含同名规范字段。
- `kb_query_table("Equipment", { where: { equipId: "1" } })` 能命中。
- `kb_check_table_value(table="Equipment", field="equipId", value="1")` 能命中。
- `kb_validate_table("Equipment")` 不再把所有 schema 字段误报 missing。

Correction 锚定：

- 对 Wiki componentId 调 `kb_submit_correction` 成功。
- 多组件共享 sourcePath 时，不误锚到无关组件。
- `kb_govern_flywheel` 返回 anchor explanation。

MCP release：

- `kb_get_release` 服务层调用成功。
- `/api/mcp/query` 调用成功。
- Streamable HTTP MCP 调用成功。

Flywheel status：

- 反馈、correction、publish skip 能进入 status。
- `gates.reasons` 可解释。

弱匹配：

- 缺少核心词时返回弱匹配信号。

### 4.2 必跑命令

```bash
npm run typecheck
npx vitest run tests/knowledge-query-service.test.ts
```

如改动 API / flywheel 聚合：

```bash
npx vitest run tests/api.test.ts -t "mcp"
npx vitest run tests/flywheel-governance.test.ts
```

### 4.3 必复测 Loop

- Loop 0：复测 `kb_get_release`。
- Loop 2：完整复测。
- Loop 5：完整复测。
- Loop 4：抽测弱匹配和 flywheel status。

不要求重跑 Loop 1、Loop 3、Loop 6，除非搜索或图谱逻辑被大范围修改。

## 5. Rollout Notes

- 本轮改动集中在 MCP 消费和治理链路。
- 发布资产不可变原则不变。
- 表工具返回结构可以扩展，但应保留旧字段，避免破坏现有 Agent。
- Correction anchor 返回新增解释字段，不影响旧调用。
- `kb_get_release` 如改为默认轻量返回，应通过 `includeManifest` 保留完整 manifest 获取能力。
- 所有新治理行为必须写入 MCP audit 或 knowledge events，便于回放。

## 6. Done Definition

本轮完成条件：

- Loop 2 从 fail 变为 pass。
- Loop 5 从 partial 变为 pass。
- `kb_get_release` 不再 session expired。
- `kb_get_flywheel_status` 能反映反馈、修正、重建、发布跳过状态。
- 弱匹配不会被普通 hit 掩盖。
- `npm run typecheck` 和关键 vitest 通过。
