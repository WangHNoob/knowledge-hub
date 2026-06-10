import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { dirname } from "node:path";

import type { DatabaseHandle, UserRecord } from "./types";
import { createKnowledgeService } from "./services/knowledgeService";
import { scanLegacyKbBuilder } from "./services/legacyScanner";
import { createSourceImportService } from "./services/sourceImportService";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; username: string; role: UserRecord["role"] };
    user: { sub: string; username: string; role: UserRecord["role"] };
  }
}

export interface BuildAppOptions {
  db: DatabaseHandle;
  jwtSecret: string;
  dataDir?: string;
}

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

const legacyScanSchema = z.object({
  path: z.string().min(1)
});

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const service = createKnowledgeService(options.db);
  const sourceImporter = createSourceImportService(options.db, options.dataDir ?? dirname(options.db.path));

  await app.register(cors, { origin: true, credentials: true });
  await app.register(jwt, { secret: options.jwtSecret });
  await app.register(multipart);
  app.decorate("authenticate", async (request: FastifyRequest) => {
    await request.jwtVerify();
  });

  app.get("/api/health", async () => ({ status: "ok" }));

  app.post("/api/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid login payload." });
    const user = service.getUserByUsername(parsed.data.username);
    if (!user || !bcrypt.compareSync(parsed.data.password, user.passwordHash)) {
      return reply.code(401).send({ error: "用户名或密码错误。" });
    }
    const token = app.jwt.sign({ sub: user.id, username: user.username, role: user.role });
    return {
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        displayName: user.displayName
      }
    };
  });

  app.get("/api/me", { preHandler: app.authenticate }, async (request) => ({
    user: request.user
  }));

  app.get("/api/dashboard", { preHandler: app.authenticate }, async () => service.getDashboardSummary());
  app.get("/api/sources", { preHandler: app.authenticate }, async () => ({ sources: service.listSources() }));
  app.post("/api/sources/upload", { preHandler: app.authenticate }, async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: "请选择要导入的资料文件。" });
    const chunks: Buffer[] = [];
    for await (const chunk of file.file) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const fields = file.fields as Record<string, { value?: unknown }>;
    const title = typeof fields.title?.value === "string" ? fields.title.value : undefined;
    const result = sourceImporter.importBuffer({
      filename: file.filename,
      content: Buffer.concat(chunks),
      title
    });
    return result;
  });
  app.get("/api/packages", { preHandler: app.authenticate }, async () => ({ packages: service.listPackages() }));
  app.get<{ Params: { packageId: string } }>(
    "/api/packages/:packageId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      try {
        return service.getPackageDetail(request.params.packageId);
      } catch (error) {
        return reply.code(404).send({ error: error instanceof Error ? error.message : "Unknown package." });
      }
    }
  );
  app.get<{ Querystring: { severity?: string } }>(
    "/api/review/tasks",
    { preHandler: app.authenticate },
    async (request) => {
      const severity = request.query.severity === "blocking" || request.query.severity === "warning" || request.query.severity === "info"
        ? request.query.severity
        : undefined;
      return { tasks: service.listReviewTasks({ severity }) };
    }
  );
  app.get("/api/releases", { preHandler: app.authenticate }, async () => ({ releases: service.listReleases() }));
  app.get("/api/agent/events", { preHandler: app.authenticate }, async () => ({ events: service.listAgentEvents() }));
  app.post("/api/legacy/scan", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = legacyScanSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "请提供旧知识库 data 目录路径。" });
    try {
      return scanLegacyKbBuilder(parsed.data.path);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "扫描失败。" });
    }
  });

  app.addHook("onClose", async () => {
    options.db.close();
  });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate(request: FastifyRequest): Promise<void>;
  }
}
