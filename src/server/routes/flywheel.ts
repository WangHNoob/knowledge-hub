import type { FastifyInstance } from "fastify";
import type { z } from "zod";

import { flywheelSyncSchema } from "../schemas";
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
