import type { FastifyInstance } from "fastify";

import { normalizeModelConfig } from "../services/kbBuilder/modelConfig";
import { testModelConnectivity } from "../services/kbBuilder/modelConnectivity";
import { buildRequestSchema, modelConnectivitySchema } from "../schemas";
import { formatSseFrame } from "../services/sse";
import type { RouteContext } from "./context";

export function registerBuilderRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.post<{ Params: { bundleId: string; versionId: string } }>(
    "/api/source-bundles/:bundleId/versions/:versionId/build",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const parsed = buildRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid build payload." });
      const version = await ctx.bundleService.getVersion(request.params.versionId);
      if (!version || version.bundleId !== request.params.bundleId) {
        return reply.code(404).send({ error: "未找到该资料版本。" });
      }
      try {
        const run = await ctx.kbBuilderService.startBuild({
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

  app.get("/api/build-runs", { preHandler: app.authenticate }, async () => ({
    runs: await ctx.kbBuilderService.listRuns()
  }));

  app.get<{ Params: { runId: string } }>(
    "/api/build-runs/:runId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const run = await ctx.kbBuilderService.getRun(request.params.runId);
      return run ? { run } : reply.code(404).send({ error: "Unknown build run." });
    }
  );

  app.get<{ Params: { runId: string } }>(
    "/api/build-runs/:runId/stream",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { runId } = request.params;
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      reply.hijack();

      // 1) replay history for this run (ascending), capped
      const history = await ctx.diagnostics.listLogs({ runId, limit: 500 });
      for (const record of history.reverse()) {
        reply.raw.write(formatSseFrame(record));
      }

      // 2) live tail
      const isTerminal = (r: { runId: string; entityType: string; status: string }) =>
        r.runId === runId && r.entityType === "build_run" && (r.status === "completed" || r.status === "failed");
      const unsubscribe = ctx.diagnostics.subscribe((record) => {
        if (record.runId !== runId) return;
        reply.raw.write(formatSseFrame(record));
        if (isTerminal(record)) {
          reply.raw.write(formatSseFrame({ runId }, "end"));
          cleanup();
        }
      });
      const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 15000);
      function cleanup() {
        clearInterval(heartbeat);
        unsubscribe();
        reply.raw.end();
      }
      request.raw.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
    }
  );

  app.post<{ Params: { runId: string } }>(
    "/api/build-runs/:runId/stop",
    { preHandler: app.authenticate },
    async (request, reply) => {
      try {
        return { run: await ctx.kbBuilderService.stopRun(request.params.runId, request.user.username) };
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
        return { deleted: await ctx.kbBuilderService.deleteRun(request.params.runId) };
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "删除构建记录失败。" });
      }
    }
  );

  app.post("/api/model-connectivity/test", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = modelConnectivitySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid model connectivity payload." });
    const modelConfig = normalizeModelConfig(parsed.data.modelConfig);
    const span = ctx.diagnostics.startSpan({
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
}
