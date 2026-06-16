import type { FastifyInstance } from "fastify";
import type { z } from "zod";

import { denyRole } from "../middleware/auth";
import { diagnosticLogQuerySchema } from "../schemas";
import type { RouteContext } from "./context";

const noViewer = denyRole("viewer");

export function registerDiagnosticsRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.get<{ Querystring: z.infer<typeof diagnosticLogQuerySchema> }>(
    "/api/diagnostics/logs",
    { preHandler: [app.authenticate, noViewer] },
    async (request, reply) => {
      const parsed = diagnosticLogQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid diagnostics query." });
      return { logs: await ctx.diagnostics.listLogs(parsed.data) };
    }
  );

  app.get<{ Params: { traceId: string } }>(
    "/api/diagnostics/logs/:traceId",
    { preHandler: [app.authenticate, noViewer] },
    async (request) => ({ logs: await ctx.diagnostics.trace(request.params.traceId) })
  );

  app.get(
    "/api/diagnostics/summary",
    { preHandler: [app.authenticate, noViewer] },
    async () => ({ summary: await ctx.diagnostics.summary() })
  );
}
