import type { FastifyInstance } from "fastify";
import type { z } from "zod";

import { requireRole, denyRole } from "../middleware/auth";
import { createReleaseSchema, publishReleaseSchema, rollbackReleaseSchema, updateReleaseSchema } from "../schemas";
import type { RouteContext } from "./context";

export function registerReleaseRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.get("/api/releases", { preHandler: app.authenticate }, async () => ({
    releases: await ctx.service.listReleases("default_project")
  }));

  app.get("/api/releases/current", { preHandler: app.authenticate }, async () => ({
    release: await ctx.releaseService.getCurrent("default_project")
  }));

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/releases", { preHandler: app.authenticate }, async (request) => ({
    releases: await ctx.service.listReleases(request.params.projectId)
  }));

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/releases/current", { preHandler: app.authenticate }, async (request) => ({
    release: await ctx.releaseService.getCurrent(request.params.projectId)
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
          projectId: "default_project",
          requestedBy: request.user.username
        })
      };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "创建发布草案失败。" });
    }
  });

  app.post<{ Params: { projectId: string }; Body: z.infer<typeof createReleaseSchema> }>("/api/projects/:projectId/releases", {
    preHandler: [app.authenticate, requireRole("admin")]
  }, async (request, reply) => {
    const parsed = createReleaseSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid release payload." });
    try {
      return {
        release: await ctx.releaseService.createDraft({
          ...parsed.data,
          projectId: request.params.projectId,
          requestedBy: request.user.username
        })
      };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "创建发布草案失败。" });
    }
  });

  app.post<{ Params: { releaseId: string }; Body: z.infer<typeof publishReleaseSchema> }>(
    "/api/releases/:releaseId/publish",
    { preHandler: [app.authenticate, requireRole("admin")] },
    async (request, reply) => {
      const parsed = publishReleaseSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "Invalid publish payload." });
      try {
        return { release: await ctx.releaseService.publish(request.params.releaseId, request.user.username, parsed.data) };
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "发布失败。" });
      }
    }
  );

  app.patch<{ Params: { releaseId: string }; Body: z.infer<typeof updateReleaseSchema> }>(
    "/api/releases/:releaseId",
    { preHandler: [app.authenticate, denyRole("viewer")] },
    async (request, reply) => {
      const parsed = updateReleaseSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid release update." });
      const updated = await ctx.releaseService.updateRelease(request.params.releaseId, parsed.data);
      if (!updated) return reply.code(404).send({ error: "Unknown release." });
      return { release: updated };
    }
  );

  app.delete<{ Params: { releaseId: string } }>(
    "/api/releases/:releaseId",
    { preHandler: [app.authenticate, requireRole("admin")] },
    async (request, reply) => {
      try {
        return { release: await ctx.releaseService.deleteRelease(request.params.releaseId, request.user.username) };
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "删除发布版本失败。" });
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
