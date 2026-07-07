# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

Knowledge Hub 是一个 TypeScript 全栈应用，用于团队协作式的知识资产治理：把"资料"经过资产化、证据补全、审核、发布后供 Agent 使用，并接收 Agent 反馈以驱动迭代。前后端同仓部署，Fastify 同时承担 JSON API 与构建后 SPA 的静态托管。另有一个独立的 MCP stdio 服务器把已发布的知识暴露给外部 Agent。

## 常用命令

```bash
npm install              # 首次安装依赖
npm run dev              # 后端：tsx watch src/server/index.ts（热重载）
npm run dev:web          # 前端：vite dev，端口 5174，代理 /api → 4174
npm run build            # tsc 类型检查 + vite 打包到 dist/client
npm start                # 启动生产模式（tsx 直跑 src/server/index.ts），监听 4174
npm test                 # vitest run（一次性）
npm run test:watch       # vitest 监听模式
npm run typecheck        # 仅类型检查（tsc --noEmit）
npm run mcp:stdio        # 启动 MCP stdio 服务器（src/server/mcpStdio.ts）
npm run okf:scan         # OKF markdown 一致性扫描 CLI
npm run db:up            # docker compose 起本地 PostgreSQL
npm run db:down          # 停本地 PostgreSQL
npm run db:restore       # node scripts/restore-seed.mjs 恢复种子数据
```

运行单个测试文件 / 单个用例：

```bash
npx vitest run tests/api.test.ts
npx vitest run -t "renames a source bundle"
```

## 关键运行时要求

- **Node 22+**；后端用 `pg` 连接 **PostgreSQL**（不是 SQLite —— README/旧文档可能仍写 SQLite，以代码为准）。
- **环境变量**（模板见 `.env.example`，通过 `src/server/config.ts` 读取，缺必填项会启动即抛错）：
  - 必填：`KH_JWT_SECRET`、`DATABASE_URL`（PostgreSQL 连接串）。
  - 测试必填：`KH_TEST_DATABASE_URL` —— **单元测试始终连真实 PostgreSQL**，每个用例建独立 schema 实现隔离。没有它 `npm test` 直接报错。
  - 可选：`PORT`(4174)、`HOST`(0.0.0.0)、`KH_DATA_DIR`(`./data`，存上传 blobs 与 kb-build-runs 工作区)、`KH_PUBLIC_BASE_URL`、`KH_LOG_*`、`KH_WEBIMPORT_RETENTION_HOURS`、`KH_UPLOAD_MAX_*`（上传大小/数量上限）。
  - **自动化开关**（`config.ts`，控制事件驱动的自动化子系统，见下）：`KH_AUTO_PUBLISH_REVISIONS`(false，反馈驱动的修订版是否自动发布)、`KH_AUTO_BUILD_ON_UPLOAD`(true，上传新资料版本即自动增量构建→lint→发布)、`KH_HEALTH_SWEEP_INTERVAL_HOURS`(24，周期性知识健康巡检间隔小时；0 关闭)、`KH_GENERATE_BUILD_REVIEW_TASKS`(false)、`KH_AUTO_REMEDIATION_ENABLED`(true，lint 自动修复)、`KH_AUTO_REMEDIATION_CONFIDENCE_THRESHOLD`(0.85)、`KH_AUTO_REMEDIATION_LLM_*`（自动修复用的 LLM provider/baseUrl/model/apiKey）。这些是全局默认值，可被项目级治理 Profile 覆盖（见「治理 Profile」）。
- **首次启动**会在 PostgreSQL 中建/迁移 schema、seed 三个演示用户（admin/dev/viewer）、默认资料集、默认质量门禁 Profile 和默认策划立法规则 Profile（详见 `db.ts`）。
- 生产模式下若存在 `dist/client/`，`index.ts` 注册 `@fastify/static` 并对非 `/api/` 路径回退 `index.html`，所以发布前需先 `npm run build`。

## 架构骨架

代码分前后端两侧，根目录 `src/server` 与 `src/client`。后端遵循「路由 → Service → DB」的薄分层；前端是 React 19 + React Query SPA。

### 后端（`src/server/`）

```
index.ts            进程入口；createDatabase → buildApp → 挂 dist/client 静态资源 → listen
mcpStdio.ts         独立 MCP stdio 服务器；复用 KnowledgeQueryService 暴露 kb_* 工具
app.ts              buildApp：构造所有 service 装进 RouteContext，注册 JWT/CORS/multipart、
                    全链路 tracing 钩子、统一错误处理，然后逐个 registerXxxRoutes
config.ts           环境变量集中读取与校验
db.ts               createDatabase：建池、migrate（CREATE/ALTER IF NOT EXISTS）、seed
db-adapter.ts       PostgresAdapter：封装连接池；query/exec/close + BEGIN/COMMIT 事务客户端、schema 前缀
db/mappers.ts       纯行映射：snake_case 列 → camelCase 领域对象（JSONB 列用 jsonArray/jsonObject 兼容字符串与已解析值）
types.ts            领域类型 + DatabaseHandle + DatabaseAdapter
schemas.ts          所有 API 入参的 zod schema
middleware/auth.ts  requireRole(...) / denyRole(...) preHandler 工厂
routes/             每个子域一个 registerXxxRoutes(app, ctx)，由 routes/context.ts 的 RouteContext 注入 service
services/           业务层（见下）
```

**路由分层边界**：HTTP 路由不直接拼业务读模型，调用注入的 service。`routes/context.ts` 的 `RouteContext` 是 service 的依赖注入容器。新增只读列表/汇总接口扩展对应 service，不要在路由里查 SQL。写路径（资料导入、构建、发布）各有独立 service。

**核心 service**：

```
knowledgeService.ts        读模型聚合 + 资产包写：dashboard/packages/components/review/evidence/
                           releases/agent events/mcp audit；updatePackage、deletePackage
sourceBundleService.ts     资料库：导入目录为新版本（内容哈希去重、幂等版本号）、diff、updateBundle/updateVersion
kbBuilderService.ts        知识构建流水线编排（见下）
releaseService.ts          发布：createDraft/publish/rollback/updateRelease；publish 时跑质量门禁、
                           补 evidence、调 OKF 导出、冻结 manifest hash、切换 release channel
knowledgeQueryService.ts   kb_* 工具实现（被 /api/mcp/query 和 mcpStdio.ts 共用）；查询当前发布版本
legislationService.ts      策划立法规则 Profile（文档类型/页面类型/实体类型/关系类型/质量规则）
attributionAuditService.ts Agent 输出归因审计
diagnosticService.ts       结构化日志 + trace/span（写文件和/或 DB）
storageMaintenanceService.ts 存储扫描与回收
tableAliasService.ts       表名别名
projectService.ts          多项目：createProject 建项目 + 默认资料库；子域按 projectId 隔离
feedbackService.ts         Agent 反馈落库 + 聚类为 human exception / feedback cluster
flywheelService.ts         「知识运营台」聚合编排层（见「飞轮与事件驱动自动化」）
governanceProfileService.ts 项目级治理规则覆盖层（见「治理 Profile」）
lintRemediationService.ts  OKF lint 发现 → 自动/人工修复（scoped rebuild）
lintAutoRemediation.ts     lint 别名自动修复：中文表名解析失败 → LLM 映射 canonical → 写翻译表 → 全量重建发布
trustScore.ts              组件可信度评分（feed 治理与飞轮）
eventService.ts            进程内知识事件总线 + knowledge_events 表（见下）
sse.ts                     Server-Sent Events 帧格式化（构建日志/诊断流）
okf/                        Open Knowledge Format 导出与一致性校验（发布时把资产导出为标准 bundle）；含 lintService
kbBuilder/                  流水线各阶段实现（见下）
```

**`register*` 自动化订阅者**（不是 service，是 `app.ts` 里挂到事件总线的订阅函数，返回 unsubscribe，在 `onClose` 注销）：`registerFeedbackAutomation`、`registerAnnotationWritebackAutomation`、`registerLintRemediationAutomation`、`registerReleaseAutomation`、`registerAutoRemediation`（仅 `KH_AUTO_REMEDIATION_ENABLED` 时挂）、`registerLintAutoRemediation`（**lint 别名自动修复**：仅 `KH_AUTO_ALIAS_REMEDIATION_ENABLED` 时挂，见下）、`registerSourceIngestAutomation`（**上传即流转**：监听 `source.version_imported`，仅当相对上一版本确有变更时自动调 `flywheelService.sync` 走增量构建→lint→发布；仅 `KH_AUTO_BUILD_ON_UPLOAD` 且生产入口 `index.ts` 通过 `enableSourceIngestAutomation` 显式开启时挂，测试默认不挂以免后台构建污染断言）。

**时间驱动调度器**（非事件订阅者）：`registerHealthSweepScheduler`（`healthSweepScheduler.ts`）—— 每 `KH_HEALTH_SWEEP_INTERVAL_HOURS` 小时对每个项目跑一次 `KnowledgeQueryService.runScheduledHealthCheck`（lint/trust/**过期审计**巡检）。「知识过期」是时间相关的（组件超 `maxAuditAgeDays` 未复审即过期），只有周期触发才能及时发现，事件驱动结构上无法覆盖。结果落 `knowledge_lint.health_checked` 事件进入自动化历史。定时器 unref + 重叠保护；仅生产入口经 `enableHealthSweep` 开启，测试默认不启动（用 `runHealthSweepOnce` 单跑一次做断言）。

### 飞轮与事件驱动自动化（阶段7 核心）

系统在确定性的「路由 → Service → DB」之上叠了一层**事件驱动的知识运营飞轮**：

- **事件总线**（`eventService.ts`）：`emitKnowledgeEvent` 同时写 `knowledge_events` 表**并**通过进程内 `EventEmitter` 广播；`onKnowledgeEvent(type, listener)` 订阅。事件类型是联合类型（`build.completed`/`agent.feedback.received`/`release.published`/`knowledge_lint.remediations_recorded` 等），改动时同步更新该联合。事件带 `projectId`（缺省 `default_project`）。
- **自动化订阅者**：`app.ts` 启动时挂上述 `register*Automation`，把「构建完成 → 记录 lint 修复 → 执行修复 → 发布」串成链。写路径仍走既有确定性服务；订阅者只做**编排触发**，不绕过 service。
- **lint 别名自动修复**（`lintAutoRemediation.ts` / `registerLintAutoRemediation`）：`table_dependencies` 未解析、`graph` 的 `configured_in` 悬空边——本质都是正文/关系里的（多为中文）表名解析不到 canonical table，**单纯重建修不好**（同样的源再跑一遍还是解析不到），过去只能进例外中心等人补别名。执行器监听 `knowledge_lint.remediations_recorded`，读该发布的 lint 报告 + `search/index.json`（取 Data Dependencies 原文）+ `tables/schemas.json`（canonical 表名），调 LLM 从**封闭动作集**把未解析术语映射到**真实存在的** canonical（`canonical` 必须命中已知表名集合，否则拒绝，不凭空造表名），写入持久化 `table_aliases`（翻译表），再触发一次 `flywheelService.sync({mode:"full"})`——别名改了但源没变，必须全量重建才能让 extract 重新套用别名（extract 在 `extractStage.ts` 里对关系 source/target 与正文依赖都走 `tableAliases.resolve/resolveMany`，构建时 `writeAliasFile(exportRows())` 把 DB 别名写进工作区，每次构建重套 → 修复持久）。**收敛保证**：只有本轮确实新增别名（按 `aliasKey` 归一化去重）才 sync，否则 `no_action`，避免「重建→lint→再重建」死循环；无 LLM / 无报告 / 非表类悬空边一律安全跳过或留人。开关 `KH_AUTO_ALIAS_REMEDIATION_ENABLED`（默认 true），复用 `KH_AUTO_REMEDIATION_LLM_*` 与置信阈值。`lintRemediationService.executePending` 因此**跳过 `table_dependencies` 域**（交由本执行器专属处理，避免空转与重复发布）。发布可回滚是安全网。
- **FlywheelService**（`flywheelService.ts`）：只读聚合 + 一键编排层，把构建/治理/发布/反馈收敛成「一句话状态 + 一个主动作」。三个入口：`getStatus`（状态 + metrics + 例外 + 自动化）、`listExceptions`（必须人工处理的项）、`sync`（一键构建 + 治理 + 自动发布）。路由 `routes/flywheel.ts`，每入口都有 `default_project` 与显式 `:projectId` 两条路径。
  - **例外软忽略**：`dismissException`/`restoreException`/`listDismissedExceptions` 落 `exception_dismissals` 表；`listExceptions` 过滤掉仍生效的忽略项（`getStatus` 的 pendingExceptions 也随之不计）。前端在知识运营台例外卡上「忽略」（填原因），并有「已忽略」折叠区可恢复。denyRole viewer。
  - **单组件重建 → 修订发布**：`rebuildComponent(componentId)` 按组件类型分流——源级 wiki 页/表说明页走 `builder.startScopedRebuildForComponent`（`only=<源文件>` + `mergeIntoPackageId`）；图谱组件走 `rebuildGraph` → `builder.startGraphRebuild`（**阶段级**：全量跑流水线重建派生所需 `_meta`，但只把 graph 阶段组件 `graph_snapshot/graph_view/topic_index` 合并回原包，`scopedStage:"graph"`）。两者都 `publishOnComplete`，经 `releaseAutomationService` 作为**当前发布的修订**发布（继承父发布、只 patch 变更组件，不动未受影响部分）。前端在资产组件详情（Assets 页 viewer-head）提供「重建并发布修订」。图谱因无跨运行 extract 缓存，会重新运行抽取（有模型开销），换取健壮性。

### 治理 Profile（阶段7）

`governanceProfileService.ts` 是**项目级治理规则覆盖层**：`config.ts` 的自动化开关是全局默认（`DEFAULT_GOVERNANCE_DEFAULTS`），`resolve(projectId)` 合并「默认 + 项目级 JSONB 覆盖」返回完整 profile，`update(projectId, patch)`（仅 admin）落覆盖。发布自动化、反馈聚类等消费方一律通过 `resolve` 拿确定数值，**不再散读 config 常量**。路由 `routes/governance.ts`（GET 只读 / PUT admin 覆盖 / POST reset 清覆盖）。

### 多项目

`projects` 表是所有子域的隔离维度，`projectService.createProject` 建项目时连带建默认资料库。API 普遍成对存在：`/api/flywheel/...`（隐式 `default_project`）与 `/api/projects/:projectId/...`（显式）。新增按项目隔离的读写接口时保留这套双路径。

### 知识构建流水线（`services/kbBuilder*`）

`kbBuilderService.ts` 编排一次构建 run，对某个 source version 跑五阶段流水线，顺序固定：

```
convert → extract → tables → graph → viz
```

每阶段在 `kbBuilder/<stage>Stage.ts`。`extract` 阶段调用 LLM（`kbBuilder/llmClient.ts` + `modelConfig.ts`，支持 deterministic / openai-compatible / anthropic）。产物经 `collector.ts` 收集、`qualityGate.ts` 按质量门禁 Profile 评估，落成 `asset_packages` + `asset_components` + `evidence_records`，并把质量发现衍生为 `review_tasks`。run 状态记录在 `knowledge_build_runs`（含 stages/completed_stages/current_stage，支持增量缓存）。

### 核心数据模型（均在 `db.ts:migrate()` 定义，PostgreSQL）

```
projects                   多项目隔离维度；所有子域按 project_id 归属，缺省 default_project
users                      本地账号（bcrypt），role: admin/developer/viewer
source_blobs               按 content_hash 去重的不可变文件内容
source_bundles             资料库（name/description 可改）
source_bundle_versions     资料库版本（label/note 可改）；parent_version_id 串成版本链
source_files               version ↔ blob 的逻辑路径映射
quality_gate_profiles      知识质量门禁配置（JSONB）
knowledge_rule_profiles    策划立法规则配置（JSONB），active 标记当前启用版本
knowledge_build_runs       一次流水线运行的状态机
asset_packages             知识资产包（name/description 可改）；source_version_ids/quality_summary 为 JSONB
asset_components            包内组件：wiki/index/graph/table（kind + group_name）
evidence_records           组件 ↔ source version 的引用证据
review_tasks               质量发现衍生的人工任务（severity: blocking/warning/info）
releases                   面向 Agent 的不可变发布（version/note 可改；manifest_json 冻结快照）
release_channels           当前发布指针（default channel 指向 current release）
annotation_examples        标注示例（few-shot / 人工纠正样本）
source_corrections         源侧纠正建议（状态机：pending_review → confirmed/retired）
rule_dismissals            被忽略的规则命中
knowledge_events           事件总线持久化（event_type/entity/payload_json/project_id）
knowledge_lint_remediations OKF lint 自动/人工修复记录（状态机）
knowledge_governance_profiles 项目级治理规则覆盖（单行 JSONB / 项目）
exception_dismissals        例外收件箱的软忽略记录（dedup_key = 例外稳定 id；restored_at 为空=忽略生效，可恢复、留痕）
agent_events / mcp_audit   Agent 调用反馈与 MCP 审计
attribution_audits         Agent 输出归因
diagnostic_logs            结构化日志（trace_id/span_id）
table_aliases              表名别名
```

JSONB 列（`source_version_ids`、`quality_summary`、`package_ids`、`manifest_json`、`config_json`、`hit_component_ids`、`quality_flags` 等）在 `pg` 下读出已是 JS 值，但映射统一走 `db/mappers.ts` 的 `jsonArray`/`jsonObject`，二者同时兼容字符串与已解析值——新增 JSONB 字段沿用这套映射。

**用户面 vs 内部 ID**：产品语言用「资料库 → 知识资产包 → 资产组件 → 审核任务 → 发布版本 → Agent 反馈」，但 admin/lead 仍能看到 `sourceVersionId / packageId / componentId / artifactId / releaseId`。在 UI、API、文档中保留这套双层命名，不要把内部 ID 隐藏到只剩业务名。

### MCP / Agent 消费面

已发布的知识通过 `KnowledgeQueryService` 暴露的 `kb_*` 工具（kb_search、kb_get_page、kb_get_entity、kb_query_table 等）供 Agent 消费，两条入口共用同一份实现：
- HTTP：`POST /api/mcp/query`（`routes/agent.ts`，JWT 保护，写 mcp_audit）。
- stdio：`npm run mcp:stdio`（`mcpStdio.ts`，标准 MCP 协议）。

工具只读「当前发布版本」（release channel 指向的 release）的冻结快照，不读 draft 资产。

### 可观测性

`app.ts:registerTracing` 给每个请求挂 traceId/span：`onRequest` 生成或透传 `x-trace-id`，`preHandler` 起 span，`onSend`/错误处理收尾。各 service 写入时也起子 span。日志由 `diagnosticService` 落到文件和/或 `diagnostic_logs` 表，前端 Diagnostics 页可按 trace 查看。

### 前端（`src/client/src/`，注意是 `client/src/` 两层）

```
main.tsx          React 19 + BrowserRouter + QueryClientProvider 挂载点
api/              按子域拆分的 fetch 封装 + 类型（types.ts）；http.ts 提供 getJson/postJson/patchJson 等
                  + token 持久化；index.ts 统一 re-export。组件不直接 fetch
pages/            各业务页面（Sources/Assets/Review/Release/AgentFeedback/Diagnostics/
                  Dashboard/System/GovernanceProfile/Rules/Legislation/Storage/Maintenance/TableAliases/...）
components/       复用组件（Atoms、BuildRunCard、InlineEditor、LintRemediationPanel、
                  BuildLogConsole、WorkbenchStrip、WritebackSteps 等）
ui/               App 外壳、navigation.tsx 导航、projectContext.tsx 当前项目上下文
utils/format.ts   展示格式化：formatTime/formatClock 统一按 Asia/Shanghai（东八区）渲染时间
```

数据请求统一走 `src/api/` 的函数 + `@tanstack/react-query`。多项目通过 `ui/projectContext.tsx` 提供当前 projectId。Vite dev 端口 5174 代理 `/api → 127.0.0.1:4174`，前后端可同时跑。构建日志/诊断走 SSE（`services/sse.ts` 帧格式，`routes/builder.ts` 等推流）。

### 测试（`tests/`）

Vitest，环境 `node`。所有测试用 `app.inject()` 直接调用 Fastify，避免起真实端口。每个用例 `createDatabase({ schema: 唯一名 })` 在 `KH_TEST_DATABASE_URL` 指向的库里建独立 schema，结束后 `DROP SCHEMA … CASCADE`，互不干扰。`tests/helpers/testEnv.ts` 强制要求该连接串。新增 service 测试沿用此模式。

## 编辑指引（项目特定）

- **强类型 + Zod**：API 入参先用 `src/server/schemas.ts` 的 zod schema 校验再进 service；领域类型从 `types.ts` 集中导出，路由里不要就地 `any`。
- **行映射集中在 mappers.ts**：所有 `SELECT *` 的行 → 领域对象都走 `db/mappers.ts`，新增列要同步对应 mapper。
- **不可变资料/发布**：`source_blobs`/`source_bundle_versions` 与 `releases` 的内容快照不可变。重导入要走「新版本」而非 update 现有行（`sourceBundleService` 的幂等逻辑是范例）；`releases.manifest_json` 在 publish 时冻结。名称/备注（name/label/version/note/description）属可变元数据，已有对应 PATCH 接口。
- **写权限网关**：改名/删除等写操作用 `denyRole("viewer")` 或 `requireRole("admin")`（删包、发布走 admin）。
- **迁移用 IF NOT EXISTS**：`db.ts:migrate()` 全部 `CREATE TABLE IF NOT EXISTS` + 末尾 `ALTER TABLE … ADD COLUMN IF NOT EXISTS`，二次启动幂等。加列时追加 ALTER，不要改已有 CREATE 破坏既有库。
- **Seed 幂等**：演示数据靠 `users` 表为空判断是否注入；默认 Profile 用 `ON CONFLICT DO NOTHING` 兜底。
- **旧 kb-builder 目录只读**：`scanLegacyKbBuilder` / `importLegacyAsDraftPackage`（`legacyScanner`/`legacyImportService`）必须保持「不修改源目录」契约。
- **时间统一东八区**：前端展示时间一律走 `utils/format.ts` 的 `formatTime`/`formatClock`，不要直接渲染原始 ISO 字符串；DB 存 `TIMESTAMPTZ`（UTC）。
