import type { FastifyInstance } from "fastify";
import type { z } from "zod";

import { requireRole, denyRole } from "../middleware/auth";
import { packageListQuerySchema, updatePackageSchema } from "../schemas";
import { PackageDeleteConflictError } from "../services/knowledgeService";
import type { RouteContext } from "./context";

export function registerPackageRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.get<{ Querystring: z.infer<typeof packageListQuerySchema> }>(
    "/api/packages",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const parsed = packageListQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid package query." });
      return { packages: await ctx.service.listPackages(parsed.data) };
    }
  );

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

  app.patch<{ Params: { packageId: string }; Body: z.infer<typeof updatePackageSchema> }>(
    "/api/packages/:packageId",
    { preHandler: [app.authenticate, denyRole("viewer")] },
    async (request, reply) => {
      const parsed = updatePackageSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid package update." });
      const updated = await ctx.service.updatePackage(request.params.packageId, parsed.data);
      if (!updated) return reply.code(404).send({ error: "Unknown package." });
      return { package: updated };
    }
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

  app.get<{ Params: { componentId: string } }>(
    "/api/components/:componentId/owner",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const packageId = await ctx.service.findComponentOwner(request.params.componentId);
      if (!packageId) return reply.code(404).send({ error: "Unknown component." });
      return { packageId };
    }
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
