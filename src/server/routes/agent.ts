import type { FastifyInstance } from "fastify";

import { createAttributionAuditSchema, mcpQuerySchema } from "../schemas";
import type { RouteContext } from "./context";

export function registerAgentRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.get("/api/agent/events", { preHandler: app.authenticate }, async () => ({
    events: await ctx.service.listAgentEvents("default_project")
  }));

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/agent/events", { preHandler: app.authenticate }, async (request) => ({
    events: await ctx.service.listAgentEvents(request.params.projectId)
  }));

  app.get("/api/agent/flywheel-events", { preHandler: app.authenticate }, async () => ({
    events: await ctx.service.listFlywheelEvents("default_project")
  }));

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/agent/flywheel-events", { preHandler: app.authenticate }, async (request) => ({
    events: await ctx.service.listFlywheelEvents(request.params.projectId)
  }));

  app.get("/api/agent/flywheel-convergence", { preHandler: app.authenticate }, async () => ({
    summary: await ctx.service.getFlywheelConvergenceSummary("default_project")
  }));

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/agent/flywheel-convergence", { preHandler: app.authenticate }, async (request) => ({
    summary: await ctx.service.getFlywheelConvergenceSummary(request.params.projectId)
  }));

  app.get("/api/mcp/audit", { preHandler: app.authenticate }, async () => ({
    audit: await ctx.service.listMcpAudit("default_project")
  }));

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/mcp/audit", { preHandler: app.authenticate }, async (request) => ({
    audit: await ctx.service.listMcpAudit(request.params.projectId)
  }));

  app.post("/api/mcp/query", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = mcpQuerySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid MCP query payload." });
    try {
      const user = await ctx.service.getUserByUsername(request.user.username);
      return {
        envelope: await ctx.queryService.runTool(parsed.data.toolName, parsed.data.payload, {
          sessionId: `web:${request.user.username}`,
          agentRole: request.user.role,
          projectId: user?.currentProjectId ?? "default_project",
          traceId: request.traceId
        })
      };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "MCP 查询失败。" });
    }
  });

  app.get("/api/agent/output-audits", { preHandler: app.authenticate }, async () => ({
    audits: await ctx.attributionAuditService.listAudits()
  }));

  app.post("/api/agent/output-audits", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = createAttributionAuditSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid attribution audit payload." });
    return {
      audit: await ctx.attributionAuditService.createAudit({
        ...parsed.data,
        createdBy: request.user.username
      })
    };
  });
}
