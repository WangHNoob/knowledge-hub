import type { FastifyInstance } from "fastify";

import type { RouteContext } from "./context";

export function registerReviewRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.get<{ Querystring: { severity?: string } }>(
    "/api/review/tasks",
    { preHandler: app.authenticate },
    async (request) => {
      const severity = request.query.severity === "blocking" || request.query.severity === "warning" || request.query.severity === "info"
        ? request.query.severity
        : undefined;
      return { tasks: await ctx.service.listReviewTasks({ severity }) };
    }
  );
}
