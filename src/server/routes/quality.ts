import type { FastifyInstance } from "fastify";

import { requireRole } from "../middleware/auth";
import { qualityProfileUpdateSchema } from "../schemas";
import { getTrustPolicy } from "../services/trustScore";
import type { RouteContext } from "./context";

export function registerQualityRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.get("/api/quality-gate/profile", { preHandler: app.authenticate }, async () => ({
    profile: await ctx.kbBuilderService.getActiveQualityProfile()
  }));

  app.get("/api/quality-gate/trust-policy", { preHandler: app.authenticate }, async () => ({
    policy: getTrustPolicy()
  }));

  app.put("/api/quality-gate/profile", {
    preHandler: [app.authenticate, requireRole("admin")]
  }, async (request, reply) => {
    const parsed = qualityProfileUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid quality profile payload." });
    return {
      profile: await ctx.kbBuilderService.updateActiveQualityProfile(parsed.data.config, request.user.username)
    };
  });
}
