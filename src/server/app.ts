import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";

import type { DatabaseHandle, UserRecord } from "./types";
import { importLegacyAsDraftPackage } from "./services/legacyImportService";
import { createKnowledgeService } from "./services/knowledgeService";
import { scanLegacyKbBuilder } from "./services/legacyScanner";
import { createSourceBundleService } from "./services/sourceBundleService";

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

const importBundleSchema = z.object({
  rootPath: z.string().min(1),
  bundleId: z.string().min(1).optional(),
  note: z.string().max(1024).optional()
});

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const service = createKnowledgeService(options.db);
  const dataDir = options.dataDir ?? process.cwd();
  const bundleService = createSourceBundleService(options.db, dataDir);

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
    const user = await service.getUserByUsername(parsed.data.username);
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
  app.get("/api/dashboard", { preHandler: app.authenticate }, async () => service.getDashboardSummary());

  // 资料集
  app.get("/api/source-bundles", { preHandler: app.authenticate }, async () => ({
    bundles: await bundleService.listBundles()
  }));
  app.get<{ Params: { bundleId: string } }>(
    "/api/source-bundles/:bundleId/versions",
    { preHandler: app.authenticate },
    async (request) => ({ versions: await bundleService.listVersions(request.params.bundleId) })
  );
  app.get<{ Params: { bundleId: string; versionId: string } }>(
    "/api/source-bundles/:bundleId/versions/:versionId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const version = await bundleService.getVersion(request.params.versionId);
      if (!version || version.bundleId !== request.params.bundleId) {
        return reply.code(404).send({ error: "未找到该资料版本。" });
      }
      return {
        version,
        files: await bundleService.listFiles(version.versionId),
        changes: await bundleService.diff(version.versionId)
      };
    }
  );
  app.post<{ Params: { bundleId: string } }>(
    "/api/source-bundles/:bundleId/versions",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const parsed = importBundleSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "请提供 rootPath。" });
      try {
        return await bundleService.importDirectoryAsVersion({
          rootPath: parsed.data.rootPath,
          bundleId: parsed.data.bundleId ?? request.params.bundleId,
          note: parsed.data.note,
          createdBy: request.user.username
        });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "导入失败。" });
      }
    }
  );

  // 资产包 / 审核 / 证据 / 发布 / Agent 反馈
  app.get("/api/packages", { preHandler: app.authenticate }, async () => ({ packages: await service.listPackages() }));
  app.get<{ Params: { packageId: string } }>(
    "/api/packages/:packageId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      try {
        return await service.getPackageDetail(request.params.packageId);
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
        ? request.query.severity : undefined;
      return { tasks: await service.listReviewTasks({ severity }) };
    }
  );
  app.get<{ Querystring: { packageId?: string; componentId?: string } }>(
    "/api/evidence",
    { preHandler: app.authenticate },
    async (request) => ({
      records: await service.listEvidenceRecords({ packageId: request.query.packageId, componentId: request.query.componentId }),
      coverage: await service.getEvidenceCoverage({ packageId: request.query.packageId })
    })
  );
  app.get("/api/releases", { preHandler: app.authenticate }, async () => ({ releases: await service.listReleases() }));
  app.get("/api/agent/events", { preHandler: app.authenticate }, async () => ({ events: await service.listAgentEvents() }));

  app.post("/api/legacy/scan", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = legacyScanSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "请提供旧知识库 data 目录路径。" });
    try { return scanLegacyKbBuilder(parsed.data.path); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "扫描失败。" }); }
  });
  app.post("/api/legacy/import", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = legacyScanSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "请提供旧知识库 data 目录路径。" });
    try {
      const result = await importLegacyAsDraftPackage(options.db, dataDir, parsed.data.path);
      return { ...result, detail: await service.getPackageDetail(result.package.packageId) };
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "导入失败。" }); }
  });

  app.addHook("onClose", async () => { await options.db.close(); });
  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate(request: FastifyRequest): Promise<void>;
  }
}
