import type { FastifyInstance } from "fastify";

import type { RouteContext } from "./context";

export function registerDashboardRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.get("/api/health", async () => ({ status: "ok" }));
  app.get("/api/dashboard", { preHandler: app.authenticate }, async () => ctx.service.getDashboardSummary());
  app.get("/api/dashboard/workbench", { preHandler: app.authenticate }, async () => ctx.service.getFlywheelWorkbench({
    runs: await ctx.kbBuilderService.listRuns(),
  }));
}
