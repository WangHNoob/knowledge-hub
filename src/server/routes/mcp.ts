import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { config } from "../config";
import { createKnowledgeMcpServer } from "../mcpTools";
import { checkMcpRateLimit } from "../services/mcpRateLimit";
import type { RouteContext } from "./context";

export function registerMcpRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.get("/api/mcp/connect", { preHandler: app.authenticate }, async (request) => {
    const baseUrl = config.publicBaseUrl.trim() || requestBaseUrl(request);
    const mcpUrl = `${baseUrl.replace(/\/+$/u, "")}/mcp`;
    const user = await ctx.service.getUserByUsername(request.user.username);
    const currentProjectId = user?.currentProjectId ?? "default_project";
    return {
      transport: "streamable_http",
      url: mcpUrl,
      auth: {
        type: "bearer",
        header: "Authorization",
        valueTemplate: "Bearer <KH_JWT_TOKEN>",
      },
      currentUser: {
        username: request.user.username,
        role: request.user.role,
        currentProjectId,
      },
      project: {
        projectId: currentProjectId,
        defaultToolPayload: { projectId: currentProjectId },
      },
      rateLimit: {
        max: config.mcpRateLimitMax,
        windowMs: config.mcpRateLimitWindowMs,
      },
      capabilities: {
        unified: [
          "query published knowledge",
          "read evidence/trust",
          "report feedback",
          "submit and apply staged corrections",
          "start scoped incremental checks",
          "ask the server to publish if gates pass",
        ],
        hardBoundaries: [
          "cannot directly update/delete published releases",
          "cannot directly rewrite OKF bundles",
          "cannot directly switch release channels",
        ],
      },
      examples: {
        generic: {
          mcpServers: {
            "knowledge-hub": {
              url: mcpUrl,
              headers: {
                Authorization: "Bearer <KH_JWT_TOKEN>",
              },
            },
          },
        },
        stdioLocal: {
          mcpServers: {
            "knowledge-hub-local": {
              command: "npm",
              args: ["run", "mcp:stdio"],
              cwd: process.cwd().replace(/\\/gu, "/"),
            },
          },
        },
      },
      notes: [
        "Streamable HTTP endpoint is /mcp and requires the same JWT used by this web app.",
        "For multi-game knowledge bases, pass projectId in each tool payload or switch the current project in the web app before connecting. Agents should set MCP_PROJECT_ID explicitly — do not rely on silent default.",
        "MCP uses unified Agent capabilities. Safety is enforced by staged corrections, immutable release snapshots, server-side publish gates, and audit logs.",
        "MCP governance tools modify staged correction state and trigger server gates only; they never rewrite published OKF bundles or release channels directly.",
        "Behind a reverse proxy, set KH_PUBLIC_BASE_URL to the public https origin so generated configs are stable.",
        "Production: terminate TLS and optionally rate-limit at the API gateway; app-level KH_MCP_RATE_LIMIT_* is a per-process safety net. Prefer HTTP JWT over production stdio (see docs/mcp-production.md).",
      ],
    };
  });

  app.all("/mcp", { preHandler: app.authenticate }, async (request, reply) => {
    const limit = checkMcpRateLimit(`mcp:${request.user.username}:${request.user.role}`, {
      maxRequests: config.mcpRateLimitMax,
      windowMs: config.mcpRateLimitWindowMs,
    });
    if (!limit.allowed) {
      return reply.code(429).send({
        error: "MCP rate limit exceeded",
        retryAfterMs: limit.retryAfterMs,
      });
    }

    reply.hijack();

    const user = await ctx.service.getUserByUsername(request.user.username);
    const server = createKnowledgeMcpServer(ctx.queryService, {
      sessionId: `mcp-http:${request.user.username}`,
      agentRole: request.user.role,
      projectId: user?.currentProjectId ?? "default_project",
      traceId: request.traceId,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    const close = async () => {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    };
    reply.raw.on("close", () => {
      void close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
      await request.diagnosticSpan?.complete({
        statusCode: reply.raw.statusCode,
        user: request.user.username,
        role: request.user.role,
      });
    } catch (error) {
      await request.diagnosticSpan?.fail(error, {
        statusCode: reply.raw.statusCode >= 400 ? reply.raw.statusCode : 500,
        user: request.user.username,
        role: request.user.role,
      });
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
      }
      if (!reply.raw.writableEnded) {
        reply.raw.end(JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "MCP Streamable HTTP request failed.",
          },
          id: null,
        }));
      }
    }
  });
}

function requestBaseUrl(request: FastifyRequest): string {
  const forwardedProto = firstHeader(request.headers["x-forwarded-proto"]);
  const forwardedHost = firstHeader(request.headers["x-forwarded-host"]);
  const host = forwardedHost || firstHeader(request.headers.host) || "127.0.0.1";
  const proto = forwardedProto || (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

function firstHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
