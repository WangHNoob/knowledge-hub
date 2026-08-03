import type { FastifyInstance } from "fastify";

import { config } from "../config";
import { requireRole } from "../middleware/auth";
import { runSvnSyncIngest } from "../services/svnSyncService";
import type { RouteContext } from "./context";

export function registerOpsRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.get("/api/ui-config", { preHandler: app.authenticate }, async () => ({
    uiMode: config.uiMode,
    publishRelaxed: config.publishRelaxed,
    svnSyncEnabled: config.svnSyncEnabled && Boolean(config.svnWcPath.trim()),
    brand: {
      title: "Knowledge Hub",
      subtitle: config.uiMode === "simple" ? "内网知识库" : "资产飞轮管理台",
    },
  }));

  app.post<{
    Body?: { projectId?: string; skipSvnUpdate?: boolean };
  }>(
    "/api/ops/svn-sync",
    { preHandler: [app.authenticate, requireRole("admin", "developer")] },
    async (request, reply) => {
      try {
        const result = await runSvnSyncIngest(ctx, {
          projectId: request.body?.projectId,
          requestedBy: request.user.username,
          skipSvnUpdate: request.body?.skipSvnUpdate === true,
        });
        if (!result.ok && result.skipped) {
          return reply.code(400).send({ error: result.reason ?? "SVN 同步未启用", result });
        }
        if (!result.ok) {
          return reply.code(500).send({ error: result.reason ?? "SVN 同步失败", result });
        }
        return { result };
      } catch (error) {
        return reply.code(500).send({
          error: error instanceof Error ? error.message : "SVN 同步失败",
        });
      }
    },
  );
}
