import type { FastifyInstance } from "fastify";

import { requireRole } from "../middleware/auth";
import { createReleaseSchema, rollbackReleaseSchema } from "../schemas";
import type { RouteContext } from "./context";

export function registerReleaseRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.get("/api/releases", { preHandler: app.authenticate }, async () => ({
    releases: await ctx.service.listReleases()
  }));

  app.get("/api/releases/current", { preHandler: app.authenticate }, async () => ({
    release: await ctx.releaseService.getCurrent()
  }));

  app.post("/api/releases", {
    preHandler: [app.authenticate, requireRole("admin")]
  }, async (request, reply) => {
    const parsed = createReleaseSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid release payload." });
    try {
      return {
        release: await ctx.releaseService.createDraft({
          ...parsed.data,
          requestedBy: request.user.username
        })
      };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "创建发布草案失败。" });
    }
  });

  app.post<{ Params: { releaseId: string } }>(
    "/api/releases/:releaseId/publish",
    { preHandler: [app.authenticate, requireRole("admin")] },
    async (request, reply) => {
      try {
        return { release: await ctx.releaseService.publish(request.params.releaseId, request.user.username) };
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "发布失败。" });
      }
    }
  );

  app.post("/api/releases/rollback", {
    preHandler: [app.authenticate, requireRole("admin")]
  }, async (request, reply) => {
    const parsed = rollbackReleaseSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid rollback payload." });
    try {
      return { release: await ctx.releaseService.rollback(parsed.data.releaseId, request.user.username) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "回滚失败。" });
    }
  });
}
