import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { buildApp, type BuildAppOptions } from "../src/server/app";
import { createDatabase } from "../src/server/db";
import { createSourceBundleService } from "../src/server/services/sourceBundleService";
import { emitKnowledgeEvent } from "../src/server/services/eventService";
import type { DatabaseHandle } from "../src/server/types";
import { TEST_DATABASE_URL } from "./helpers/testEnv";

describe("flywheel ops console api", () => {
  let db: DatabaseHandle;
  let schema: string;
  let dir: string;
  let opts: BuildAppOptions;

  beforeAll(async () => {
    schema = `test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    db = await createDatabase({ databaseUrl: TEST_DATABASE_URL, schema });
    dir = mkdtempSync(join(tmpdir(), "kh-flywheel-"));
    opts = { db, jwtSecret: "test-secret", dataDir: dir };
  });

  afterAll(async () => {
    await db.close();
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  async function getToken(username = "admin", password = "adminpw") {
    const app = await buildApp(opts);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
    return { app, token: login.json<{ token: string }>().token };
  }

  it("requires authentication and reports idle status for an empty project", async () => {
    const { app, token } = await getToken();

    const denied = await app.inject({ method: "GET", url: "/api/flywheel/status" });
    expect(denied.statusCode).toBe(401);

    const status = await app.inject({
      method: "GET",
      url: "/api/flywheel/status",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(status.statusCode).toBe(200);
    const body = status.json();
    expect(body.state).toBe("idle");
    expect(body.primaryAction.action).toBe("open_sources");
    expect(body.metrics.pendingExceptions).toBe(0);
    expect(body.metrics.currentReleaseVersion).toBe("");
    expect(body.attentionItems).toEqual([]);

    const exceptions = await app.inject({
      method: "GET",
      url: "/api/flywheel/exceptions",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(exceptions.statusCode).toBe(200);
    expect(exceptions.json().exceptions).toEqual([]);
  });

  it("returns needs_attention when there is nothing to sync", async () => {
    const { app, token } = await getToken();
    const result = await app.inject({
      method: "POST",
      url: "/api/flywheel/sync",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(result.statusCode).toBe(202);
    expect(result.json().status).toBe("needs_attention");
    expect(result.json().message).toContain("资料版本");
  });

  it("denies sync for viewers", async () => {
    const viewer = await getToken("viewer", "viewpw");
    const denied = await viewer.app.inject({
      method: "POST",
      url: "/api/flywheel/sync",
      headers: { authorization: `Bearer ${viewer.token}` },
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
  });

  it("surfaces a skipped auto-publish as a blocking publish exception", async () => {
    const { app, token } = await getToken();
    await emitKnowledgeEvent(db, {
      eventType: "release.auto_publish_skipped",
      entityType: "release",
      entityId: "rel_test_skip",
      payload: {
        projectId: "default_project",
        releaseId: "rel_test_skip",
        reason: "存在待复核的确定性源覆盖，自动发布被拦截。",
      },
    });

    const exceptions = await app.inject({
      method: "GET",
      url: "/api/flywheel/exceptions",
      headers: { authorization: `Bearer ${token}` },
    });
    const items = exceptions.json().exceptions;
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("publish_blocker");
    expect(items[0].attentionLevel).toBe("blocking");
    expect(items[0].target.page).toBe("release");
    expect(items[0].technicalIds.releaseId).toBe("rel_test_skip");

    const status = await app.inject({
      method: "GET",
      url: "/api/flywheel/status",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(status.json().state).toBe("needs_attention");
    expect(status.json().primaryAction.action).toBe("open_exceptions");
    expect(status.json().metrics.pendingExceptions).toBe(1);
  });

  it("starts a build-and-publish run when syncing a project with a source version", async () => {
    const { app, token } = await getToken();
    const sourceRoot = join(dir, "sync-src");
    mkdirSync(join(sourceRoot, "gamedocs"), { recursive: true });
    writeFileSync(join(sourceRoot, "gamedocs", "hero.md"), "# Hero\n\nSync fixture content.");
    await createSourceBundleService(db, dir).importDirectoryAsVersion({
      rootPath: sourceRoot,
      bundleId: "default",
      createdBy: "admin",
      note: "sync fixture",
    });

    const result = await app.inject({
      method: "POST",
      url: "/api/flywheel/sync",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(result.statusCode).toBe(202);
    const body = result.json();
    expect(body.status).toBe("started");
    expect(body.buildRunIds).toHaveLength(1);
    expect(["incremental", "full"]).toContain(body.mode);
    expect(body.message).toContain("发布");
  });
});
