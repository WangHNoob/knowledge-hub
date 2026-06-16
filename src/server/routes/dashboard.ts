import type { FastifyInstance } from "fastify";

import type { RouteContext } from "./context";

export function registerDashboardRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.get("/api/health", async () => ({ status: "ok" }));
  app.get("/api/dashboard", { preHandler: app.authenticate }, async () => ctx.service.getDashboardSummary());
}
