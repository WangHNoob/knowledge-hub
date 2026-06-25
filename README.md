# Knowledge Hub

TypeScript 全栈知识资产中枢，用于团队协作式的知识治理。

## 技术栈

- Fastify API（JWT / CORS / multipart）
- React 19 + Vite SPA + React Query
- PostgreSQL，经 `pg` 连接（Node 22+）
- MCP 服务器（Streamable HTTP `/mcp`、兼容调试 API `/api/mcp/query` 与 stdio），对当前发布版本暴露 `kb_*` 工具
- Vitest 测试

## 首次启动

需要 Node 22+ 和一个可连的 PostgreSQL。把 `.env.example` 复制为 `.env`，至少配置
`KH_JWT_SECRET` 和 `DATABASE_URL`（运行测试还需 `KH_TEST_DATABASE_URL`）。

> **同事通过 SVN 拉取的**：仓库已自带原始资料与数据库种子，无需重新上传/导入。
> 直接看 [docs/QUICKSTART.md](docs/QUICKSTART.md)：`npm run db:up && npm run db:restore && npm run build && npm start`。

```bash
npm install
npm run db:up        # 用自带 docker-compose 起 PostgreSQL（也可自备 PG）
npm run db:restore   # 恢复随仓库分发的全库种子数据
npm run build
npm start
```

首次启动会迁移 schema 并 seed 演示用户、默认资料集、默认质量门禁 Profile 和默认策划立法规则 Profile。

打开：

```text
http://127.0.0.1:4174
```

演示用户：

| 用户 | 密码 | 角色 |
|---|---|---|
| `admin` | `adminpw` | admin |
| `dev` | `devpw` | developer |
| `viewer` | `viewpw` | viewer |

## 领域模型

产品语言面向用户：

```text
资料库 -> 知识资产包 -> 资产组件 -> 审核任务 -> 发布版本 -> Agent 反馈
```

内部标识符对管理员和主开发者仍然可见：

- `sourceVersionId`
- `packageId`
- `componentId`
- `artifactId`
- `releaseId`

## 当前能力

- 演示用户登录；基于角色的写权限网关（admin / developer / viewer）。
- 资料导入（Web 上传或服务器路径），内容哈希去重、不可变 blob、幂等版本化资料集。
- 资料集、资料集版本、知识资产包、发布版本均支持自定义名称与备注。
- 知识构建流水线（`convert → extract → tables → graph → viz`）产出资产包、组件和证据，由可配置的质量门禁 Profile 与策划立法规则 Profile 把关。
- 旧 `kb-builder` 目录扫描 + 扫描转资产包导入，保持原文件不变。
- 按资产组件统计的证据记录与覆盖率。
- 由质量发现衍生的审核任务（blocking / warning / info）。
- 发布流程：冻结 manifest hash 并导出 OKF bundle；通过 release channel 回滚。
- MCP `kb_*` 工具（Streamable HTTP 与 stdio）服务当前发布版本，附带 MCP 审计与 Agent 反馈跟踪。

## Agent / MCP 接入

标准 MCP 客户端优先使用 Streamable HTTP：

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

`/mcp` 使用与 Web API 相同的 JWT 权限边界；先调用 `/api/auth/login` 获取 token。仅本机或开发场景也可以继续使用 `npm run mcp:stdio`。
- 结构化诊断，按请求记录 trace/span。

## 后续里程碑

1. 面向管理员账号的多用户管理界面。
2. 扩充 `kb_*` 工具覆盖面，丰富 Agent 反馈闭环。
