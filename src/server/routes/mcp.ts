import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { config } from "../config";
import { createKnowledgeMcpServer } from "../mcpTools";
import type { RouteContext } from "./context";

export function registerMcpRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.get("/api/mcp/connect", { preHandler: app.authenticate }, async (request) => {
    const baseUrl = config.publicBaseUrl.trim() || requestBaseUrl(request);
    const mcpUrl = `${baseUrl.replace(/\/+$/u, "")}/mcp`;
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
        "Use a developer or admin account token if the Agent needs to send feedback; viewer can query read-only tools but should not mutate the knowledge base.",
        "Behind a reverse proxy, set KH_PUBLIC_BASE_URL to the public https origin so generated configs are stable.",
      ],
    };
  });

  app.all("/mcp", { preHandler: app.authenticate }, async (request, reply) => {
    reply.hijack();

    const server = createKnowledgeMcpServer(ctx.queryService, {
      sessionId: `mcp-http:${request.user.username}`,
      agentRole: request.user.role,
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
