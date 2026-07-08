# 轻量知识运营台开发方案

## 背景

当前系统已经具备资料导入、知识构建、Knowledge Lint、LLM 治理、自动修复、发布、MCP 消费和 Agent 反馈回流能力。但从策划用户视角看，界面仍偏向“流程控制台”：用户需要理解资料库、构建、资产包、审核、发布、反馈等多个环节，手动判断下一步。

下一阶段目标是把应用收敛成“轻量知识运营台”：

- 用户只做知识的轻量化管理、观测和少量例外处理。
- 构建、治理、发布、反馈回流尽量自动完成。
- 人只在 AI 不确定、知识会被删除/覆盖、Agent 消费明显受影响时介入。

## 总体原则

1. **首页成为主入口**
   用户进入系统后只需要知道当前知识库状态和下一步动作，不需要先判断应该去资料库、构建页、审核页还是发布页。

2. **流程自动化，详情可追溯**
   默认走自动流水线；构建 run、资产包、发布 revision、Knowledge Lint 报告仍保留，但作为详情和排障入口。

3. **审核中心降级为例外中心**
   不再展示所有 warning 和技术规则。只展示必须由人判断的例外。

4. **LLM 负责治理建议，确定性链路负责执行**
   LLM 判断问题含义、风险和治理动作；真正写回资料、重建、发布仍走确定性服务，避免直接修改不可变 OKF 发布包。

5. **业务对象优先，技术 ID 降噪**
   默认显示 wiki 文件、知识标题、活动/系统/表名等业务对象。`cmp_pkg...`、runId、releaseId 默认放到详情或 tooltip。

## 阶段 1：飞轮总控台

### 目标

把首页改成唯一主入口，展示当前项目的一句话状态和一个主动作。

### 后端

新增或扩展接口：

```http
GET /api/projects/:projectId/flywheel/status
```

返回结构建议：

```ts
interface FlywheelStatus {
  state:
    | "idle"
    | "source_changed"
    | "building"
    | "ready_to_publish"
    | "published"
    | "needs_attention";
  headline: string;
  summary: string;
  primaryAction: {
    label: string;
    action:
      | "sync_and_publish"
      | "open_exceptions"
      | "open_sources"
      | "open_release"
      | "retest_agent";
    params?: Record<string, string>;
  };
  metrics: {
    sourceChanges: number;
    runningBuilds: number;
    pendingExceptions: number;
    currentReleaseVersion: string;
    agentFeedbackOpen: number;
    autoGovernedToday: number;
  };
  attentionItems: Array<{
    id: string;
    type: "exception" | "feedback" | "publish_blocker" | "lint";
    title: string;
    body: string;
    severity: "blocking" | "warning" | "info";
    actionLabel: string;
    target?: { page: string; params?: Record<string, string> };
  }>;
  recentAutomation: Array<{
    id: string;
    title: string;
    status: "running" | "completed" | "skipped" | "failed";
    createdAt: string;
  }>;
}
```

聚合来源：

- 最新资料版本和 build-plan
- 最近构建 run
- 当前 release
- Knowledge Lint governance
- 自动修复事件
- Agent feedback 聚合
- open blocking/manual-review tasks

### 前端

首页展示：

- 当前项目名称
- 一句话状态，例如“知识库已同步，Agent 正在消费 2026.07.03.001”
- 一个主按钮，例如：
  - `同步资料并发布`
  - `查看 2 个例外`
  - `复测 Agent 查询`
- 少量状态指标
- 最近自动化链路

构建、发布、审核仍保留导航入口，但不再要求用户按流程逐页操作。

### 验收

- 用户不理解构建/发布细节，也能知道是否需要操作。
- 正常状态下首页没有任务列表压力。
- 异常状态下只突出必须处理的问题。

## 阶段 2：一键同步并发布

### 目标

把资料导入后的“构建 + lint + 治理 + 发布”合成默认流水线。

### 后端

新增接口：

```http
POST /api/projects/:projectId/flywheel/sync
```

内部流程：

1. 找到当前项目最新资料版本。
2. 生成 build-plan。
3. 优先增量构建。
4. 运行 Knowledge Lint。
5. 运行 LLM governance。
6. 对 `autoEligible=true` 的项目进入自动治理。
7. 没有阻断例外时自动发布 revision。
8. 返回链路摘要。

返回结构建议：

```ts
interface FlywheelSyncResult {
  syncId: string;
  status: "started" | "completed" | "needs_attention" | "failed";
  buildRunIds: string[];
  packageIds: string[];
  releaseId?: string;
  published: boolean;
  attentionItems: FlywheelStatus["attentionItems"];
  automationEvents: string[];
}
```

### 前端

资料上传完成后显示：

- 本次变更摘要
- 推荐模式：增量/全量
- 主按钮：`同步并发布`
- 可展开查看 build-plan

### 验收

- 稳定规则下，用户上传资料后点击一次即可完成发布。
- 构建失败、lint 阻断、自动发布跳过都能回到总控台展示原因。

## 阶段 3：例外中心

### 目标

把审核中心重构为“例外中心”，只展示需要人介入的问题。

### 过滤规则

默认展示：

- LLM 低置信，需要人选正确答案
- 自动治理失败
- 即将删除或覆盖已有知识
- Agent 高频负反馈
- 发布阻断
- 确定性源覆盖待复核

默认隐藏：

- 普通 warning
- 已自动治理的问题
- 纯技术 ID 型记录
- 不影响 Agent 消费的观察项

### 数据结构

在 review/feedback/lint 派生任务上补充：

```ts
interface HumanException {
  requiresHuman: boolean;
  attentionLevel: "blocking" | "needs_decision" | "watch";
  userProblem: string;
  whyHumanNeeded: string;
  recommendedAction: string;
  primaryAction: {
    label: string;
    type: "annotate" | "approve" | "reject" | "open_asset" | "rerun";
  };
}
```

### 前端

每条例外必须清楚说明：

- 问题是什么
- 影响哪个知识
- 为什么不能自动处理
- 推荐修复方式
- 主按钮

避免展示裸 `cmp_pkg...`。默认展示知识标题或文件路径。

### 验收

- 没有 Agent 反馈、没有低置信时，例外中心应接近为空。
- 用户不需要读规则 ID 就能判断怎么处理。

## 阶段 4：Knowledge Lint 自动治理队列

### 目标

把现有 `KnowledgeLintIssue.governance` 从“建议”推进到“自动治理队列”。

### 后端

新增表或复用事件流记录治理任务：

```ts
interface KnowledgeLintRemediation {
  remediationId: string;
  projectId: string;
  releaseId: string;
  issueId: string;
  domain: KnowledgeLintDomain;
  actionType: "auto_remediation" | "rebuild" | "manual_review" | "monitor";
  confidence: number;
  status: "pending" | "running" | "completed" | "failed" | "needs_human";
  targetComponentId?: string;
  targetOkfPath?: string;
  createdAt: string;
  finishedAt?: string;
  error?: string;
}
```

治理映射：

- `links`
  - 低风险链接格式问题可生成 markdown/source correction proposal。
  - 断链目标不明确时进入人工例外。
- `table_dependencies`
  - 可根据 table aliases 和 canonical schema 自动生成依赖修正。
  - 无法映射时进入人工例外。
- `graph`
  - 优先触发 graph scoped rebuild。
  - 图谱 JSON 损坏进入重建或人工排障。
- `trust/evidence`
  - 优先触发证据补全或重建。
  - 证据源缺失进入人工例外。
- `mcp_feedback`
  - 聚合成知识缺口或误命中任务。
  - 高频问题进入例外中心。

### 前端

发布页和总控台展示：

- 自动治理 N 项
- 需要人工 M 项
- 已触发重建/发布链路
- 最近失败原因

### 验收

- `autoEligible=true` 的 lint issue 不停留在报告里，而是进入治理链路。
- 不能自动治理的问题才进入例外中心。

## 阶段 5：Agent 反馈业务化

### 目标

把 MCP 原始事件聚合成策划能理解的知识问题。

### 后端

新增反馈聚合：

```ts
type FeedbackClusterType =
  | "knowledge_gap"
  | "bad_hit"
  | "stale_knowledge"
  | "low_trust_hit";

interface AgentFeedbackCluster {
  clusterId: string;
  projectId: string;
  type: FeedbackClusterType;
  title: string;
  queryExamples: string[];
  affectedComponents: string[];
  count: number;
  severity: "blocking" | "warning" | "info";
  recommendedAction: string;
  status: "open" | "auto_governing" | "needs_human" | "resolved" | "ignored";
}
```

聚合逻辑：

- 按 query normalize 后聚合。
- 按 hit component 聚合。
- 高频 miss 转知识缺口。
- 低可信 hit 转 trust/lint 治理。
- bad hit 转标注任务。

### 前端

反馈页显示业务问题：

- “荣耀连战查询 6 次，命中 2 个低可信页面”
- “竞技狂欢缺少可追溯证据”
- “某活动依赖表未解析，导致 Agent 回答不稳定”

每条只保留主动作：

- `让 AI 修复`
- `标注正确答案`
- `忽略此类反馈`

### 验收

- 用户不需要读 MCP payload。
- 高频问题能进入飞轮总控台和例外中心。

## 阶段 6：技术 ID 降噪

### 目标

默认用业务对象展示知识资产，技术 ID 只用于排障。

### 前端规则

默认显示：

- wiki 标题
- wiki 路径
- 活动/系统/表名
- 可信状态
- 最近反馈

隐藏或弱化：

- `cmp_pkg...`
- packageId
- runId
- releaseId

技术 ID 展示位置：

- tooltip
- 折叠详情
- 排障模式
- 复制按钮

### 后端支持

读模型补充 display fields：

```ts
interface KnowledgeDisplayRef {
  title: string;
  path: string;
  kind: string;
  sourcePath?: string;
  projectName?: string;
  technicalIds: {
    componentId?: string;
    packageId?: string;
    runId?: string;
    releaseId?: string;
  };
}
```

### 验收

- 主要列表中不再出现撑破 UI 的长 ID。
- 排障人员仍能复制完整 ID。

## 阶段 7：治理规则集中化

### 目标

把 trust、lint、auto remediation、发布策略集中到项目级治理规则中。

### 后端

新增或扩展 profile：

```ts
interface KnowledgeGovernanceProfile {
  projectId: string;
  trust: {
    minAutoPublishScore: number;
    requireEvidence: boolean;
  };
  lint: {
    autoGovernanceEnabled: boolean;
    autoEligibleThreshold: number;
    domains: Record<KnowledgeLintDomain, {
      enabled: boolean;
      allowAutoRemediation: boolean;
      requireHumanForBlocking: boolean;
    }>;
  };
  release: {
    autoPublishRevisions: boolean;
    blockOnDeletes: boolean;
    blockOnTrustDecline: boolean;
    blockOnPendingCorrections: boolean;
  };
  feedback: {
    autoClusterEnabled: boolean;
    highFrequencyThreshold: number;
  };
}
```

### 前端

放在“策划立法/治理规则”页。

普通用户只看治理结果；管理员调整规则。

### 验收

- 不同游戏项目可以配置不同治理策略。
- 环境变量只作为默认值，项目级 profile 优先。

## 推荐实施顺序

第一批：

1. 飞轮总控台
2. 一键同步并发布
3. 例外中心

第二批：

4. Knowledge Lint 自动治理队列
5. Agent 反馈业务化

第三批：

6. 技术 ID 降噪
7. 治理规则集中化

## 总体验收标准

- 策划上传资料后，不需要理解构建、资产包、发布等工程概念，也能一键完成同步。
- 正常情况下首页显示“知识库已同步，Agent 可用”。
- 有问题时只展示少量必须人工处理的例外。
- 自动治理做了什么、为什么没自动发布，都能在总控台和详情页看懂。
- MCP/Agent 只消费 current release，不读草稿或半成品。
- 详情链路仍可追溯：资料版本、构建 run、资产组件、lint、治理任务、发布 revision、Agent 反馈都能串起来。
