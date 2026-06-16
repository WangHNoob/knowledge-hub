import type { FastifyInstance } from "fastify";

import { requireRole } from "../middleware/auth";
import { activateLegislationProfileSchema, createLegislationProfileSchema } from "../schemas";
import type { RouteContext } from "./context";

export function registerLegislationRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.get("/api/legislation/profile", { preHandler: app.authenticate }, async () => ({
    profile: await ctx.legislationService.getActiveProfile(),
    profiles: await ctx.legislationService.listProfiles(),
  }));

  app.post("/api/legislation/profile", {
    preHandler: [app.authenticate, requireRole("admin")]
  }, async (request, reply) => {
    const parsed = createLegislationProfileSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid legislation profile payload." });
    return {
      profile: await ctx.legislationService.createProfile({
        name: parsed.data.name,
        config: parsed.data.config,
        activate: parsed.data.activate,
        createdBy: request.user.username,
      })
    };
  });

  app.post("/api/legislation/profile/activate", {
    preHandler: [app.authenticate, requireRole("admin")]
  }, async (request, reply) => {
    const parsed = activateLegislationProfileSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid legislation activation payload." });
    return { profile: await ctx.legislationService.activateProfile(parsed.data.profileId, request.user.username) };
  });
}
