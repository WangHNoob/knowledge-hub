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

  // Import a cn_en_map.json payload (flat { "EnglishTable": "中文名" } or [{ table, aliases }]).
  app.post<{ Body: { map?: unknown } }>(
    "/api/table-aliases/import",
    { preHandler: [app.authenticate, denyRole("viewer")] },
    async (request, reply) => {
      const map = request.body?.map;
      if (map === undefined || map === null || typeof map !== "object") {
        return reply.code(400).send({ error: "请提供 cn_en_map JSON（对象或数组）。" });
      }
      const result = await service.importMap(map, request.user.username);
      const entries = await service.list();
      return { imported: result.imported, entries };
    }
  );

  // Remove rows with no alias (e.g. tables auto-enumerated by older builds).
  app.post(
    "/api/table-aliases/prune",
    { preHandler: [app.authenticate, denyRole("viewer")] },
    async () => {
      const result = await service.pruneEmpty();
      const entries = await service.list();
      return { removed: result.removed, entries };
    }
  );
}
