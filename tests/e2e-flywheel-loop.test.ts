import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { buildApp, type BuildAppOptions } from "../src/server/app";
import { createDatabase } from "../src/server/db";
import { createSourceBundleService } from "../src/server/services/sourceBundleService";
import { createKnowledgeQueryService } from "../src/server/services/knowledgeQueryService";
import { createProjectService } from "../src/server/services/projectService";
import { runHealthSweepOnce } from "../src/server/services/healthSweepScheduler";
import type { DatabaseHandle } from "../src/server/types";
import { TEST_DATABASE_URL } from "./helpers/testEnv";

/**
 * 端到端验证目标核心闭环（全程确定性构建，无外部 LLM）：
 *   策划上传新资料 →（自动）增量构建 →（自动）lint/发布 → Agent 消费已发布版本
 *   → 周期性健康巡检记录可审计事件。
 * 首个发布无 parent，publishCompletedBuild 以 autoMode=false 发布，不走自动发布资格门禁，
 * 因此确定性可发布成功。
 */
describe("end-to-end automated flywheel (goal loop)", () => {
  let db: DatabaseHandle;
  let schema: string;
  let dir: string;
  let opts: BuildAppOptions;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    // 强制确定性构建：清掉 LLM 环境变量，resolveBuildModelConfig 回退到 deterministic，
    // 使端到端流程不依赖外部模型、可复现。
    for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    schema = `test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    db = await createDatabase({ databaseUrl: TEST_DATABASE_URL, schema });
    dir = mkdtempSync(join(tmpdir(), "kh-e2e-"));
    opts = {
      db,
      jwtSecret: "test-secret",
      dataDir: dir,
      closeDatabaseOnClose: false,
      // 上传即流转开启；健康巡检定时器不启动（测试内手动跑一次 runHealthSweepOnce）。
      enableSourceIngestAutomation: true,
    };
  });

  afterAll(async () => {
    await db.close();
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function waitForEvent(eventType: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { rows } = await db.adapter.query(
        `SELECT entity_id FROM knowledge_events
         WHERE project_id = 'default_project' AND event_type = $1
         ORDER BY created_at DESC LIMIT 1`,
        [eventType],
      );
      if (rows.length > 0) return String(rows[0].entity_id ?? "");
      await new Promise((r) => setTimeout(r, 150));
    }
    return "";
  }

  it("upload → auto build → auto publish → agent consume → periodic health audit", async () => {
    const app = await buildApp(opts);
    try {
      // 1) 策划上传新资料版本（触发上传即流转）。
      const sourceRoot = join(dir, "e2e-src");
      mkdirSync(join(sourceRoot, "gamedocs"), { recursive: true });
      writeFileSync(join(sourceRoot, "gamedocs", "hero.md"), "# Hero\n\nStamina controls skill usage in battle.");
      await createSourceBundleService(db, dir).importDirectoryAsVersion({
        rootPath: sourceRoot,
        bundleId: "default",
        createdBy: "admin",
        note: "e2e ingest",
      });

      // 2) 自动增量构建完成。
      const buildRunId = await waitForEvent("build.completed", 40000);
      expect(buildRunId).toBeTruthy();

      // 3) 自动发布（首个发布确定性成功）。
      const publishedReleaseId = await waitForEvent("release.auto_publish_succeeded", 20000);
      expect(publishedReleaseId).toBeTruthy();

      // 4) Agent 消费已发布版本：当前发布可读、页面可列。
      const queryService = createKnowledgeQueryService(db, dir);
      const release = await queryService.runTool("kb_get_release", {}, { sessionId: "e2e-agent" });
      expect(release.result).toBeTruthy();
      const pages = await queryService.runTool("kb_list_pages", {}, { sessionId: "e2e-agent" });
      expect(pages.result).toBeTruthy();

      // 5) 周期性健康巡检：对已发布项目巡检并落可审计事件。
      const projectService = createProjectService(db);
      const sweep = await runHealthSweepOnce({ projectService, queryService });
      expect(sweep.find((r) => r.projectId === "default_project")).toBeDefined();
      const { rows } = await db.adapter.query(
        "SELECT count(*)::int AS n FROM knowledge_events WHERE project_id = 'default_project' AND event_type = 'knowledge_lint.health_checked'",
      );
      expect(Number(rows[0]?.n ?? 0)).toBeGreaterThanOrEqual(1);
    } finally {
      await app.close();
    }
  }, 70000);
});
