import type { FastifyInstance } from "fastify";

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
