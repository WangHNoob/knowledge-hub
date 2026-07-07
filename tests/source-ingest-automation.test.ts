import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { buildApp, type BuildAppOptions } from "../src/server/app";
import { createDatabase } from "../src/server/db";
import { createSourceBundleService } from "../src/server/services/sourceBundleService";
import type { DatabaseHandle } from "../src/server/types";
import { TEST_DATABASE_URL } from "./helpers/testEnv";

describe("source ingest automation (upload → auto build/publish)", () => {
  let db: DatabaseHandle;
  let schema: string;
  let dir: string;
  let opts: BuildAppOptions;

  beforeAll(async () => {
    schema = `test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    db = await createDatabase({ databaseUrl: TEST_DATABASE_URL, schema });
    dir = mkdtempSync(join(tmpdir(), "kh-ingest-"));
    opts = {
      db,
      jwtSecret: "test-secret",
      dataDir: dir,
      closeDatabaseOnClose: false,
      enableSourceIngestAutomation: true,
    };
  });

  afterAll(async () => {
    await db.close();
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  async function buildRunCount(): Promise<number> {
    const { rows } = await db.adapter.query(
      "SELECT count(*)::int AS n FROM knowledge_build_runs WHERE project_id = 'default_project'",
    );
    return Number(rows[0]?.n ?? 0);
  }

  async function waitForBuildRuns(target: number, timeoutMs = 8000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let count = await buildRunCount();
    while (count < target && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      count = await buildRunCount();
    }
    return count;
  }

  it("auto-starts a build run when a new source version is imported with changes", async () => {
    // 注册了 ingest automation 的 app 必须先建好，才能监听 source.version_imported。
    const app = await buildApp(opts);
    try {
      expect(await buildRunCount()).toBe(0);

      const sourceRoot = join(dir, "ingest-src-1");
      mkdirSync(join(sourceRoot, "gamedocs"), { recursive: true });
      writeFileSync(join(sourceRoot, "gamedocs", "hero.md"), "# Hero\n\nInitial ingest content.");
      await createSourceBundleService(db, dir).importDirectoryAsVersion({
        rootPath: sourceRoot,
        bundleId: "default",
        createdBy: "admin",
        note: "ingest v1",
      });

      // 上传即触发：ingest automation 异步调用 flywheel.sync → startBuild，应出现 1 个构建 run。
      expect(await waitForBuildRuns(1)).toBe(1);

      // 可审计：上传触发事件必须进入平台自动化历史（flywheel-events）。
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin", password: "adminpw" },
      });
      const token = login.json<{ token: string }>().token;
      const evs = await app.inject({
        method: "GET",
        url: "/api/agent/flywheel-events",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(evs.statusCode).toBe(200);
      expect(
        evs.json<{ events: Array<{ eventType: string }> }>().events.some((e) => e.eventType === "source.version_imported"),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("skips auto build when a re-import produces no changes", async () => {
    const app = await buildApp(opts);
    try {
      const before = await buildRunCount();

      // 相同内容重导：新版本行会创建，但相对上一版本无变更（changedFileCount=0），应跳过构建。
      const sourceRoot = join(dir, "ingest-src-2");
      mkdirSync(join(sourceRoot, "gamedocs"), { recursive: true });
      writeFileSync(join(sourceRoot, "gamedocs", "hero.md"), "# Hero\n\nInitial ingest content.");
      await createSourceBundleService(db, dir).importDirectoryAsVersion({
        rootPath: sourceRoot,
        bundleId: "default",
        createdBy: "admin",
        note: "ingest v2 (identical)",
      });

      // 给异步监听器一点时间；不应产生新的构建 run。
      await new Promise((r) => setTimeout(r, 600));
      expect(await buildRunCount()).toBe(before);
    } finally {
      await app.close();
    }
  });
});
