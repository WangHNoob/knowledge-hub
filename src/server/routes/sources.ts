import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import { createWriteStream, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import { browseLocalFilesSchema, importBundleSchema, updateBundleSchema, updateBundleVersionSchema } from "../schemas";
import { denyRole } from "../middleware/auth";
import type { RouteContext } from "./context";

export function registerSourceRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.get<{ Querystring: { path?: string } }>(
    "/api/local-files/browse",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const parsed = browseLocalFilesSchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid browse payload." });
      try {
        return browseLocalPath(parsed.data.path ?? ctx.dataDir);
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "读取本地目录失败。" });
      }
    }
  );

  app.get("/api/source-bundles", { preHandler: app.authenticate }, async () => ({
    bundles: await ctx.bundleService.listBundles()
  }));

  app.get<{ Params: { bundleId: string } }>(
    "/api/source-bundles/:bundleId/versions",
    { preHandler: app.authenticate },
    async (request) => ({ versions: await ctx.bundleService.listVersions(request.params.bundleId) })
  );

  app.patch<{ Params: { bundleId: string }; Body: z.infer<typeof updateBundleSchema> }>(
    "/api/source-bundles/:bundleId",
    { preHandler: [app.authenticate, denyRole("viewer")] },
    async (request, reply) => {
      const parsed = updateBundleSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid bundle update." });
      const updated = await ctx.bundleService.updateBundle(request.params.bundleId, parsed.data);
      if (!updated) return reply.code(404).send({ error: "未找到该资料集。" });
      return { bundle: updated };
    }
  );

  app.patch<{ Params: { bundleId: string; versionId: string }; Body: z.infer<typeof updateBundleVersionSchema> }>(
    "/api/source-bundles/:bundleId/versions/:versionId",
    { preHandler: [app.authenticate, denyRole("viewer")] },
    async (request, reply) => {
      const parsed = updateBundleVersionSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid version update." });
      const existing = await ctx.bundleService.getVersion(request.params.versionId);
      if (!existing || existing.bundleId !== request.params.bundleId) return reply.code(404).send({ error: "未找到该资料版本。" });
      const updated = await ctx.bundleService.updateVersion(request.params.versionId, parsed.data);
      if (!updated) return reply.code(404).send({ error: "未找到该资料版本。" });
      return { version: updated };
    }
  );

  app.get<{ Params: { bundleId: string; versionId: string } }>(
    "/api/source-bundles/:bundleId/versions/:versionId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const version = await ctx.bundleService.getVersion(request.params.versionId);
      if (!version || version.bundleId !== request.params.bundleId) {
        return reply.code(404).send({ error: "未找到该资料版本。" });
      }
      return {
        version,
        files: await ctx.bundleService.listFiles(version.versionId),
        changes: await ctx.bundleService.diff(version.versionId)
      };
    }
  );

  app.post<{ Params: { bundleId: string } }>(
    "/api/source-bundles/:bundleId/versions",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const parsed = importBundleSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "请提供 rootPath。" });
      const span = ctx.diagnostics.startSpan({
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
        const result = await ctx.bundleService.importDirectoryAsVersion({
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

  app.post<{ Params: { bundleId: string } }>(
    "/api/source-bundles/:bundleId/uploads",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const uploadRoot = join(ctx.dataDir, "web-imports", `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      const span = ctx.diagnostics.startSpan({
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
        const result = await ctx.bundleService.importDirectoryAsVersion({
          rootPath: uploadRoot,
          bundleId: request.params.bundleId,
          note,
          createdBy: request.user.username
        });
        await span.complete({ fileCount, versionId: result.version.versionId, totalBytes: result.version.totalBytes });
        return result;
      } catch (error) {
        await span.fail(error, { fileCount });
        return reply.code(400).send({ error: describeUploadError(error) });
      }
    }
  );
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

function describeUploadError(error: unknown): string {
  const record = typeof error === "object" && error !== null ? error as Record<string, unknown> : {};
  const code = typeof record.code === "string" ? record.code : "";
  const message = error instanceof Error ? error.message : String(error);
  if (code === "FST_REQ_FILE_TOO_LARGE" || message.toLowerCase().includes("file too large")) {
    return "上传文件过大。请调大 KH_UPLOAD_MAX_FILE_BYTES；如果前面有 Nginx/网关，还需要同步调大 client_max_body_size。";
  }
  if (message.toLowerCase().includes("request file too large")) {
    return "上传请求过大。请调大 KH_UPLOAD_MAX_FILE_BYTES；如果前面有 Nginx/网关，还需要同步调大 client_max_body_size。";
  }
  if (code === "FST_PARTS_LIMIT" || message.toLowerCase().includes("parts limit")) {
    return "上传文件数量过多。请调大 KH_UPLOAD_MAX_PARTS 和 KH_UPLOAD_MAX_FILES；如果一次上传目录特别大，建议分批上传。";
  }
  return error instanceof Error ? error.message : "上传导入失败。";
}
