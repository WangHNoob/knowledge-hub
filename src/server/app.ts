import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import bcrypt from "bcryptjs";
import { createWriteStream, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { z } from "zod";

import type { DatabaseHandle, UserRecord } from "./types";
import { config } from "./config";
import { createDiagnosticLogger, type DiagnosticLogger } from "./services/diagnosticService";
import { importLegacyAsDraftPackage } from "./services/legacyImportService";
import { createKnowledgeService } from "./services/knowledgeService";
import { createKnowledgeQueryService } from "./services/knowledgeQueryService";
import { createKbBuilderPipelineService } from "./services/kbBuilderService";
import { normalizeModelConfig } from "./services/kbBuilder/modelConfig";
import { testModelConnectivity } from "./services/kbBuilder/modelConnectivity";
import { scanLegacyKbBuilder } from "./services/legacyScanner";
import { createReleaseService } from "./services/releaseService";
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
  diagnosticLogger?: DiagnosticLogger;
}

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

const legacyScanSchema = z.object({
  path: z.string().min(1)
});

const browseLocalFilesSchema = z.object({
  path: z.string().min(1).optional()
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
  }),
  z.object({
    provider: z.literal("anthropic"),
    baseUrl: z.string().url().default("https://api.anthropic.com/v1"),
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

const createReleaseSchema = z.object({
  version: z.string().min(1),
  packageIds: z.array(z.string().min(1)).min(1)
});

const rollbackReleaseSchema = z.object({
  releaseId: z.string().min(1)
});

const mcpQuerySchema = z.object({
  toolName: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({})
});

const diagnosticLogQuerySchema = z.object({
  level: z.string().optional(),
  category: z.string().optional(),
  status: z.string().optional(),
  traceId: z.string().optional(),
  runId: z.string().optional(),
  releaseId: z.string().optional(),
  entityId: z.string().optional(),
  q: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional()
});

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const service = createKnowledgeService(options.db);
  const dataDir = options.dataDir ?? process.cwd();
  const diagnostics = options.diagnosticLogger ?? createDiagnosticLogger(options.db, dataDir, {
    level: config.logLevel,
    retentionDays: config.logRetentionDays,
    logToFile: config.logToFile,
    logToDb: config.logToDb
  });
  const bundleService = createSourceBundleService(options.db, dataDir);
  const kbBuilderService = createKbBuilderPipelineService(options.db, dataDir, diagnostics);
  const releaseService = createReleaseService(options.db, diagnostics);
  const queryService = createKnowledgeQueryService(options.db, dataDir, diagnostics);

  await app.register(cors, { origin: true, credentials: true });
  await app.register(jwt, { secret: options.jwtSecret });
  await app.register(multipart);
  app.decorate("authenticate", async (request: FastifyRequest) => {
    await request.jwtVerify();
  });
  app.addHook("onRequest", async (request, reply) => {
    request.traceId = typeof request.headers["x-trace-id"] === "string" ? request.headers["x-trace-id"] : diagnostics.traceId();
    reply.header("x-trace-id", request.traceId);
  });
  app.addHook("preHandler", async (request) => {
    const route = request.routeOptions.url ?? request.url.split("?")[0] ?? "";
    request.diagnosticSpan = diagnostics.startSpan({
      traceId: request.traceId,
      category: "http",
      message: `${request.method} ${route}`,
      route,
      method: request.method,
      requestPayload: request.body ?? {},
      context: { query: request.query, params: request.params }
    });
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (!request.diagnosticSpan) return payload;
    await request.diagnosticSpan.complete({
      statusCode: reply.statusCode,
      user: request.user?.username ?? "",
      role: request.user?.role ?? ""
    });
    return payload;
  });
  app.setErrorHandler(async (error, request, reply) => {
    const statusCode = typeof error === "object" && error && "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : 500;
    const message = error instanceof Error ? error.message : String(error);
    if (request.diagnosticSpan) {
      await request.diagnosticSpan.fail(error, {
        statusCode,
        user: request.user?.username ?? "",
        role: request.user?.role ?? ""
      });
    } else {
      await diagnostics.write({
        traceId: request.traceId,
        level: "error",
        category: "http",
        message: `${request.method} ${request.url} failed`,
        status: "failed",
        route: request.routeOptions.url ?? request.url.split("?")[0] ?? "",
        method: request.method,
        error
      });
    }
    return reply.code(statusCode).send({ error: message });
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
  app.get<{ Querystring: { path?: string } }>("/api/local-files/browse", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = browseLocalFilesSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid browse payload." });
    try {
      return browseLocalPath(parsed.data.path ?? dataDir);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "读取本地目录失败。" });
    }
  });

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
      const span = diagnostics.startSpan({
        traceId: request.traceId,
        category: "source_import",
        message: "import source directory",
        actor: request.user.username,
        entityType: "source_bundle",
        entityId: request.params.bundleId,
        requestPayload: parsed.data,
        context: { bundleId: request.params.bundleId, rootPath: parsed.data.rootPath }
      });
      try {
        const result = await bundleService.importDirectoryAsVersion({
          rootPath: parsed.data.rootPath,
          bundleId: parsed.data.bundleId ?? request.params.bundleId,
          note: parsed.data.note,
          createdBy: request.user.username
        });
        await span.complete({
          versionId: result.version.versionId,
          fileCount: result.version.fileCount,
          totalBytes: result.version.totalBytes
        });
        return result;
      } catch (error) {
        await span.fail(error);
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
          requestedBy: request.user.username,
          traceId: request.traceId
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
    const modelConfig = normalizeModelConfig(parsed.data.modelConfig);
    const span = diagnostics.startSpan({
      traceId: request.traceId,
      category: "llm",
      message: "test model connectivity",
      actor: request.user.username,
      requestPayload: { modelConfig },
      context: { provider: modelConfig.provider, model: modelConfig.model, baseUrl: "baseUrl" in modelConfig ? modelConfig.baseUrl : "" }
    });
    const result = await testModelConnectivity(modelConfig);
    if (result.ok) await span.complete({ ok: result.ok, message: result.message });
    else await span.fail(new Error(result.message), { ok: result.ok });
    return result;
  });
  app.get<{ Params: { runId: string } }>(
    "/api/build-runs/:runId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const run = await kbBuilderService.getRun(request.params.runId);
      return run ? { run } : reply.code(404).send({ error: "Unknown build run." });
    }
  );
  app.post<{ Params: { bundleId: string } }>(
    "/api/source-bundles/:bundleId/uploads",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const uploadRoot = join(dataDir, "web-imports", `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      const span = diagnostics.startSpan({
        traceId: request.traceId,
        category: "source_import",
        message: "upload source bundle",
        actor: request.user.username,
        entityType: "source_bundle",
        entityId: request.params.bundleId,
        context: { bundleId: request.params.bundleId, uploadRoot }
      });
      let note = "";
      let fileCount = 0;
      try {
        for await (const part of request.parts()) {
          if (part.type === "field") {
            if (part.fieldname === "note") note = String(part.value ?? "");
            continue;
          }
          const relativePath = safeUploadPath(part.filename);
          const target = join(uploadRoot, relativePath);
          mkdirSync(dirname(target), { recursive: true });
          await pipeline(part.file, createWriteStream(target));
          fileCount += 1;
        }
        if (fileCount === 0) {
          const error = new Error("请选择要导入的文件或目录。");
          await span.fail(error, { fileCount });
          return reply.code(400).send({ error: error.message });
        }
        const result = await bundleService.importDirectoryAsVersion({
          rootPath: uploadRoot,
          bundleId: request.params.bundleId,
          note,
          createdBy: request.user.username
        });
        await span.complete({ fileCount, versionId: result.version.versionId, totalBytes: result.version.totalBytes });
        return result;
      } catch (error) {
        await span.fail(error, { fileCount });
        return reply.code(400).send({ error: error instanceof Error ? error.message : "上传导入失败。" });
      }
    }
  );
  app.post<{ Params: { runId: string } }>(
    "/api/build-runs/:runId/stop",
    { preHandler: app.authenticate },
    async (request, reply) => {
      try {
        return { run: await kbBuilderService.stopRun(request.params.runId, request.user.username) };
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "停止构建失败。" });
      }
    }
  );
  app.delete<{ Params: { runId: string } }>(
    "/api/build-runs/:runId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      try {
        return { deleted: await kbBuilderService.deleteRun(request.params.runId) };
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "删除构建记录失败。" });
      }
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
  app.get("/api/releases/current", { preHandler: app.authenticate }, async () => ({
    release: await releaseService.getCurrent()
  }));
  app.post("/api/releases", { preHandler: app.authenticate }, async (request, reply) => {
    if (request.user.role !== "admin") {
      return reply.code(403).send({ error: "Only administrators can create releases." });
    }
    const parsed = createReleaseSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid release payload." });
    try {
      return {
        release: await releaseService.createDraft({
          ...parsed.data,
          requestedBy: request.user.username
        })
      };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "创建发布草案失败。" });
    }
  });
  app.post<{ Params: { releaseId: string } }>(
    "/api/releases/:releaseId/publish",
    { preHandler: app.authenticate },
    async (request, reply) => {
      if (request.user.role !== "admin") {
        return reply.code(403).send({ error: "Only administrators can publish releases." });
      }
      try {
        return { release: await releaseService.publish(request.params.releaseId, request.user.username) };
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "发布失败。" });
      }
    }
  );
  app.post("/api/releases/rollback", { preHandler: app.authenticate }, async (request, reply) => {
    if (request.user.role !== "admin") {
      return reply.code(403).send({ error: "Only administrators can rollback releases." });
    }
    const parsed = rollbackReleaseSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid rollback payload." });
    try {
      return { release: await releaseService.rollback(parsed.data.releaseId, request.user.username) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "回滚失败。" });
    }
  });
  app.get("/api/agent/events", { preHandler: app.authenticate }, async () => ({ events: await service.listAgentEvents() }));
  app.get("/api/mcp/audit", { preHandler: app.authenticate }, async () => ({ audit: await service.listMcpAudit() }));
  app.get<{ Querystring: z.infer<typeof diagnosticLogQuerySchema> }>(
    "/api/diagnostics/logs",
    { preHandler: app.authenticate },
    async (request, reply) => {
      if (request.user.role === "viewer") return reply.code(403).send({ error: "Only operators can view diagnostics." });
      const parsed = diagnosticLogQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid diagnostics query." });
      return { logs: await diagnostics.listLogs(parsed.data) };
    }
  );
  app.get<{ Params: { traceId: string } }>(
    "/api/diagnostics/logs/:traceId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      if (request.user.role === "viewer") return reply.code(403).send({ error: "Only operators can view diagnostics." });
      return { logs: await diagnostics.trace(request.params.traceId) };
    }
  );
  app.get(
    "/api/diagnostics/summary",
    { preHandler: app.authenticate },
    async (request, reply) => {
      if (request.user.role === "viewer") return reply.code(403).send({ error: "Only operators can view diagnostics." });
      return { summary: await diagnostics.summary() };
    }
  );
  app.post("/api/mcp/query", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = mcpQuerySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid MCP query payload." });
    try {
      return {
        envelope: await queryService.runTool(parsed.data.toolName, parsed.data.payload, {
          sessionId: `web:${request.user.username}`,
          agentRole: request.user.role,
          traceId: request.traceId
        })
      };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "MCP 查询失败。" });
    }
  });

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

function browseLocalPath(inputPath: string) {
  const target = resolve(inputPath);
  const stat = statSync(target);
  const dir = stat.isDirectory() ? target : dirname(target);
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .map((entry) => {
      const absolutePath = resolve(dir, entry.name);
      const entryStat = statSync(absolutePath);
      return {
        name: entry.name,
        path: absolutePath,
        kind: entry.isDirectory() ? "directory" : "file",
        size: entry.isDirectory() ? null : entryStat.size,
        modifiedAt: entryStat.mtime.toISOString()
      };
    })
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  return { path: dir, parentPath: dirname(dir) === dir ? null : dirname(dir), entries };
}

function safeUploadPath(filename: string): string {
  const normalized = filename.replace(/\\/g, "/").split("/").filter((part) => part && part !== "." && part !== "..");
  return normalized.join("/") || "upload.bin";
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate(request: FastifyRequest): Promise<void>;
  }
  interface FastifyRequest {
    traceId?: string;
    diagnosticSpan?: ReturnType<DiagnosticLogger["startSpan"]>;
  }
}
