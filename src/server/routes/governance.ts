import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";

import { governanceProfileUpdateSchema } from "../schemas";
import { requireRole } from "../middleware/auth";
import type { RouteContext } from "./context";

type UpdateBody = z.infer<typeof governanceProfileUpdateSchema>;

/**
 * 阶段7：项目级治理规则集中化。
 * - GET  profile  返回合并后的治理策略（普通用户只读结果）。
 * - PUT  profile  管理员按项目落覆盖值。
 * - POST reset    管理员清除项目级覆盖，回退到环境变量默认。
 * 均支持默认项目与显式 projectId 两种路径。
 */
export function registerGovernanceRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.get("/api/flywheel/governance-profile", { preHandler: app.authenticate }, async () => ({
    profile: await ctx.governanceProfileService.resolve("default_project"),
  }));
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/governance-profile",
    { preHandler: app.authenticate },
    async (request) => ({ profile: await ctx.governanceProfileService.resolve(request.params.projectId) }),
  );

  app.put<{ Body: UpdateBody }>(
    "/api/flywheel/governance-profile",
    { preHandler: [app.authenticate, requireRole("admin")] },
    async (request, reply) => runUpdate(ctx, reply, request, "default_project"),
  );
  app.put<{ Params: { projectId: string }; Body: UpdateBody }>(
    "/api/projects/:projectId/governance-profile",
    { preHandler: [app.authenticate, requireRole("admin")] },
    async (request, reply) => runUpdate(ctx, reply, request, request.params.projectId),
  );

  app.post("/api/flywheel/governance-profile/reset", { preHandler: [app.authenticate, requireRole("admin")] }, async () => ({
    profile: await ctx.governanceProfileService.reset("default_project"),
  }));
  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/governance-profile/reset",
    { preHandler: [app.authenticate, requireRole("admin")] },
    async (request) => ({ profile: await ctx.governanceProfileService.reset(request.params.projectId) }),
  );
}

async function runUpdate(
  ctx: RouteContext,
  reply: FastifyReply,
  request: FastifyRequest<{ Body: UpdateBody }>,
  projectId: string,
) {
  const parsed = governanceProfileUpdateSchema.safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "无效的治理规则。" });
  const profile = await ctx.governanceProfileService.update({
    projectId,
    patch: parsed.data,
    updatedBy: request.user.username,
  });
  return reply.send({ profile });
}
