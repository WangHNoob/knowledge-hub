# Knowledge Hub

> 把团队资料治理成 Agent 可消费、可追溯、可迭代的知识库。系统把原始资料编译为 LLM Wiki / OKF 知识包，通过 MCP 提供给 Agent，并把 Agent 反馈回流成自动治理与增量重建。

Knowledge Hub 是一个 TypeScript 全栈应用，面向游戏策划知识库管理。它不是简单的 RAG 文件夹，而是一条轻量知识飞轮：

```text
导入资料 → 预览变更 → 一键构建并发布 → Agent 通过 MCP 消费
   ↑                                             │
   └──── 标注 / Knowledge Lint / Agent 反馈自动回流 ────┘
```

当前默认项目名为 **航海王**。系统已支持多游戏项目，同一账号可切换不同项目；资料库、构建、资产、发布、MCP 审计、Agent 反馈、审核和治理记录按项目隔离。

---

## 核心能力

### 1. 资料库管理

- 上传 `knowledge/`、`gamedata/`、`gamedocs/` 等资料目录。
- 原始文件按内容哈希去重，源版本不可变。
- 资料版本支持文件树预览、文件内容摘要、变更统计和增量构建建议。
- 新增/修改/删除文件会生成 build plan，提示适合增量还是全量构建。

### 2. 知识资产构建

构建流水线：

```text
convert → extract → tables → graph → viz
```

- `extract` 阶段使用 AI SDK 6 兼容模型配置，支持 OpenAI-compatible / Anthropic / deterministic。
- 构建产出知识资产包、wiki 组件、表依赖、图谱、证据记录和可信度信息。
- 支持 scoped rebuild，单个组件修复时不必全量重建。
- 标注样例与确定性覆盖会在后续构建中注入，降低重复人工处理。

### 3. OKF 发布

发布会导出不可变 OKF bundle，供 Agent 消费：

```text
okf_bundle/
  index.md
  log.md
  wiki/
  graph/graph.json
  tables/schemas.json
  tables/aliases.json
  search/index.json
```

- 已发布版本不可变。
- current release 通过 release channel 指针切换。
- 支持 revision：局部重建可以基于父发布 patch 变化组件，避免覆盖完整发布包。
- MCP 默认读取当前项目的 current release。

### 4. Knowledge Lint 自动治理

发布后会生成统一健康检查报告，把以下问题合并成 Knowledge Lint：

- OKF 链接 / frontmatter / citation
- 证据覆盖
- graph
- trust score
- 表依赖
- MCP 未解析查询和 Agent 反馈

Lint issue 会进入可追踪治理队列：

- 可定位到组件的问题会自动触发 scoped rebuild。
- 构建成功后治理项标记为 `completed`。
- 构建失败后治理项标记为 `failed`，进入例外中心，可一键重试。
- 无法安全自动处理的项标记为 `needs_human`，进入审核中心。
- 自动发布会检查 Lint 治理状态；pending/running/failed/needs_human 未收敛时会给出明确跳过原因。

### 5. 轻量飞轮工作台

产品目标是让策划少看中间产物，只做必要的轻量管理：

- 首页展示当前项目状态、主动作和例外项。
- 资料变更后可以一键同步、构建、治理、发布。
- 审核中心只保留必须人工判断的任务。
- 构建页和审核中心都能看到 Knowledge Lint 自动治理链路。
- Agent 反馈会聚合成业务化问题簇，而不是裸 `cmp_pkg...` 技术 ID。

### 6. MCP / Agent 消费

已发布知识通过 MCP 暴露，只读 current release。

支持两种 MCP 入口：

- Streamable HTTP：`/mcp`
- stdio：`npm run mcp:stdio`

HTTP 示例：

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

多项目场景建议 Agent 工具参数显式传入：

```json
{
  "projectId": "project_xxx"
}
```

如果 Agent 不传 `projectId`，服务端会使用 token 用户的当前 / 默认项目。别人使用时通常不会主动说明游戏项目，因此接入自己的 Agent 时应在系统配置里固定默认 `projectId`，不要依赖用户自然语言说明。

---

## 设计原则

### 不可变 + 版本化

- 原始 blob 不可变。
- 资料版本不可变。
- 构建产物不可变。
- 发布快照不可变。

名称、备注等元数据可修改；内容变化必须产生新版本。

### 证据可追溯

知识组件通过 `evidence_records`、OKF Citations、source refs 与源版本关联。Agent 返回知识时可以携带来源和可信度摘要。

### 策略数据化

质量门禁、策划立法规则、表名翻译 / alias、可信度策略都作为可维护配置存在，而不是散落在代码里。

### 系统自动流转，人只处理不确定项

构建后不再默认制造大量人工审核任务。系统优先 AI 自审、自动治理、自动发布；只有无法安全判断、自动治理失败、阻断发布或 Agent 高频负反馈时才让人介入。

---

## 架构

```text
src/server/
  app.ts                         Fastify app，注册 API / MCP / tracing / automation
  db.ts                          PostgreSQL 幂等迁移与 seed
  routes/                        HTTP 路由层
  services/
    sourceBundleService.ts       资料库导入、预览、diff、build plan
    kbBuilderService.ts          构建流水线编排
    releaseService.ts            发布、revision、auto publish gate
    knowledgeQueryService.ts     MCP kb_* 工具实现
    lintRemediationService.ts    Knowledge Lint 治理队列与自动重试
    flywheelService.ts           轻量工作台聚合
    eventService.ts              事件总线 + knowledge_events
    okf/                         OKF 导出、搜索索引、Lint
    kbBuilder/                   convert / extract / tables / graph / viz

src/client/
  api/                           fetch 封装与类型
  pages/                         Sources / Builder / Assets / Review / Release / AgentFeedback
  components/                    通用 UI 与治理链路组件
```

后端分层遵循：

```text
Route → Service → DB adapter
```

路由不直接拼业务 SQL；新增读模型优先扩展对应 service。

---

## 数据模型概览

核心表：

```text
projects
users
source_bundles
source_bundle_versions
source_files
source_blobs
knowledge_build_runs
asset_packages
asset_components
evidence_records
review_tasks
annotation_examples
rule_dismissals
source_corrections
releases
release_channels
agent_events
mcp_audit
knowledge_events
knowledge_lint_remediations
quality_gate_profiles
knowledge_rule_profiles
table_aliases
```

多项目隔离边界是 `project_id`。新游戏项目拥有独立资料库、资产、构建、发布、反馈、审计与治理记录；账号和角色暂时是全局的。

---

## 快速开始

要求：

- Node.js 22+
- PostgreSQL
- npm

复制环境变量：

```bash
cp .env.example .env
```

至少配置：

```bash
KH_JWT_SECRET=...
DATABASE_URL=postgres://...
```

测试还需要：

```bash
KH_TEST_DATABASE_URL=postgres://...
```

启动本地数据库：

```bash
npm run db:up
```

安装依赖并启动：

```bash
npm install
npm run dev
```

前端开发模式：

```bash
npm run dev:web
```

生产构建：

```bash
npm run build
npm start
```

默认端口是 `4174`。

演示账号：

| 用户 | 密码 | 角色 |
|---|---|---|
| `admin` | `adminpw` | admin |
| `dev` | `devpw` | developer |
| `viewer` | `viewpw` | viewer |

---

## 常用命令

```bash
npm run dev          # 后端热重载
npm run dev:web      # Vite 前端，默认 5174，代理 /api
npm run build        # typecheck + vite build
npm start            # 生产模式启动
npm run typecheck    # TypeScript 检查
npm test             # Vitest
npm run mcp:stdio    # MCP stdio server
npm run okf:scan     # OKF 一致性扫描
npm run db:up        # docker compose 启 PostgreSQL
npm run db:down      # 停 PostgreSQL
npm run db:restore   # 恢复 seed 数据
```

关键测试示例：

```bash
npx vitest run tests/knowledge-lint.test.ts
npx vitest run tests/flywheel-governance.test.ts
npx vitest run tests/release-service.test.ts
```

---

## 部署注意事项

### 环境变量

生产必须配置：

```bash
KH_JWT_SECRET=...
DATABASE_URL=...
POSTGRES_PASSWORD=...
```

如果用 docker compose，`.env` 中的 `POSTGRES_PASSWORD` 不能缺失。

### 上传限制

云服务器上传大型资料包时，可能遇到：

- `request file too large`
- `reach parts limit`

需要同时检查：

- 应用侧 multipart 限制：`KH_UPLOAD_MAX_FILE_BYTES`、`KH_UPLOAD_MAX_FILES`、`KH_UPLOAD_MAX_FIELDS`、`KH_UPLOAD_MAX_PARTS`
- 反向代理限制：例如 Nginx `client_max_body_size`
- 上传包目录结构：服务端会识别 `knowledge/`、`gamedata/`、`gamedocs/`

### HTTP / HTTPS

如果服务器只通过 IP 暴露且没有 TLS 证书，MCP URL 使用 `http://<ip>:<port>/mcp`。只有配置了域名和证书时才使用 `https://`。

---

## 推荐使用流程

### 初次建立知识库

1. 创建或选择项目。
2. 上传资料目录。
3. 在资料库页面预览文件树和变更。
4. 点击一键构建并发布。
5. 在 MCP 连接页复制 Agent 配置。
6. 用 Agent 查询知识，观察来源和可信度。

### 日常资料更新

1. 策划上传新表或新文档。
2. 系统生成 build plan。
3. 优先走增量构建并发布。
4. Knowledge Lint 自动治理可定位问题。
5. Agent 反馈持续回流。
6. 只处理例外中心中确实需要人工判断的项。

---

## 权限

当前账号角色是全局角色：

- `admin`：发布、删除、配置、项目管理等高权限操作。
- `developer`：导入、构建、反馈处理等日常维护。
- `viewer`：只读查看，不能修改知识库。

第一版未做项目级成员权限；多项目先保证数据隔离。

---

## 许可

本项目为个人作品集与内部工具开发用途。
