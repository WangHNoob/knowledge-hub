import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";

import { loginSchema } from "../schemas";
import type { RouteContext } from "./context";

export function registerAuthRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.post("/api/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid login payload." });
    const user = await ctx.service.getUserByUsername(parsed.data.username);
    if (!user || !bcrypt.compareSync(parsed.data.password, user.passwordHash)) {
      return reply.code(401).send({ error: "用户名或密码错误。" });
    }
    const token = app.jwt.sign({ sub: user.id, username: user.username, role: user.role });
    return {
      token,
      user: { id: user.id, username: user.username, role: user.role, displayName: user.displayName }
    };
  });

  app.get("/api/me", { preHandler: app.authenticate }, async (request) => ({ user: request.user }));
}
