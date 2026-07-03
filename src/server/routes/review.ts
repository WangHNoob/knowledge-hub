import type { FastifyInstance } from "fastify";
import type { z } from "zod";

import { denyRole } from "../middleware/auth";
import { reviewAnnotationSchema, reviewTransitionSchema } from "../schemas";
import type { ReviewStatus } from "../types";
import type { RouteContext } from "./context";

export function registerReviewRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.get<{ Querystring: { severity?: string; status?: string } }>(
    "/api/review/tasks",
    { preHandler: app.authenticate },
    async (request) => {
      const severity = request.query.severity === "blocking" || request.query.severity === "warning" || request.query.severity === "info"
        ? request.query.severity
        : undefined;
      const status = request.query.status === "open" || request.query.status === "resolved" || request.query.status === "dismissed"
        ? (request.query.status as ReviewStatus)
        : undefined;
      return { tasks: await ctx.service.listReviewTasks({ severity, status, projectId: "default_project" }) };
    }
  );

  app.get<{ Params: { projectId: string }; Querystring: { severity?: string; status?: string } }>(
    "/api/projects/:projectId/review/tasks",
    { preHandler: app.authenticate },
    async (request) => {
      const severity = request.query.severity === "blocking" || request.query.severity === "warning" || request.query.severity === "info"
        ? request.query.severity
        : undefined;
      const status = request.query.status === "open" || request.query.status === "resolved" || request.query.status === "dismissed"
        ? (request.query.status as ReviewStatus)
        : undefined;
      return { tasks: await ctx.service.listReviewTasks({ severity, status, projectId: request.params.projectId }) };
    }
  );

  app.post<{ Body: z.infer<typeof reviewTransitionSchema> }>(
    "/api/review/tasks/transition",
    { preHandler: [app.authenticate, denyRole("viewer")] },
    async (request, reply) => {
      const parsed = reviewTransitionSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid review transition payload." });
      const tasks = await ctx.service.transitionReviewTasks(
        parsed.data.taskIds,
        parsed.data.status,
        request.user.username,
        parsed.data.note ?? ""
      );
      return { tasks };
    }
  );

  app.post<{ Body: z.infer<typeof reviewAnnotationSchema> }>(
    "/api/review/tasks/annotate",
    { preHandler: [app.authenticate, denyRole("viewer")] },
    async (request, reply) => {
      const parsed = reviewAnnotationSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid review annotation payload." });
      try {
        return await ctx.service.annotateReviewTask({
          ...parsed.data,
          actor: request.user.username,
        });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "提交标注失败。" });
      }
    }
  );

  app.post<{ Params: { taskId: string } }>(
    "/api/review/tasks/:taskId/rebuild",
    { preHandler: [app.authenticate, denyRole("viewer")] },
    async (request, reply) => {
      try {
        const run = await ctx.kbBuilderService.startRebuildFromReviewTask(request.params.taskId, request.user.username, request.traceId);
        return reply.code(202).send({ run });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "启动增量重建失败。" });
      }
    }
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/review/auto-fixed",
    { preHandler: app.authenticate },
    async (request) => {
      return { tasks: await ctx.service.listAutoFixedTasks({ projectId: request.params.projectId }) };
    }
  );

  app.post<{ Params: { projectId: string; taskId: string } }>(
    "/api/projects/:projectId/review/auto-fixed/:taskId/rollback",
    { preHandler: [app.authenticate, denyRole("viewer")] },
    async (request, reply) => {
      try {
        const task = await ctx.service.rollbackAutoFix(request.params.taskId, request.user.username);
        return { task };
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "回滚自动修复失败。" });
      }
    }
  );
}
