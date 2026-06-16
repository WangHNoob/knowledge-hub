import type { FastifyInstance } from "fastify";

import { importLegacyAsDraftPackage } from "../services/legacyImportService";
import { scanLegacyKbBuilder } from "../services/legacyScanner";
import { legacyScanSchema } from "../schemas";
import type { RouteContext } from "./context";

export function registerLegacyRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.post("/api/legacy/scan", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = legacyScanSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "请提供旧知识库 data 目录路径。" });
    try {
      return scanLegacyKbBuilder(parsed.data.path);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "扫描失败。" });
    }
  });

  app.post("/api/legacy/import", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = legacyScanSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "请提供旧知识库 data 目录路径。" });
    try {
      const result = await importLegacyAsDraftPackage(ctx.db, ctx.dataDir, parsed.data.path);
      return { ...result, detail: await ctx.service.getPackageDetail(result.package.packageId) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "导入失败。" });
    }
  });
}
