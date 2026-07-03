import type { FastifyInstance } from "fastify";

import type { RouteContext } from "./context";

export function registerDashboardRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.get("/api/health", async () => ({ status: "ok" }));
  app.get("/api/dashboard", { preHandler: app.authenticate }, async () => ctx.service.getDashboardSummary("default_project"));
  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/dashboard", { preHandler: app.authenticate }, async (request) => ctx.service.getDashboardSummary(request.params.projectId));
  app.get("/api/dashboard/workbench", { preHandler: app.authenticate }, async () => ctx.service.getFlywheelWorkbench({
    projectId: "default_project",
    runs: await ctx.kbBuilderService.listRuns("default_project"),
  }));
  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/dashboard/workbench", { preHandler: app.authenticate }, async (request) => ctx.service.getFlywheelWorkbench({
    projectId: request.params.projectId,
    runs: await ctx.kbBuilderService.listRuns(request.params.projectId),
  }));
}
