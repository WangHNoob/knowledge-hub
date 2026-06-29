# Knowledge Hub

> 把"资料"治理成 Agent 可信赖的知识资产：经资产化、证据补全、质量门禁、不可变发布后供 Agent 消费，并把 Agent 的反馈回流成驱动知识自我迭代的飞轮。

Knowledge Hub 是一个 TypeScript 全栈应用。它要解决的不是"把文档喂给大模型"这件事本身——那很容易；它解决的是**当知识要被 Agent 长期、反复、可追责地使用时，如何保证它可信、可维护、可演进**。

---

## 一、设计出发点

直接把原始文档塞进 RAG 或上下文，会遇到三个本质问题：

1. **不可信**——产出无法追溯到来源，错误无法定位，更无法问责"这句话是从哪份资料、哪个版本来的"。
2. **不可维护**——资料一改，下游产物、发布、Agent 看到的内容如何同步？谁来把关质量？规则散落在人脑里。
3. **不可演进**——Agent 用错了、查不到，这些信号若只停留在日志里，知识永远不会因为"被使用"而变得更好。

Knowledge Hub 的回答是：**把知识当作软件工程的产物来治理**——像对待代码一样,给它版本、证据、门禁、不可变发布、以及一条由反馈驱动的 CI 式进化流水线。

---

## 二、核心设计原则

整个系统围绕六条原则构建，它们也是阅读代码时的主线。

### 1. 不可变 + 版本化（Immutability）

源内容、构建产物、发布快照一律**不可变**：
- 原始文件按 `content_hash` 去重存为不可变 blob；重导入走"新版本"而非就地修改，版本之间用 `parent_version_id` 串成链。
- 一次构建 = 一个**新的**资产包 + 一批**新的**组件，绝不回写旧 run 的产物。
- 发布时冻结 `manifest_hash` 快照，已发布版本永不变更；回滚只是移动 release channel 指针。

> 可变的只有"元数据"（名称、备注）。**内容的每一次改变都对应一个新版本**——这让任何产出都能精确回溯。

### 2. 证据可追溯（Provenance）

每个知识组件（如一个 wiki 页面）都通过 `evidence_records` 关联到它所依据的**源版本**。覆盖率、引用关系可按组件统计——产出与来源之间始终有一条可审计的链路。

### 3. 机制与策略分离（Policy as Data）

"知识应该长什么样"是**策略**，不应硬编码在流水线里：
- **质量门禁 Profile**：以数据（JSONB）形式定义质量红线，构建时据此评分、衍生审核任务。
- **策划立法规则 Profile**：把页面类型、实体类型、关系类型、必填章节等"领域宪法"沉淀为可版本化的 Profile，而非散落的代码逻辑。

构建引擎只负责执行；规则随 Profile 演进，互不绑死。

### 4. 发布快照只读消费（Read-only Published Snapshots）

Agent **只能**看到"当前发布版本"的冻结快照，看不到草稿、半成品或构建中间态。消费面（MCP `kb_*` 工具）与治理面彻底解耦——治理可以随便迭代，Agent 看到的始终是一个一致、稳定、可问责的版本。

### 5. 反馈驱动的进化飞轮（Annotation Flywheel）

这是项目最核心的思路：**把"人等系统审批"的工单模型，翻转为"系统自动流转、只在不确定处等人标注"的流水线**。

- 人的每一次判断（标注）都沉淀为可复用的样例，而非一次性操作。
- Agent 的反馈（查不到、查错了）自动回流成待处理任务，而非沉在日志里。
- 同类问题不该反复出现——标注过的，下次构建就该按标注的来。

### 6. 事件驱动 + 增量（Event-driven & Incremental）

进程内事件总线 + `knowledge_events` 表，让"构建完成""收到反馈""可信度变化"等关键节点既可被订阅、又可追溯。配合 extract 缓存、source diff、scoped rebuild，**改一个组件不必重跑全量**，降低 LLM 成本与等待。

---

## 三、知识进化飞轮

```
  资料库版本              知识构建流水线                  审核 / 标注
 (不可变 blob)   ──▶  convert→extract→tables       ──▶  质量门禁衍生任务
      ▲                  →graph→viz                      人工标注沉淀样例
      │                      │                                │
      │                      ▼                                ▼
   重新导入            资产包 + 组件 + 证据              不可变发布 (冻结 manifest)
   (新版本)                                                   │
      │                                                       ▼
      │            scoped rebuild  ◀── 反馈自动回流 ◀──  Agent 通过 MCP 消费
      └──────────  revision 草案  ──▶  资格检查 ──▶  自动发布   (kb_* 只读工具)
                   (parent_release 版本链)                     │
                                                          反馈 (命中/未命中)
```

闭环的每一环都遵循上面的原则：源不可变、产出带证据、门禁把关、发布冻结、消费只读、反馈回流触发增量重建并生成新的 revision，可配置地自动发布。

---

## 四、架构骨架

前后端同仓，Fastify 同时承担 JSON API 与构建后 SPA 的静态托管；另有独立的 MCP stdio 服务器。

```
src/server/                          后端：薄分层「路由 → Service → DB」
  app.ts          构造 service 注入 RouteContext，挂 JWT/CORS/multipart、全链路 tracing
  routes/         每个子域一个 registerXxxRoutes，不在路由里拼 SQL
  services/       业务层：构建流水线、发布、OKF 导出、立法、归因审计、诊断…
    kbBuilder/    流水线各阶段（convert/extract/tables/graph/viz/qualityGate）
    okf/          Open Knowledge Format 导出与一致性校验
  db.ts           建池 + 幂等迁移（CREATE/ALTER IF NOT EXISTS）+ seed
  mcpStdio.ts     独立 MCP stdio 服务器，复用同一份 kb_* 实现

src/client/                          前端：React 19 + React Query SPA
  api/            按子域拆分的 fetch 封装 + 类型，组件不直接 fetch
  pages/          Sources / Assets / Review / Release / AgentFeedback / Diagnostics …
```

**几个刻意的工程约束**（详见 `CLAUDE.md`）：
- 强类型 + Zod：API 入参先经 zod schema 校验再进 service。
- 行映射集中在 `db/mappers.ts`：snake_case 列 → camelCase 领域对象，统一处理 JSONB。
- 迁移幂等：全部 `IF NOT EXISTS`，加列只追加 ALTER，二次启动不破坏既有库。
- 可观测：每个请求挂 traceId/span，service 写入起子 span，结构化日志可按 trace 回看。

---

## 五、消费面：MCP / Agent 接入

已发布知识通过 `KnowledgeQueryService` 暴露的 `kb_*` 只读工具供 Agent 消费，两条入口共用同一份实现：

- **Streamable HTTP**：`POST /mcp`（JWT 保护，与 Web API 同一权限边界，写 MCP 审计）。
- **stdio**：`npm run mcp:stdio`（标准 MCP 协议，本机/开发场景）。

工具只读"当前发布版本"的冻结快照，不读草稿。

```json
{
  "name": "knowledge-hub",
  "transport": "http",
  "url": "http://127.0.0.1:4174/mcp",
  "headers": { "Authorization": "Bearer <login-token>" }
}
```

---

## 六、技术栈

| 层 | 选型 |
|---|---|
| API | Fastify（JWT / CORS / multipart）+ 全链路 tracing |
| 前端 | React 19 + Vite + React Query |
| 存储 | PostgreSQL（`pg`，Node 22+），JSONB 承载半结构化产物 |
| 校验 | Zod（所有 API 入参） |
| Agent 接入 | MCP（Streamable HTTP `/mcp` + stdio），`kb_*` 工具 |
| 测试 | Vitest（每用例建独立 schema，连真实 PostgreSQL 实现隔离） |

---

## 七、快速开始

需要 Node 22+ 和一个可连的 PostgreSQL。把 `.env.example` 复制为 `.env`，至少配置 `KH_JWT_SECRET` 与 `DATABASE_URL`（测试还需 `KH_TEST_DATABASE_URL`）。

```bash
npm install
npm run db:up        # 用自带 docker-compose 起 PostgreSQL（也可自备 PG）
npm run db:restore   # 恢复随仓库分发的全库种子数据（可选）
npm run build
npm start            # 监听 4174
```

打开 `http://127.0.0.1:4174`。首次启动会迁移 schema 并 seed 演示用户、默认资料集、默认质量门禁 Profile 与默认策划立法规则 Profile。

| 用户 | 密码 | 角色 |
|---|---|---|
| `admin` | `adminpw` | admin |
| `dev` | `devpw` | developer |
| `viewer` | `viewpw` | viewer |

更细的本地/部署流程见 [docs/QUICKSTART.md](docs/QUICKSTART.md) 与 [docs/DEPLOY-DOCKER.md](docs/DEPLOY-DOCKER.md)。

---

## 八、领域模型：用户语言 vs 内部标识

产品面向用户用一套业务语言，内部标识符对 admin / 主开发者仍可见——刻意保留这套**双层命名**，让"好理解"与"可精确定位"并存。

```
资料库 → 知识资产包 → 资产组件 → 审核任务 → 发布版本 → Agent 反馈
  │          │           │          │           │
sourceVersionId  packageId  componentId  artifactId  releaseId
```

---

## 九、深入阅读

- [docs/architecture-v2-roadmap.md](docs/architecture-v2-roadmap.md) — 从工单模型到标注流水线的演进路线与落地状态
- [docs/标注结果回写设计：从软提示到确定性覆盖.md](docs/标注结果回写设计：从软提示到确定性覆盖.md) — 标注如何确定性回写知识内容的设计
- [docs/知识库体系设计：可信性、可维护性与结构性保证.md](docs/知识库体系设计：可信性、可维护性与结构性保证.md) — 治理哲学与三层保证
- [docs/知识库立法机制：策划治理与Agent反馈闭环.md](docs/知识库立法机制：策划治理与Agent反馈闭环.md) — 策略即数据的立法机制
- [docs/OKF开发文档.md](docs/OKF开发文档.md) — Open Knowledge Format 导出规格
- `CLAUDE.md` — 面向贡献者的架构与编辑约定

---

## 许可

本项目为个人作品集展示用途。
