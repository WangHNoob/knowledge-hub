# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## 项目概览

Knowledge Hub 是一个 TypeScript 全栈应用，用于团队协作式的知识资产治理：把"资料"经过资产化、证据补全、审核、发布后供 Agent 使用，并接收 Agent 反馈以驱动迭代。前后端同仓部署，Fastify 同时承担 JSON API 与构建后 SPA 的静态托管。

## 常用命令

```bash
npm install              # 首次安装依赖
npm run dev              # 后端：tsx watch src/server/index.ts（热重载）
npm run dev:web          # 前端：vite dev，端口 5174，代理 /api → 4174
npm run build            # tsc 类型检查 + vite 打包到 dist/client
npm start                # 启动生产模式（tsx 直跑 src/server/index.ts），监听 4174
npm test                 # vitest run（一次性）
npm run test:watch       # vitest 监听模式
npm run typecheck        # 仅类型检查
```

运行单个测试文件 / 单个用例：

```bash
npx vitest run tests/api.test.ts
npx vitest run -t "returns a dashboard"
```

## 关键运行时要求

- **Node 22+**：服务器使用 `pg` 连接 PostgreSQL。
- **环境变量**：`PORT`（默认 4174）、`HOST`（默认 0.0.0.0）、`KH_DATA_DIR`（默认 `./data`，存放上传的 source blobs 与 kb-build-runs 工作区）、`KH_JWT_SECRET`（必填）、`DATABASE_URL`（必填，PostgreSQL 连接串）。
- **首次启动**会在 PostgreSQL 中创建 schema、迁移表结构、seed 三个演示用户和示范数据；详见 README。
- 生产模式下若存在 `dist/client/`，Fastify 会注册静态插件并对非 `/api/` 路径回退 `index.html`，所以发布前需要先 `npm run build`。

## 架构骨架

代码分为前后端两侧，以 `src/server` 与 `src/client` 为根。后端遵循「路由 → Service → DB」的薄分层，前端是 React 19 + React Query SPA。

### 后端（`src/server/`）

```
index.ts            进程入口；构造 db、调用 buildApp，挂载 dist/client 静态资源
app.ts              Fastify 实例与所有 /api 路由；JWT/CORS/multipart 注册
db.ts               DatabaseSync 创建、PRAGMA、迁移（CREATE TABLE IF NOT EXISTS）、demo seed
types.ts            领域类型 + DatabaseHandle
services/
  knowledgeService.ts    读模型聚合：dashboard / packages / review / evidence / releases / agent events
  sourceImportService.ts 上传资料 → 内容哈希、幂等版本号、写 storage/sources/
  legacyScanner.ts       扫描旧 kb-builder data/ 目录（不写）
  legacyImportService.ts 把旧扫描结果落库为 draft asset_package（保留原文件不变）
```

**重要边界**：HTTP 路由不直接拼业务读模型；它们调用 `KnowledgeService`，由 service 拥有产品语义。新增列表/汇总型只读接口要扩展该 service，而不是在 `app.ts` 里查 SQL。写入路径（资料导入、旧库导入）拆成独立 service，因为它们要写文件系统。

**核心数据模型**（以下表均在 `db.ts:migrate()` 中定义）：

```
sources             不可变资料版本（source_version_id 是主键，source_id 用于聚合）
asset_packages      一次导入/生成/手工策划单元；source_version_ids、quality_summary 存 JSON 字符串
asset_components    包内组件：wiki / index / graph / table（kind + group_name）
evidence_records    组件 ↔ 资料版本的引用证据
review_tasks        从质量发现衍生的人工任务（severity: blocking/warning/info）
releases            面向 Agent 的不可变发布版本
agent_events        Agent 调用反馈（hit/miss + quality_flags）
users               本地账号（bcrypt）
```

JSON 数组/对象字段（`source_version_ids`、`legacy_paths`、`quality_summary`、`source_refs`、`quality`、`package_ids`、`hit_component_ids`、`quality_flags`）在表里都是 TEXT，写入/读取要 `JSON.stringify`/`JSON.parse`。修改这些字段时要保持双向一致。

**用户面 vs 内部 ID**：产品语言用「资料库 → 知识资产包 → 资产组件 → 审核任务 → 发布版本 → Agent 反馈」，但 admin/lead 仍能看到 `sourceVersionId / packageId / componentId / artifactId / releaseId`。在 UI、API、文档中保留这套双层命名，不要把内部 ID 隐藏到只剩业务名。

### 前端（`src/client/`）

```
index.html
src/main.tsx        React 19 + BrowserRouter + QueryClientProvider 挂载点
src/api.ts          fetch 封装 + token 持久化（localStorage）+ 类型化请求函数
src/ui/App.tsx      所有页面（登录、Dashboard、资料、资产包、审核、发布、Agent 反馈、旧库导入）
src/styles.css
```

数据请求统一走 `api.ts` 中的函数 + `@tanstack/react-query`；组件不要直接 `fetch`。Vite dev 端口 5174 代理 `/api → 127.0.0.1:4174`，因此前后端可同时跑。

### 测试（`tests/`）

Vitest，环境 `node`，所有测试用 `app.inject()` 直接调用 Fastify，避免起真实端口。每个用例 `mkdtempSync` 出独立目录、`createDatabase({ seed: true })`，结束后 `rmSync`，互不干扰。新增 service 测试请沿用这个模式。

## 编辑指引（项目特定）

- **强类型 + Zod**：API 入参用 `zod` schema 校验后再进 service；类型从 `types.ts` 集中导出，不要在路由里就地 `any`。
- **不可变资料/发布**：`sources` 与 `releases` 在产品语义上不可变。修改/重导入要走「新版本」而不是 update 现有行（`sourceImportService` 的幂等逻辑就是范例）。
- **旧 kb-builder 目录只读**：`scanLegacyKbBuilder` / `importLegacyAsDraftPackage` 必须保持「不修改源目录」的契约——新增逻辑前确认这一点。
- **Seed 数据**：演示数据通过 `users` 表为空判断是否注入，二次启动不会重复 seed。`seedDemoEvidence` 用 `ON CONFLICT DO NOTHING` 兜底。删改 demo 字段时要兼容已有 schema 或丢一个新 schema。
