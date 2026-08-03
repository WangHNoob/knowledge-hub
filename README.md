# Knowledge Hub

> 把团队资料治理成 **Agent 可消费、可追溯、可迭代** 的知识库。  
> 不是又一个纯向量 RAG，而是「资料 → 资产化 → 证据/可信度 → 发布冻结 → MCP 消费 → 反馈回流 → 修订发布」的治理型知识运营系统。

[![Node](https://img.shields.io/badge/node-%3E%3D22-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-18-336791.svg)](https://www.postgresql.org/)
[![License](https://img.shields.io/badge/license-personal%2Finternal-lightgrey.svg)](#许可)

Knowledge Hub 是 TypeScript 全栈应用（Fastify + React），面向游戏 / 设计域知识资产治理。同一账号可切换多项目；资料、构建、发布、MCP、反馈与治理记录按 `project_id` 隔离。

```text
导入资料 → 构建流水线 → OKF 发布冻结 → Agent 经 MCP (kb_*) 消费
   ↑                                              │
   └── 标注 / Lint·别名自愈 / 反馈晋升 / 健康巡检 ───┘
```

配套 Agent：[design-agent-ts](https://github.com/WangHNoob/design-agent-ts)（默认走 MCP；MCP 健康时建议禁用本地 wiki 双源）。

---

## 目录

- [核心能力](#核心能力)
- [快速开始](#快速开始)
- [常用命令](#常用命令)
- [MCP 接入](#mcp-接入)
- [并发与事务安全](#并发与事务安全)
- [策划可用模式（可选分支）](#策划可用模式可选分支)
- [设计原则](#设计原则)
- [架构](#架构)
- [部署与运维](#部署与运维)
- [推荐流程](#推荐流程)
- [权限](#权限)
- [许可](#许可)

更细的本地排障见 [docs/QUICKSTART.md](docs/QUICKSTART.md)；生产 MCP / 多实例见 [docs/mcp-production.md](docs/mcp-production.md)。

---

## 核心能力

### 1. 资料库（不可变版本链）

- 目录导入约定：**必须**能识别 `gamedata/` 与 `gamedocs/`（文档若在「系统策划文档」等其它目录名下，可用目录联接映射到 `gamedocs`，无需搬迁原盘）。
- 内容哈希（`source_blobs`）去重；源版本不可变。
- 版本预览：文件树、摘要、diff、增量构建建议。
- **上传即流转**（`KH_AUTO_BUILD_ON_UPLOAD`，可关）：相对上一版本有变更时自动进入飞轮 sync；无变更（`changedFileCount=0`）可跳过空转。

### 2. 知识构建流水线

用户可见阶段：

```text
convert → extract → tables → graph → viz
```

之后还有内部阶段 **`persist`**（写入 asset package / 组件 / quality 等），不在用户可选 `PipelineStage` 枚举里，但构建失败日志里常出现。

- `extract` 支持 OpenAI-compatible / Anthropic / deterministic。
- 产出资产包、wiki / 表 / 图谱组件、证据与 trust。
- **Scoped rebuild**：单组件修复不必全量重建；发布时必须带 `parentReleaseId`，按 **revision** 继承父 bundle 未变更 markdown——禁止把残缺局部包当成完整新 release 覆盖 channel。
- **例外**：`table_dependencies` 等解析层问题需 **full rebuild**（scoped 修不了）。

### 3. OKF 发布（不可变快照）

发布导出冻结 OKF bundle（含 `search/index.json` 与稠密检索用的 `search/dense.json`）：

```text
okf_bundle/
  index.md · log.md · wiki/ · graph/ · tables/ · search/
```

- Release channel 指向 current release；revision 继承父发布只 patch 变更组件。
- 自动发布门禁读取**项目治理 Profile**（删除 / trust 下降 / 待审纠正 / 最低分等）。

### 4. 检索与权限

- **混合检索**：词项索引 + hashing dense 向量，RRF 融合后供 `kb_search`（结果带 `retrieval.mode`）。
- **检索时 ACL**：按组件 `quality.visibility`（public / internal / restricted）与 Agent 角色过滤，而非事后裁剪。
- 离线评测：`npm run eval:retrieval`（黄金集 hit@k，见 `evals/`）。

### 5. Knowledge Lint 与自愈合

- 链接 / 证据 / 图谱 / trust / 表依赖 / MCP 反馈等统一进治理队列。
- 可定位问题 → scoped rebuild；表名悬空边 → LLM 别名映射到真实 canonical 后全量 sync（有收敛保证）。
- 部分 lint 入队在 **publish 事务路径内同步写入**（避免异步写入打穿连接/事务边界）；新加异步订阅时需复测事务边界。
- 高频负反馈簇可 **晋升** 为 rebuild 候选；健康巡检覆盖「过期未复审」等时间型问题。

### 6. 轻量知识运营台（飞轮）

- 一句话状态 + 一个主动作 + 例外中心（可软忽略、可恢复）。
- 新鲜度 SLA 与无证据归因审计可进入例外。
- 纠正 / 别名写入前做冲突检测，避免多 Agent 互相覆盖。

### 7. MCP / Agent 消费面

| 入口 | 说明 |
|------|------|
| Streamable HTTP `/mcp` | JWT 保护；进程内按用户限流 |
| `npm run mcp:stdio` | 本地联调；生产建议强制 service token（`KH_MCP_STDIO_REQUIRE_TOKEN`） |

工具面覆盖查询、证据/trust、反馈、纠正、飞轮状态、归因提交、反馈簇、健康检查等（约 30+ `kb_*`）。

**硬边界（产品决策，非细节）**：不能直接改 published OKF bundle、不能随意切 channel；写路径走 staged correction。管理员侧另有门禁受控的 `kb_rollback_release`（渠道回点），不等于开放「直接改真理」。

---

## 快速开始

**要求**：Node.js 22+（README/惯例要求；`package.json` 暂未写 `engines` 字段）、Docker（推荐）或自备 PostgreSQL、npm。

```bash
cp .env.example .env
# 必填：KH_JWT_SECRET、DATABASE_URL
# 跑测试另需：KH_TEST_DATABASE_URL

npm run db:up          # docker compose 起 PostgreSQL（默认主机 5432）
npm install
npm run dev            # 后端 http://0.0.0.0:4174
npm run dev:web        # 前端 http://localhost:5174 （/api → 4174）
```

生产一体：

```bash
npm run build && npm start
```

### 演示账号

| 用户 | 密码 | 角色 |
|------|------|------|
| `admin` | `adminpw` | admin |
| `dev` | `devpw` | developer |
| `viewer` | `viewpw` | viewer |

### Windows 端口占用

若本机已有 PostgreSQL 占用 **5432**，可建本地覆盖（已 gitignore）：

```yaml
# docker-compose.override.yml
services:
  postgres:
    ports: !override
      - "5544:5432"
```

并将 `.env` 中 `DATABASE_URL` / `KH_TEST_DATABASE_URL` 主机端口改为 `5544`。详见 [docs/QUICKSTART.md](docs/QUICKSTART.md)。

---

## 常用命令

```bash
npm run dev              # 后端热重载（tsx watch）
npm run dev:web          # Vite 前端
npm run build            # tsc + vite → dist/client
npm start                # 生产入口（托管 API + SPA）
npm run typecheck
npm test                 # Vitest（真实 PostgreSQL + 每用例独立 schema）
npm run eval:retrieval   # 检索黄金集离线评测
npm run mcp:stdio
npm run okf:scan
npm run db:up | db:down | db:restore
```

单测示例：

```bash
npx vitest run tests/release-service.test.ts
npx vitest run tests/db-adapter-transaction.test.ts
npx vitest run -t "honors governance"
```

---

## MCP 接入

HTTP（推荐）：

```json
{
  "name": "knowledge-hub",
  "transport": "http",
  "url": "http://127.0.0.1:4174/mcp",
  "headers": {
    "Authorization": "Bearer <login-token>"
  }
}
```

Web 端「MCP 连接」页可复制完整配置。多项目时：

- Agent 侧设置 **`MCP_PROJECT_ID`**（注入每个 `kb_*` 参数），不要静默依赖 `default_project`。
- 或不传 `projectId` 时使用 JWT 用户的 `currentProjectId`。

与 design-agent-ts 联调要点：`MCP_ENABLED=true`、勿给已是 `kb_*` 的工具再加 `toolPrefix: "kb_"`、MCP 健康时默认禁用本地 wiki 双源。生产网关 / 限流 / outbox 见 [docs/mcp-production.md](docs/mcp-production.md)。

---

## 并发与事务安全

Node + `pg` 连接池下，**禁止**把「当前事务连接」挂在 adapter 实例字段上——并发 `BEGIN` 会互相覆盖，典型症状是父子表不在同一事务导致外键失败（如 `asset_components_package_id_fkey`）。

当前实现（`src/server/db-adapter.ts`）：

- **`transaction(fn)` + `AsyncLocalStorage`**：把 `PoolClient` 绑到当前异步调用链。
- **禁止**经 `query("BEGIN"|"COMMIT"|"ROLLBACK")` 手工跨 await 管事务。
- **嵌套事务未支持**（需禁止嵌套或后续上 savepoint）。

飞轮并发构建另两层防护：

1. **逻辑去重**：同项目同 `source_version_id` 已有 running 飞轮构建则复用（`findRunningFlywheelBuild`）。
2. **DB 部分唯一索引**：`idx_build_runs_one_running_flywheel`（`status='running'` 且非 scoped）；竞态插入冲突时捕获并复用。

产品侧注意：导入 `autoSync=true` **同时**订阅 `source.version_imported` 再 sync，会双触发——去重是兜底，编排重复触发才是根因。回归测例：`tests/db-adapter-transaction.test.ts`。

---

## 策划可用模式（可选分支）

面向内网策划试点的瘦身能力在分支 **`feat/planner-usable-slim`**（含上述事务隔离修复）。主线/其它分支未必包含下列开关：

| 能力 | 说明 |
|------|------|
| `KH_UI_MODE=simple` | 工作台简化导航；admin 可切回完整飞轮台 |
| `KH_PUBLISH_RELAXED` | 降低自动发布门槛（试点求通；可回退） |
| SVN 同步 | `POST /api/ops/svn-sync` + `npm run ops:svn-sync` / `scripts/svn-sync-ingest.mjs` |
| remediation 默认关 | 减少自动 LLM 自愈噪声 |

运维说明见该分支上的 [docs/planner-ops.md](docs/planner-ops.md)。导入目录仍须满足 `gamedata/` + `gamedocs/` 约定。

---

## 设计原则

| 原则 | 含义 |
|------|------|
| 不可变 + 版本化 | blob / 资料版本 / 发布快照不可变；改内容必须新版本 |
| 证据可追溯 | evidence、Citations、source refs；MCP 结果可带 trust / trace |
| 策略数据化 | 质量门禁、立法规则、治理 Profile、别名表可配置 |
| 人只处理不确定项 | 自动构建 / 治理 / 发布；例外与晋升才进人工 |
| fail loud | 门禁 skip、构建失败、例外箱必须带 reason；禁止静默当成功 |

---

## 架构

```text
src/server/
  index.ts · app.ts · mcpStdio.ts · mcpTools.ts
  config.ts · db.ts · db-adapter.ts · schemas.ts · types.ts
  routes/          # HTTP（含 /mcp）
  services/        # 业务：资料 / 构建 / 发布 / 飞轮 / 反馈 / Lint / 事件…
    okf/           # 导出、词项+dense 检索、Lint
    kbBuilder/     # 流水线（用户五阶段 + 内部 persist）
  middleware/

src/client/src/    # React 19 + React Query SPA
tests/             # Vitest + app.inject + schema 隔离
evals/             # 检索黄金集
```

分层：`Route → Service → DB adapter`。

事件：导入写路径与副作用解耦——版本落库后广播 `source.version_imported`，是否构建由自动化订阅者决定。单实例可用 `KH_EVENT_BUS_MODE=inline`；多实例切 `outbox`（`knowledge_event_outbox` + `FOR UPDATE SKIP LOCKED`）。

其它锁手段：顾问锁 `pg_advisory_xact_lock`（如 release revision 提案防重复草案）；任务认领可用 `SKIP LOCKED`。

核心表见迁移 `db.ts`：`projects`、`source_*`、`asset_*`、`releases`、`knowledge_events` / `knowledge_event_outbox`、`knowledge_lint_remediations`、`exception_dismissals`、`table_aliases`、`attribution_audits` 等。

---

## 部署与运维

生产必填：`KH_JWT_SECRET`、`DATABASE_URL`；compose 场景注意 `POSTGRES_PASSWORD`。

常用可选：

| 变量 | 作用 |
|------|------|
| `KH_PUBLIC_BASE_URL` | 公网 MCP 配置基址 |
| `KH_AUTO_BUILD_ON_UPLOAD` | 上传即构建 |
| `KH_AUTO_PUBLISH_REVISIONS` | 反馈/修订自动发布（可被 Profile 覆盖） |
| `KH_MCP_RATE_LIMIT_MAX` | `/mcp` 进程内限流 |
| `KH_MCP_STDIO_REQUIRE_TOKEN` | 生产 stdio 强制令牌 |
| `KH_EVENT_BUS_MODE` | `inline` \| `outbox` |
| `KH_LLM_REQUEST_TIMEOUT_MS` | 构建用 LLM 请求超时（防无限挂起） |
| `KH_UPLOAD_MAX_*` | 大包上传上限（需同步调反向代理） |

上传大包时同时检查应用 multipart 与 Nginx `client_max_body_size`。无 TLS 时 MCP 使用 `http://`。

---

## 推荐流程

**首建**：建项目 → 放入/联接 `gamedata`+`gamedocs` → 导入版本 → 一键同步发布 → 复制 MCP 配置 → Agent 查询并看证据 / trust。

**日常**：上传或 SVN 同步变更 → 自动流转；Lint / 别名自愈；单组件「重建并发布修订」（带 `parentReleaseId`）；只处理例外中心；反馈簇可晋升重建。

**联调 Agent**：Hub 有 published release + channel → Agent `MCP_SERVERS`/`MCP_PROJECT_ID`/JWT 正确 → 抽检 Hub 搜索与 `kb_search` 同主题命中 → 关闭本地 wiki 双源。

---

## 权限

全局角色（第一版未做项目级成员）：

- **admin**：发布、删除、治理 Profile、渠道回点等
- **developer**：导入、构建、日常维护
- **viewer**：只读

MCP 检索可见性另受组件 `visibility` 约束。

---

## 许可

本项目为个人作品集与内部工具开发用途。
