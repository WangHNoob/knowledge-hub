import type { FastifyInstance } from "fastify";

import { config } from "../config";
import { requireRole } from "../middleware/auth";
import type { RouteContext } from "./context";

export function registerOpsRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.get("/api/ui-config", { preHandler: app.authenticate }, async () => ({
    uiMode: config.uiMode,
    publishRelaxed: config.publishRelaxed,
    brand: {
      title: "Knowledge Hub",
      subtitle: config.uiMode === "simple" ? "内网知识库" : "资产飞轮管理台",
    },
  }));

}
