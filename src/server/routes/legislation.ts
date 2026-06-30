import type { FastifyInstance } from "fastify";

import { denyRole, requireRole } from "../middleware/auth";
import { activateLegislationProfileSchema, annotationExampleActiveSchema, createLegislationProfileSchema } from "../schemas";
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

  app.get("/api/legislation/annotation-examples", { preHandler: app.authenticate }, async () => ({
    examples: await ctx.service.listAnnotationExamples(),
  }));

  app.post<{ Params: { exampleId: string } }>(
    "/api/legislation/annotation-examples/:exampleId/active",
    { preHandler: [app.authenticate, denyRole("viewer")] },
    async (request, reply) => {
      const parsed = annotationExampleActiveSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid annotation example active payload." });
      try {
        return { example: await ctx.service.setAnnotationExampleActive(request.params.exampleId, parsed.data.active) };
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "更新标注样例失败。" });
      }
    }
  );

  app.post<{ Params: { exampleId: string } }>(
    "/api/legislation/annotation-examples/:exampleId/review",
    { preHandler: [app.authenticate, denyRole("viewer")] },
    async (request, reply) => {
      try {
        return { task: await ctx.service.createAnnotationExampleReviewTask(request.params.exampleId, request.user.username) };
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "生成标注样例复盘任务失败。" });
      }
    }
  );
}
