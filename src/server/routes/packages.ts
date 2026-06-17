import type { FastifyInstance } from "fastify";

import { requireRole } from "../middleware/auth";
import { PackageDeleteConflictError } from "../services/knowledgeService";
import type { RouteContext } from "./context";

export function registerPackageRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.get("/api/packages", { preHandler: app.authenticate }, async () => ({
    packages: await ctx.service.listPackages()
  }));

  app.get<{ Params: { packageId: string } }>(
    "/api/packages/:packageId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      try {
        return await ctx.service.getPackageDetail(request.params.packageId);
      } catch (error) {
        return reply.code(404).send({ error: error instanceof Error ? error.message : "Unknown package." });
      }
    }
  );

  app.get<{ Params: { packageId: string; componentId: string } }>(
    "/api/packages/:packageId/components/:componentId/content",
    { preHandler: app.authenticate },
    async (request, reply) => {
      try {
        return await ctx.queryService.getComponentFile(request.params.packageId, request.params.componentId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to read component file.";
        const code = /legacy/i.test(message) ? 400 : 404;
        return reply.code(code).send({ error: message });
      }
    },
  );

  app.delete<{ Params: { packageId: string } }>(
    "/api/packages/:packageId",
    { preHandler: [app.authenticate, requireRole("admin")] },
    async (request, reply) => {
      try {
        const deleted = await ctx.service.deletePackage(request.params.packageId);
        if (!deleted) return reply.code(404).send({ error: "Unknown package." });
        return { deleted: true };
      } catch (error) {
        if (error instanceof PackageDeleteConflictError) {
          return reply.code(409).send({ error: error.message, releaseIds: error.releaseIds });
        }
        throw error;
      }
    },
  );

  app.get<{ Querystring: { packageId?: string; componentId?: string } }>(
    "/api/evidence",
    { preHandler: app.authenticate },
    async (request) => ({
      records: await ctx.service.listEvidenceRecords({
        packageId: request.query.packageId,
        componentId: request.query.componentId
      }),
      coverage: await ctx.service.getEvidenceCoverage({ packageId: request.query.packageId })
    })
  );
}
