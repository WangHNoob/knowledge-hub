import type { FastifyInstance } from "fastify";
import type { z } from "zod";

import { flywheelSyncSchema, exceptionDismissSchema, exceptionRestoreSchema } from "../schemas";
import { denyRole } from "../middleware/auth";
import type { RouteContext } from "./context";

/**
 * 轻量知识运营台的三个入口：
 * - GET  status      总控台一句话状态 + 主动作 + metrics + 例外 + 自动化
 * - GET  exceptions  例外中心（只列必须人工处理的项）
 * - POST sync        一键同步并发布（构建 + 治理 + 自动发布）
 * 均支持默认项目与显式 projectId 两种路径。
 */
export function registerFlywheelRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.get("/api/flywheel/status", { preHandler: app.authenticate }, async () => ctx.flywheelService.getStatus("default_project"));
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/flywheel/status",
    { preHandler: app.authenticate },
    async (request) => ctx.flywheelService.getStatus(request.params.projectId),
  );

  app.get("/api/flywheel/exceptions", { preHandler: app.authenticate }, async () => ({
    exceptions: await ctx.flywheelService.listExceptions("default_project"),
  }));
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/flywheel/exceptions",
    { preHandler: app.authenticate },
    async (request) => ({ exceptions: await ctx.flywheelService.listExceptions(request.params.projectId) }),
  );

  app.get("/api/flywheel/feedback-clusters", { preHandler: app.authenticate }, async () => ({
    clusters: await ctx.flywheelService.listFeedbackClusters("default_project"),
  }));
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/flywheel/feedback-clusters",
    { preHandler: app.authenticate },
    async (request) => ({ clusters: await ctx.flywheelService.listFeedbackClusters(request.params.projectId) }),
  );

  app.post(
    "/api/flywheel/feedback-clusters/promote",
    { preHandler: [app.authenticate, denyRole("viewer")] },
    async (request) => ctx.flywheelService.promoteFeedbackClusters({
      projectId: "default_project",
      requestedBy: request.user.username,
    }),
  );
  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/flywheel/feedback-clusters/promote",
    { preHandler: [app.authenticate, denyRole("viewer")] },
    async (request) => ctx.flywheelService.promoteFeedbackClusters({
      projectId: request.params.projectId,
      requestedBy: request.user.username,
    }),
  );

  // 例外软忽略：从收件箱隐藏但保留可审计痕迹，可恢复（denyRole viewer）。
  registerExceptionDismissalRoutes(app, ctx, "/api/flywheel", "default_project");
  registerExceptionDismissalRoutes(app, ctx, "/api/projects/:projectId/flywheel", null);

  // 单组件重建并作为修订发布（源级 wiki 页/表 → scoped rebuild；图谱 → 阶段级重建）。
  app.post<{ Params: { componentId: string } }>(
    "/api/flywheel/components/:componentId/rebuild",
    { preHandler: [app.authenticate, denyRole("viewer")] },
    async (request, reply) => runComponentRebuild(ctx, reply, request, "default_project", request.params.componentId),
  );
  app.post<{ Params: { projectId: string; componentId: string } }>(
    "/api/projects/:projectId/flywheel/components/:componentId/rebuild",
    { preHandler: [app.authenticate, denyRole("viewer")] },
    async (request, reply) => runComponentRebuild(ctx, reply, request, request.params.projectId, request.params.componentId),
  );

  // 知识图谱阶段级重建并作为修订发布。
  app.post(
    "/api/flywheel/graph/rebuild",
    { preHandler: [app.authenticate, denyRole("viewer")] },
    async (request, reply) => runGraphRebuild(ctx, reply, request, "default_project"),
  );
  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/flywheel/graph/rebuild",
    { preHandler: [app.authenticate, denyRole("viewer")] },
    async (request, reply) => runGraphRebuild(ctx, reply, request, request.params.projectId),
  );

  // 停止该项目当前所有 running 构建（一键同步/自动流水线的紧急刹车）。
  app.post(
    "/api/flywheel/builds/stop",
    { preHandler: [app.authenticate, denyRole("viewer")] },
    async (request) => ({ stopped: await ctx.kbBuilderService.stopRunningBuilds("default_project", request.user.username) }),
  );
  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/flywheel/builds/stop",
    { preHandler: [app.authenticate, denyRole("viewer")] },
    async (request) => ({ stopped: await ctx.kbBuilderService.stopRunningBuilds(request.params.projectId, request.user.username) }),
  );

  app.get<{ Querystring: { releaseId?: string } }>(
    "/api/flywheel/remediations",
    { preHandler: app.authenticate },
    async (request) => ({
      remediations: await ctx.lintRemediationService.listRemediations({ projectId: "default_project", releaseId: request.query.releaseId }),
      summary: await ctx.lintRemediationService.summary("default_project", request.query.releaseId),
    }),
  );
  app.get<{ Params: { projectId: string }; Querystring: { releaseId?: string } }>(
    "/api/projects/:projectId/flywheel/remediations",
    { preHandler: app.authenticate },
    async (request) => ({
      remediations: await ctx.lintRemediationService.listRemediations({ projectId: request.params.projectId, releaseId: request.query.releaseId }),
      summary: await ctx.lintRemediationService.summary(request.params.projectId, request.query.releaseId),
    }),
  );
  app.post<{ Params: { projectId: string; remediationId: string } }>(
    "/api/projects/:projectId/flywheel/remediations/:remediationId/retry",
    { preHandler: [app.authenticate, denyRole("viewer")] },
    async (request) => ({
      remediation: await ctx.lintRemediationService.retry({
        projectId: request.params.projectId,
        remediationId: request.params.remediationId,
        requestedBy: request.user.username,
        kbBuilderService: ctx.kbBuilderService,
      }),
    }),
  );

  app.post<{ Body: z.infer<typeof flywheelSyncSchema> }>(
    "/api/flywheel/sync",
    { preHandler: [app.authenticate, denyRole("viewer")] },
    async (request, reply) => runSync(ctx, reply, request, "default_project"),
  );
  app.post<{ Params: { projectId: string }; Body: z.infer<typeof flywheelSyncSchema> }>(
    "/api/projects/:projectId/flywheel/sync",
    { preHandler: [app.authenticate, denyRole("viewer")] },
    async (request, reply) => runSync(ctx, reply, request, request.params.projectId),
  );
}

/**
 * 例外软忽略的三个入口，默认项目与显式 projectId 共用。basePath 含 :projectId 时
 * defaultProjectId 传 null，从路由参数取项目；否则用固定的默认项目。
 */
function registerExceptionDismissalRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
  basePath: string,
  defaultProjectId: string | null,
) {
  const resolveProjectId = (params: Record<string, string | undefined>): string =>
    defaultProjectId ?? params.projectId ?? "default_project";

  app.get<{ Params: Record<string, string> }>(
    `${basePath}/exceptions/dismissed`,
    { preHandler: app.authenticate },
    async (request) => ({
      dismissed: await ctx.flywheelService.listDismissedExceptions(resolveProjectId(request.params)),
    }),
  );

  app.post<{ Params: Record<string, string>; Body: z.infer<typeof exceptionDismissSchema> }>(
    `${basePath}/exceptions/dismiss`,
    { preHandler: [app.authenticate, denyRole("viewer")] },
    async (request, reply) => {
      const parsed = exceptionDismissSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid dismiss payload." });
      const dismissed = await ctx.flywheelService.dismissException({
        projectId: resolveProjectId(request.params),
        key: parsed.data.key,
        exceptionType: parsed.data.exceptionType,
        title: parsed.data.title,
        reason: parsed.data.reason,
        dismissedBy: request.user.username,
      });
      return reply.code(201).send({ dismissed });
    },
  );

  app.post<{ Params: Record<string, string>; Body: z.infer<typeof exceptionRestoreSchema> }>(
    `${basePath}/exceptions/restore`,
    { preHandler: [app.authenticate, denyRole("viewer")] },
    async (request, reply) => {
      const parsed = exceptionRestoreSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid restore payload." });
      await ctx.flywheelService.restoreException({
        projectId: resolveProjectId(request.params),
        key: parsed.data.key,
        restoredBy: request.user.username,
      });
      return reply.code(204).send();
    },
  );
}

async function runComponentRebuild(
  ctx: RouteContext,
  reply: import("fastify").FastifyReply,
  request: import("fastify").FastifyRequest,
  projectId: string,
  componentId: string,
) {
  const result = await ctx.flywheelService.rebuildComponent({
    projectId,
    componentId,
    requestedBy: request.user.username,
    traceId: request.traceId,
  });
  if (result.status === "failed") return reply.code(400).send(result);
  if (result.status === "needs_attention") return reply.code(409).send(result);
  return reply.code(202).send(result);
}

async function runGraphRebuild(
  ctx: RouteContext,
  reply: import("fastify").FastifyReply,
  request: import("fastify").FastifyRequest,
  projectId: string,
) {
  const result = await ctx.flywheelService.rebuildGraph({
    projectId,
    requestedBy: request.user.username,
    traceId: request.traceId,
  });
  if (result.status === "failed") return reply.code(400).send(result);
  if (result.status === "needs_attention") return reply.code(409).send(result);
  return reply.code(202).send(result);
}

async function runSync(
  ctx: RouteContext,
  reply: import("fastify").FastifyReply,
  request: import("fastify").FastifyRequest<{ Body: z.infer<typeof flywheelSyncSchema> }>,
  projectId: string,
) {
  const parsed = flywheelSyncSchema.safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid sync payload." });
  const result = await ctx.flywheelService.sync({
    projectId,
    requestedBy: request.user.username,
    traceId: request.traceId,
    mode: parsed.data.mode,
  });
  if (result.status === "failed") return reply.code(400).send(result);
  return reply.code(202).send(result);
}
