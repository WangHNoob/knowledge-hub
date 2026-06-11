import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { buildApp, type BuildAppOptions } from "../src/server/app";
import { createDatabase } from "../src/server/db";
import type { DatabaseHandle } from "../src/server/types";

const TEST_URL = process.env.KH_TEST_DATABASE_URL || "postgres://postgres:whbwhb2026@127.0.0.1:5432/knowledge_hub_test";

describe("knowledge hub api", () => {
  let db: DatabaseHandle;
  let schema: string;
  let dir: string;
  let opts: BuildAppOptions;

  beforeAll(async () => {
    schema = `test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    db = await createDatabase({ databaseUrl: TEST_URL, schema });
    dir = mkdtempSync(join(tmpdir(), "kh-api-"));
    opts = { db, jwtSecret: "test-secret", dataDir: dir };
  });

  afterAll(async () => {
    await db.close();
    const pool = new pg.Pool({ connectionString: TEST_URL });
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  async function getToken() {
    const app = await buildApp(opts);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "adminpw" }
    });
    const token = login.json<{ token: string }>().token;
    return { app, token };
  }

  it("requires login for knowledge endpoints and returns an empty dashboard after authentication", async () => {
    const { app, token } = await getToken();

    const denied = await app.inject({ method: "GET", url: "/api/dashboard" });
    expect(denied.statusCode).toBe(401);

    const dashboard = await app.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(dashboard.statusCode).toBe(200);
    const body = dashboard.json();
    expect(body.packages.total).toBe(0);
    expect(body.sources.bundles).toBe(1);
    expect(body.sources.versions).toBe(0);
    expect(body.sources.latest).toBeNull();
  });

  it("imports a legacy directory into a draft package through the api", async () => {
    const { app, token } = await getToken();
    const legacy = join(dir, "legacy-api-" + randomUUID().slice(0, 6));
    mkdirSync(join(legacy, "gamedocs"), { recursive: true });
    mkdirSync(join(legacy, "wiki", "systems"), { recursive: true });
    mkdirSync(join(legacy, "wiki", "_meta"), { recursive: true });
    writeFileSync(join(legacy, "gamedocs", "equipment.docx"), "equipment source");
    writeFileSync(join(legacy, "wiki", "systems", "equipment.md"), "# Equipment");
    writeFileSync(join(legacy, "wiki", "_meta", "topic_index.json"), "{}");

    const imported = await app.inject({
      method: "POST",
      url: "/api/legacy/import",
      headers: { authorization: `Bearer ${token}` },
      payload: { path: legacy }
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json().package.status).toBe("draft");
    expect(imported.json().createdComponents).toBe(2);
  });

  it("imports a gamedata/gamedocs directory as a versioned source bundle", async () => {
    const { app, token } = await getToken();
    const root = join(dir, "raw-v1");
    mkdirSync(join(root, "gamedata"), { recursive: true });
    mkdirSync(join(root, "gamedocs"), { recursive: true });
    writeFileSync(join(root, "gamedata", "items.csv"), "id,name\n1,A\n");
    writeFileSync(join(root, "gamedocs", "design.md"), "# Design");

    const created = await app.inject({
      method: "POST",
      url: "/api/source-bundles/default/versions",
      headers: { authorization: `Bearer ${token}` },
      payload: { rootPath: root, note: "initial" }
    });
    expect(created.statusCode).toBe(200);
    const result = created.json();
    expect(result.version.fileCount).toBe(2);
    expect(result.version.addedCount).toBe(2);
    expect(result.newBlobCount).toBe(2);

    const versions = await app.inject({
      method: "GET",
      url: "/api/source-bundles/default/versions",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(versions.json().versions).toHaveLength(1);
  });
});
