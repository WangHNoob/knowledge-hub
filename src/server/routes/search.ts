import type { FastifyInstance } from "fastify";
import type { z } from "zod";

import { searchQuerySchema } from "../schemas";
import type { RouteContext } from "./context";

export function registerSearchRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.get<{ Querystring: z.infer<typeof searchQuerySchema> }>(
    "/api/search",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const parsed = searchQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid search query." });
      return { result: await ctx.service.search(parsed.data.q, parsed.data.limit) };
    }
  );
}
