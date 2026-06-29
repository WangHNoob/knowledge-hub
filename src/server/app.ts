import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import { config } from "./config";
import { createDiagnosticLogger, type DiagnosticLogger } from "./services/diagnosticService";
import { createKbBuilderPipelineService } from "./services/kbBuilderService";
import { createKnowledgeQueryService } from "./services/knowledgeQueryService";
import { createKnowledgeService } from "./services/knowledgeService";
import { createLegislationService } from "./services/legislationService";
import { createAttributionAuditService } from "./services/attributionAuditService";
import { createReleaseService } from "./services/releaseService";
import { registerReleaseAutomation } from "./services/releaseAutomationService";
import { createSourceBundleService } from "./services/sourceBundleService";
import { createStorageMaintenanceService } from "./services/storageMaintenanceService";
import { registerAgentRoutes } from "./routes/agent";
import { registerAuthRoutes } from "./routes/auth";
import { registerBuilderRoutes } from "./routes/builder";
import { registerDashboardRoutes } from "./routes/dashboard";
import { registerDiagnosticsRoutes } from "./routes/diagnostics";
import { registerLegacyRoutes } from "./routes/legacy";
import { registerLegislationRoutes } from "./routes/legislation";
import { registerMcpRoutes } from "./routes/mcp";
import { registerPackageRoutes } from "./routes/packages";
import { registerQualityRoutes } from "./routes/quality";
import { registerReleaseRoutes } from "./routes/releases";
import { registerReviewRoutes } from "./routes/review";
import { registerSearchRoutes } from "./routes/search";
import { registerSourceRoutes } from "./routes/sources";
import { registerStorageRoutes } from "./routes/storage";
import { registerTableAliasRoutes } from "./routes/tableAliases";
import type { RouteContext } from "./routes/context";
import type { DatabaseHandle, UserRecord } from "./types";

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

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const dataDir = options.dataDir ?? process.cwd();
  const diagnostics = options.diagnosticLogger ?? createDiagnosticLogger(options.db, dataDir, {
    level: config.logLevel,
    retentionDays: config.logRetentionDays,
    logToFile: config.logToFile,
    logToDb: config.logToDb
  });
  const ctx: RouteContext = {
    db: options.db,
    dataDir,
    diagnostics,
    service: createKnowledgeService(options.db),
    bundleService: createSourceBundleService(options.db, dataDir),
    kbBuilderService: createKbBuilderPipelineService(options.db, dataDir, diagnostics),
    releaseService: createReleaseService(options.db, dataDir, diagnostics),
    queryService: createKnowledgeQueryService(options.db, dataDir, diagnostics),
    legislationService: createLegislationService(options.db),
    attributionAuditService: createAttributionAuditService(options.db),
    storageService: createStorageMaintenanceService(options.db, dataDir, diagnostics, {
      webImportRetentionHours: config.webImportRetentionHours,
      logRetentionDays: config.logRetentionDays
    })
  };
  const unsubscribeReleaseAutomation = registerReleaseAutomation({
    releaseService: ctx.releaseService,
    diagnostics,
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(jwt, { secret: options.jwtSecret });
  await app.register(multipart, {
    preservePath: true,
    limits: {
      fileSize: config.uploadMaxFileBytes,
      files: config.uploadMaxFiles,
      fields: config.uploadMaxFields,
      parts: config.uploadMaxParts
    }
  });
  app.decorate("authenticate", async (request: FastifyRequest) => {
    await request.jwtVerify();
  });

  registerTracing(app, diagnostics);

  registerAuthRoutes(app, ctx);
  registerDashboardRoutes(app, ctx);
  registerSourceRoutes(app, ctx);
  registerBuilderRoutes(app, ctx);
  registerPackageRoutes(app, ctx);
  registerReviewRoutes(app, ctx);
  registerQualityRoutes(app, ctx);
  registerLegislationRoutes(app, ctx);
  registerReleaseRoutes(app, ctx);
  registerMcpRoutes(app, ctx);
  registerAgentRoutes(app, ctx);
  registerDiagnosticsRoutes(app, ctx);
  registerLegacyRoutes(app, ctx);
  registerStorageRoutes(app, ctx);
  registerSearchRoutes(app, ctx);
  registerTableAliasRoutes(app, ctx);

  app.addHook("onClose", async () => {
    unsubscribeReleaseAutomation();
    await options.db.close();
  });
  return app;
}

function registerTracing(app: FastifyInstance, diagnostics: DiagnosticLogger): void {
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
