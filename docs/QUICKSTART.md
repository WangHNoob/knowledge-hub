# 本地快速开始与排障

面向第一次在本机跑通 Knowledge Hub 的同事。产品说明见根目录 [README.md](../README.md)。

## 1. 环境

- Node.js **22+**
- Docker Desktop（推荐）或已有 PostgreSQL
- npm

```bash
cp .env.example .env
```

必填：

```bash
KH_JWT_SECRET=change-me-to-a-long-random-string
DATABASE_URL=postgres://postgres:khpw@127.0.0.1:5432/knowledge_hub
```

跑测试另需：

```bash
KH_TEST_DATABASE_URL=postgres://postgres:khpw@127.0.0.1:5432/knowledge_hub_test
```

密码默认与 `docker-compose.yml` 一致（`khpw`）。

## 2. 启动数据库

```bash
npm run db:up
```

健康检查通过后：

```bash
npm install
npm run dev       # http://0.0.0.0:4174
npm run dev:web   # http://localhost:5174
```

浏览器打开前端；演示账号见 README。

## 3. Windows：5432 已被本机 PostgreSQL 占用

症状：`Password 认证失败`，但容器内 `psql` 正常。

原因：宿主机上另有 `postgres` 进程监听 5432，客户端连到了错误实例。

做法：

1. 创建 **不提交** 的覆盖文件 `docker-compose.override.yml`：

```yaml
services:
  postgres:
    ports: !override
      - "5544:5432"
```

2. 重启库并改 `.env` 端口：

```bash
npm run db:down
npm run db:up
```

```bash
DATABASE_URL=postgres://postgres:khpw@127.0.0.1:5544/knowledge_hub
KH_TEST_DATABASE_URL=postgres://postgres:khpw@127.0.0.1:5544/knowledge_hub_test
```

`docker-compose.override.yml` 已在 `.gitignore` 中，勿提交本机端口映射。

## 4. 测试

```bash
npm test
```

每个用例在 `KH_TEST_DATABASE_URL` 指向的库里建独立 schema，互不干扰。库不可达时 Vitest 会直接失败。

检索评测（不替代单元测试）：

```bash
npm run eval:retrieval
```

## 5. MCP 联调

1. 用 admin 登录 Web，打开 MCP 连接页复制 JWT / URL。
2. Agent（如 design-agent-ts）设置：
   - `MCP_ENABLED=true`
   - `MCP_SERVERS` 指向 `http://127.0.0.1:4174/mcp`
   - **`MCP_PROJECT_ID`** 显式项目 ID（多项目必填）
3. 不要设置 `toolPrefix: "kb_"`（工具名本身已是 `kb_*`）。

生产注意项见 [mcp-production.md](./mcp-production.md)。

## 6. 常见问题

| 现象 | 处理 |
|------|------|
| `缺少环境变量 KH_JWT_SECRET` | 检查 `.env` 是否被加载、是否在项目根目录启动 |
| Docker API / pipe 找不到 | 先启动 Docker Desktop |
| 前端能开但 API 401 | 重新登录；确认 Vite 代理到 4174 |
| 上传失败 parts / file too large | 调 `KH_UPLOAD_MAX_*` 与反向代理 body 限制 |
