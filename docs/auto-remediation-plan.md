# LLM 驱动的自动修复管线（Auto-Remediation）实施方案

## 一、背景与目标

Knowledge Hub 现有飞轮闭环：

```
Agent 反馈 → 创建 review_task(annotation, open)
          → 累计 2+ 负面反馈 → rebuild_candidate 任务
          → 人类点击"触发重建" → feedbackAutomation → 重建
          → build.completed → releaseAutomation → 草案
          → 人工 publish（或 autoPublishRevisions=true 且条件全满足才自动发）
```

**三个需人类介入的瓶颈**：

1. 反馈生成的 annotation task 需要人标注正确值
2. rebuild_candidate 需要人确认触发
3. 草案发布需要人审核

**核心缺失**：LLM 只作为构建者（extract 阶段），不作为**修复者**。

## 二、设计目标

在 `feedback → annotation` 之间插入一个 **LLM 自动标注器**，实现：

- Agent 单次负面反馈即可触发 LLM 分析
- 高置信度自动生成 annotation override
- 触发既有的 writeback → rebuild → draft → publish 链路
- 信任分达标即自动发布
- 低置信度或复杂场景保留给人类审核
- 保留完整的审计与回滚能力

## 三、关键决策

| 决策项 | 选择 | 说明 |
|---|---|---|
| 修复激进度 | 激进 | 单次负面反馈即触发，高置信直接落盘并发布 |
| 修复范围 | 仅知识组件 | LLM 只改 annotation `correctValue`，不修改源文档 |
| 自动发布 | 信任分达标即可 | 放宽 blocking task 检查，只要 auto_fixed 且 LLM 高置信即放行 |
| 总开关 | `KH_AUTO_REMEDIATION_ENABLED` 默认启用 | 开箱即用；无 LLM 时自动降级为跳过 |
| 置信度门槛 | 默认 0.85 | `KH_AUTO_REMEDIATION_CONFIDENCE_THRESHOLD` 可配置 |

## 四、数据流全链路

```
Agent 调用 MCP 工具（kb_search / kb_get_page / ...）
  │
  ▼
knowledgeQueryService.runTool()
  ├─ 执行工具查询
  ├─ feedbackService.applyRules() 分类反馈类型
  │   （hit / miss / low_quality_hit / evidence_insufficient / repeated_query）
  │
  ▼
feedbackService.recordFeedback()
  ├─ INSERT agent_event
  ├─ INSERT review_task (open, task_kind=annotation)
  ├─ emit "agent.feedback.received"        ◄── autoRemediationService 监听
  └─ maybeCreateRebuildProposal (原有 2+ 阈值兜底)

  ▼
autoRemediationService.onFeedbackReceived()  [新增]
  ├─ 前置过滤
  │   ├─ feedbackType === "hit" → skip
  │   ├─ !config.autoRemediationEnabled → skip
  │   └─ task 已 auto_fixed → skip（幂等）
  │
  ├─ 上下文组装
  │   ├─ 查 review_task 详细信息
  │   ├─ 查 asset_component 完整内容
  │   ├─ 查 evidence_records
  │   └─ 查 agent_event 原始查询
  │
  ├─ LLM 分析（复用 llmClient / modelConfig）
  │   输出 structured JSON:
  │     diagnosis, fixType, confidence, correctValue, rationale, suggestions
  │
  ├─ 高置信分支 (confidence ≥ 阈值 && fixType === "annotation_override")
  │   ├─ knowledgeService.annotateReviewTask({
  │   │     taskId, correctValue, applyMode: "override",
  │   │     actor: "system", autoFixed: true, llmAnalysis
  │   │   })
  │   ├─ INSERT annotation_examples (auto_generated=true, applyMode=override)
  │   ├─ UPDATE review_tasks (auto_fixed=true, status=resolved)
  │   ├─ emit "annotation.writeback_requested"
  │   │
  │   ▼
  │   annotationWritebackAutomationService  [现有]
  │   ├─ kbBuilderService.startScopedRebuildForComponent()
  │   │    model: deterministic, only: [component sourceRef]
  │   │    注入 annotation_example.correctValue 作为 override
  │   │
  │   ▼
  │   kbBuilderService.pipeline  [现有]
  │   ├─ convert → extract → tables → graph → viz → quality → collect → persist
  │   ├─ upsert 组件到 asset_components (merge into existing package)
  │   └─ emit "build.completed"
  │
  │   ▼
  │   releaseAutomationService  [现有 + 修改]
  │   ├─ proposeRevisionDraftFromBuild()
  │   ├─ buildAutoPublishCheck() [修改：autoFixed blocking 放行]
  │   ├─ autoPublishRevisions=true && eligible?
  │   │   ├─ YES → publish() → release channel 更新 → Agent 下次即用 ✅
  │   │   └─ NO  → 草案保留等人类 ⚠️
  │   │
  │   └─ 前端 "自动修复审计" 页显示结果
  │
  └─ 低置信分支
      ├─ 将 LLM suggestions 追加到 review_task.candidates
      ├─ diagnostic warn 日志
      └─ task 保持 open → 人类正常标注流程
```

## 五、变更清单

### 新增文件（2 个）

#### 1. `src/server/services/autoRemediationPrompts.ts`

- `AutoRemediationOutputSchema` zod schema
  - `diagnosis: string`
  - `fixType: "annotation_override" | "needs_human" | "no_fix"`
  - `confidence: number` (0-1)
  - `correctValue: object`
  - `rationale: string`
  - `suggestions: Array<{ label, value, rationale }>`
- `buildSystemPrompt(componentKind)` — 按组件类型给出 `correctValue` 期望结构
  - `wiki_page` → `{ markdown }`
  - `table` → `{ rows, columns }`
  - `entity` → `{ name, description, properties }`
  - `graph` → `{ nodes, edges }`
- `buildUserPrompt(ctx)` — 注入 feedbackType / agentQuery / componentContent / evidence / taskContext

#### 2. `src/server/services/autoRemediationService.ts`

- `registerAutoRemediation({ db, knowledgeService, kbBuilderService, diagnostics })`
- 监听 `agent.feedback.received` 事件
- 组装上下文 → 调 LLM → 分支处理
- 返回 unsubscribe 函数

### 修改文件（9 个）

#### 3. `src/server/config.ts`

新增：

```ts
autoRemediationEnabled: flag("KH_AUTO_REMEDIATION_ENABLED", true),
autoRemediationConfidenceThreshold: Number(optional("KH_AUTO_REMEDIATION_CONFIDENCE_THRESHOLD", "0.85")),
autoRemediationLlmProvider: optional("KH_AUTO_REMEDIATION_LLM_PROVIDER", ""),
autoRemediationLlmBaseUrl: optional("KH_AUTO_REMEDIATION_LLM_BASE_URL", ""),
autoRemediationLlmModel: optional("KH_AUTO_REMEDIATION_LLM_MODEL", ""),
autoRemediationLlmApiKey: optional("KH_AUTO_REMEDIATION_LLM_API_KEY", ""),
```

LLM 模型解析顺序（复用知识构建的 LLM 配置）：

1. **显式指定**：`KH_AUTO_REMEDIATION_LLM_*` 环境变量
2. **复用最近一次成功构建的 modelConfig**：从 `knowledge_build_runs.config_json.modelConfig` 读 provider/baseUrl/model；apiKey 从环境变量补（`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `KH_AUTO_REMEDIATION_LLM_API_KEY`）
3. **`OPENAI_API_KEY` 兜底**：OpenAI compatible
4. **降级为 deterministic**：跳过并写警告日志，不影响其他功能

#### 4. `src/server/types.ts`

新增：

```ts
export interface LlmAnalysis {
  diagnosis: string;
  confidence: number;
  rationale: string;
  fixType: "annotation_override" | "needs_human" | "no_fix";
  modelProvider: string;
  modelName: string;
  generatedAt: string;
}
```

- `AnnotationExample` 增加 `autoGenerated: boolean; llmAnalysis: LlmAnalysis | null`
- `ReviewTask` 增加 `autoFixed: boolean; llmAnalysis: LlmAnalysis | null`

#### 5. `src/server/db.ts`

追加 ALTER：

```sql
ALTER TABLE annotation_examples ADD COLUMN IF NOT EXISTS auto_generated BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE annotation_examples ADD COLUMN IF NOT EXISTS llm_analysis JSONB;
ALTER TABLE review_tasks ADD COLUMN IF NOT EXISTS auto_fixed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE review_tasks ADD COLUMN IF NOT EXISTS llm_analysis JSONB;
```

#### 6. `src/server/db/mappers.ts`

- `mapAnnotationExample` 追加 `autoGenerated` / `llmAnalysis`
- `mapReviewTask` 追加 `autoFixed` / `llmAnalysis`

#### 7. `src/server/app.ts`

```ts
import { registerAutoRemediation } from "./services/autoRemediationService";

let unsubscribeAutoRemediation: (() => void) | undefined;
if (config.autoRemediationEnabled) {
  unsubscribeAutoRemediation = registerAutoRemediation({
    db: options.db,
    knowledgeService: ctx.service,
    kbBuilderService: ctx.kbBuilderService,
    diagnostics,
  });
}

// onClose hook 中加入 unsubscribeAutoRemediation?.();
```

#### 8. `src/server/services/knowledgeService.ts`

- `annotateReviewTask()` 参数增加 `autoFixed?` `llmAnalysis?`
- INSERT annotation_examples 写入 `auto_generated` / `llm_analysis`
- UPDATE review_tasks 写入 `auto_fixed` / `llm_analysis`
- 新增 `addLlmSuggestions(taskId, suggestions)` — 追加到 `candidates`
- 新增 `listAutoFixedTasks(projectId)` — 列出 auto_fixed 任务
- 新增 `rollbackAutoFix(taskId, actor)` — 回滚：reopen 任务 + 停用 annotation_example

#### 9. `src/server/services/releaseService.ts`

`buildAutoPublishCheck()` 放宽松：

```ts
// 当前 blocking task 检查逻辑
// 新增：如果 task.autoFixed && llmAnalysis.confidence >= threshold → 不计入阻塞
const blockingForChanged = blocking.filter(t => {
  if (!t.autoFixed) return true;
  const analysis = t.llmAnalysis;
  if (!analysis) return true;
  return analysis.confidence < config.autoRemediationConfidenceThreshold;
});
```

#### 10. `src/server/services/feedbackAutomationService.ts`

`startRebuildFromReviewTask()` 幂等检查：

```ts
if (task.autoFixed) {
  diagnostics.write({ level: "info", message: `task ${taskId} already auto-fixed, skip` });
  return null;
}
```

#### 11. `src/server/routes/review.ts`

新增路由：

```
GET  /api/projects/:projectId/review/auto-fixed
POST /api/projects/:projectId/review/auto-fixed/:taskId/rollback
```

（"确认"操作实际是 no-op，只更新前端本地状态即可）

#### 12. `src/client/src/api/review.ts` + `src/client/src/pages/Review.tsx`

- 新增 API：`listAutoFixedTasks` / `rollbackAutoFix`
- Review 页面新增 "自动修复" Tab
- 展示：组件、反馈类型、LLM 诊断、修复前后、置信度
- 操作：[确认] / [回滚]

## 六、风险控制与回滚

1. **总开关默认启用**：`KH_AUTO_REMEDIATION_ENABLED=true`；未配置可用 LLM 时自动跳过并写警告日志
2. **置信度门槛**：默认 0.85，可通过环境变量提高
3. **信任分兜底**：即使自动修复，信任分不达标也不会发布
4. **回滚能力**：一键回滚，reopen task + 停用 annotation_example
5. **完整审计**：`llm_analysis` JSONB 保留完整 LLM 输出，diagnostic 日志留存全链路
6. **现有流程完全保留**：auto-remediation 是并行加速通道，人工路径仍可用

## 七、启用步骤

在 `.env` 中新增：

```
KH_AUTO_REMEDIATION_ENABLED=true
KH_AUTO_REMEDIATION_CONFIDENCE_THRESHOLD=0.85
KH_AUTO_REMEDIATION_LLM_PROVIDER=anthropic
KH_AUTO_REMEDIATION_LLM_MODEL=claude-sonnet-4-5
KH_AUTO_REMEDIATION_LLM_API_KEY=...
KH_AUTO_PUBLISH_REVISIONS=true
```

## 八、实施顺序

1. 基础设施：`config.ts` + `types.ts` + `db.ts` + `mappers.ts`
2. `autoRemediationPrompts.ts` — prompt + schema
3. `autoRemediationService.ts` — 核心服务
4. `app.ts` — 挂载
5. `knowledgeService.ts` — annotateReviewTask 扩展 + 审计相关方法
6. `releaseService.ts` — buildAutoPublishCheck 放宽松
7. `feedbackAutomationService.ts` — 幂等保护
8. `routes/review.ts` — 审计 API
9. 前端 API + Review Tab
10. `npm run typecheck`
