# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

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
  - 可选：`PORT`(4174)、`HOST`(0.0.0.0)、`KH_DATA_DIR`(`./data`，存上传 blobs 与 kb-build-runs 工作区)、`KH_LOG_*`、`KH_WEBIMPORT_RETENTION_HOURS`、`KH_KB_EXTRACT_MAX_TOKENS`、`OPENAI_*` 兜底。
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
okf/                        Open Knowledge Format 导出与一致性校验（发布时把资产导出为标准 bundle）
kbBuilder/                  流水线各阶段实现（见下）
```

### 知识构建流水线（`services/kbBuilder*`）

`kbBuilderService.ts` 编排一次构建 run，对某个 source version 跑五阶段流水线，顺序固定：

```
convert → extract → tables → graph → viz
```

每阶段在 `kbBuilder/<stage>Stage.ts`。`extract` 阶段调用 LLM（`kbBuilder/llmClient.ts` + `modelConfig.ts`，支持 deterministic / openai-compatible / anthropic）。产物经 `collector.ts` 收集、`qualityGate.ts` 按质量门禁 Profile 评估，落成 `asset_packages` + `asset_components` + `evidence_records`，并把质量发现衍生为 `review_tasks`。run 状态记录在 `knowledge_build_runs`（含 stages/completed_stages/current_stage，支持增量缓存）。

### 核心数据模型（均在 `db.ts:migrate()` 定义，PostgreSQL）

```
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

### 前端（`src/client/`）

```
src/main.tsx        React 19 + BrowserRouter + QueryClientProvider 挂载点
src/api/            按子域拆分的 fetch 封装 + 类型（types.ts）；http.ts 提供 getJson/postJson/patchJson 等
                    + token 持久化；index.ts 统一 re-export。组件不直接 fetch
src/pages/          各业务页面（Sources/Assets/Review/Release/AgentFeedback/Diagnostics/...）
src/components/     复用组件（Atoms、BuildRunCard、InlineEditor 等）
src/ui/             App 外壳与导航
src/utils/format.ts 展示格式化：formatTime/formatClock 统一按 Asia/Shanghai（东八区）渲染时间
```

数据请求统一走 `src/api/` 的函数 + `@tanstack/react-query`。Vite dev 端口 5174 代理 `/api → 127.0.0.1:4174`，前后端可同时跑。

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
