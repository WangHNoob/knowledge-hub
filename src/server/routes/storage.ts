import type { FastifyInstance } from "fastify";

import { requireRole } from "../middleware/auth";
import { reclaimRequestSchema } from "../schemas";
import type { RouteContext } from "./context";

export function registerStorageRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.get(
    "/api/storage/overview",
    { preHandler: [app.authenticate, requireRole("admin", "maintainer")] },
    async () => ({ overview: await ctx.storageService.overview() })
  );

  app.get(
    "/api/storage/scan",
    { preHandler: [app.authenticate, requireRole("admin", "maintainer")] },
    async () => ({ report: await ctx.storageService.scan() })
  );

  app.post(
    "/api/storage/reclaim",
    { preHandler: [app.authenticate, requireRole("admin")] },
    async (request, reply) => {
      const parsed = reclaimRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid reclaim payload." });
      return { result: await ctx.storageService.reclaim(parsed.data, request.user.username) };
    }
  );
}
