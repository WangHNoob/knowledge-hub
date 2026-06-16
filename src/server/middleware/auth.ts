import type { FastifyReply, FastifyRequest } from "fastify";

import type { UserRecord } from "../types";

/**
 * Returns a preHandler that 403s when the user's role is not in `allowed`.
 * Compose with `app.authenticate` like:
 *   { preHandler: [app.authenticate, requireRole("admin")] }
 */
export function requireRole(...allowed: UserRecord["role"][]) {
  const set = new Set(allowed);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!set.has(request.user.role)) {
      return reply.code(403).send({ error: `需要角色：${allowed.join(" / ")}。` });
    }
  };
}

/**
 * Returns a preHandler that 403s when the user's role is in `denied`.
 * Inverse of requireRole — useful for "everyone except viewer" routes.
 */
export function denyRole(...denied: UserRecord["role"][]) {
  const set = new Set(denied);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (set.has(request.user.role)) {
      return reply.code(403).send({ error: "当前角色无权访问。" });
    }
  };
}
