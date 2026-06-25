import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance } from "fastify";

import { createKnowledgeMcpServer } from "../mcpTools";
import type { RouteContext } from "./context";

export function registerMcpRoutes(app: FastifyInstance, ctx: RouteContext) {
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
