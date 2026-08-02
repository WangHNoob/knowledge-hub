# MCP 生产部署要点（Gateway / 限流 / OTel / stdio）

Knowledge Hub 的 Agent 入口是 Fastify `/mcp`（Streamable HTTP + JWT）。适合试点与单机；多 Agent 集群建议网关前置，而不是自研完整 MCP Gateway。

产品总览与本地联调见根目录 [README.md](../README.md) 与 [QUICKSTART.md](./QUICKSTART.md)。

## 推荐拓扑

```
Agent → TLS 终止 / API Gateway（鉴权、按 Agent 限流、访问日志）
      → Knowledge Hub :4174 /mcp（JWT 二次校验 + 进程内限流安全网）
```

- **鉴权**：继续用 `Authorization: Bearer <KH_JWT>`；网关可做 mTLS / OAuth 换票，但落到 KH 仍应是 JWT。
- **限流**：优先在网关按 `sub` / Agent 身份限流；应用内 `KH_MCP_RATE_LIMIT_MAX` / `KH_MCP_RATE_LIMIT_WINDOW_MS` 是单进程滑动窗口（默认 120/min），多实例时各自计数。
- **OTel**：HTTP 请求已有 `x-trace-id` + diagnostic spans（`registerTracing`）。可把网关 TraceID 透传到该头；后续若接 OTel Collector，复用同一 `traceId` 即可，不必先改 MCP 协议层。
- **stdio**：生产默认禁用或强制 `KH_MCP_STDIO_REQUIRE_TOKEN=true` + `KH_MCP_SERVICE_TOKEN`。集群场景优先 HTTP MCP。

## 多实例事件总线

单机默认 `KH_EVENT_BUS_MODE=inline`（写 `knowledge_events` 后进程内 `EventEmitter`）。

多实例请设：

```
KH_EVENT_BUS_MODE=outbox
KH_EVENT_OUTBOX_INTERVAL_MS=1000
```

事件同时写入 `knowledge_event_outbox`；各实例上的 worker 用 `FOR UPDATE SKIP LOCKED` 认领并本地投递，避免重复自动化。

## 多项目绑定

- HTTP MCP 默认 `projectId` = 登录用户 `currentProjectId`。
- Agent 侧应显式设置 `MCP_PROJECT_ID`（注入每个 `kb_*` 工具参数），禁止静默依赖 `default_project`。
- design-agent-ts 在 MCP 已加载 `kb_search` 时默认禁用本地 wiki/grep/kg，避免双源；可用 `MCP_DISABLE_LOCAL_KNOWLEDGE_WHEN_HEALTHY=false` 保留本地降级。

## 检索与 ACL（消费侧）

- `kb_search` 为词项 + dense RRF 混合检索；返回结构保持向后兼容。
- 组件 `quality.visibility` 在检索前按角色过滤（viewer ≈ public；developer/agent ≈ public+internal；admin 全可见）。
