import type { FastifyInstance } from "fastify";
import type { z } from "zod";

import { denyRole } from "../middleware/auth";
import { tableAliasUpdateSchema } from "../schemas";
import { createTableAliasService } from "../services/tableAliasService";
import type { RouteContext } from "./context";

export function registerTableAliasRoutes(app: FastifyInstance, ctx: RouteContext) {
  const service = createTableAliasService(ctx.db);

  app.get("/api/table-aliases", { preHandler: app.authenticate }, async () => ({
    entries: await service.list()
  }));

  app.put<{ Body: z.infer<typeof tableAliasUpdateSchema> }>(
    "/api/table-aliases",
    { preHandler: [app.authenticate, denyRole("viewer")] },
    async (request, reply) => {
      const parsed = tableAliasUpdateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid table alias payload." });
      const entries = await service.upsertMany(parsed.data.entries, request.user.username, "manual");
      return { entries };
    }
  );
}
