import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";

import type { DatabaseHandle, UserRecord } from "./types";
import { importLegacyAsDraftPackage } from "./services/legacyImportService";
import { createKnowledgeService } from "./services/knowledgeService";
import { createKbBuilderPipelineService } from "./services/kbBuilderService";
import { normalizeModelConfig } from "./services/kbBuilder/modelConfig";
import { testModelConnectivity } from "./services/kbBuilder/modelConnectivity";
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

const pipelineStageSchema = z.enum(["convert", "extract", "tables", "graph", "viz"]);
const modelConfigSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("deterministic"),
    model: z.literal("deterministic").default("deterministic")
  }),
  z.object({
    provider: z.literal("openai-compatible"),
    baseUrl: z.string().url().default("https://api.openai.com/v1"),
    model: z.string().min(1),
    apiKey: z.string().min(1).optional()
  })
]);
const buildRequestSchema = z.object({
  stages: z.array(pipelineStageSchema).min(1).default(["convert", "extract", "tables", "graph", "viz"]),
  model: z.string().min(1).default("deterministic"),
  modelConfig: modelConfigSchema.optional(),
  force: z.boolean().default(false),
  only: z.string().min(1).nullable().default(null),
  qualityProfileId: z.string().min(1).default("default")
});

const qualityProfileUpdateSchema = z.object({
  config: z.object({
    minPackageScore: z.number().min(0).max(1),
    rules: z.record(z.string(), z.record(z.string(), z.unknown()))
  })
});

const modelConnectivitySchema = z.object({
  modelConfig: modelConfigSchema
});

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const service = createKnowledgeService(options.db);
  const dataDir = options.dataDir ?? process.cwd();
  const bundleService = createSourceBundleService(options.db, dataDir);
  const kbBuilderService = createKbBuilderPipelineService(options.db, dataDir);

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
  app.post<{ Params: { bundleId: string; versionId: string } }>(
    "/api/source-bundles/:bundleId/versions/:versionId/build",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const parsed = buildRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid build payload." });
      const version = await bundleService.getVersion(request.params.versionId);
      if (!version || version.bundleId !== request.params.bundleId) {
        return reply.code(404).send({ error: "未找到该资料版本。" });
      }
      try {
        const run = await kbBuilderService.startBuild({
          ...parsed.data,
          bundleId: request.params.bundleId,
          versionId: request.params.versionId,
          requestedBy: request.user.username
        });
        return reply.code(202).send({ run });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "构建失败。" });
      }
    }
  );

  // 资产包 / 审核 / 证据 / 发布 / Agent 反馈
  app.get("/api/packages", { preHandler: app.authenticate }, async () => ({ packages: await service.listPackages() }));
  app.get("/api/build-runs", { preHandler: app.authenticate }, async () => ({ runs: await kbBuilderService.listRuns() }));
  app.post("/api/model-connectivity/test", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = modelConnectivitySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid model connectivity payload." });
    return testModelConnectivity(normalizeModelConfig(parsed.data.modelConfig));
  });
  app.get<{ Params: { runId: string } }>(
    "/api/build-runs/:runId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const run = await kbBuilderService.getRun(request.params.runId);
      return run ? { run } : reply.code(404).send({ error: "Unknown build run." });
    }
  );
  app.get("/api/quality-gate/profile", { preHandler: app.authenticate }, async () => ({
    profile: await kbBuilderService.getActiveQualityProfile()
  }));
  app.put("/api/quality-gate/profile", { preHandler: app.authenticate }, async (request, reply) => {
    if (request.user.role !== "admin") {
      return reply.code(403).send({ error: "Only administrators can update quality gates." });
    }
    const parsed = qualityProfileUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid quality profile payload." });
    return { profile: await kbBuilderService.updateActiveQualityProfile(parsed.data.config, request.user.username) };
  });
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
