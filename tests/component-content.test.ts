import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import { createDatabase } from "../src/server/db";
import { createKnowledgeQueryService } from "../src/server/services/knowledgeQueryService";
import type { DatabaseHandle } from "../src/server/types";
import { TEST_DATABASE_URL } from "./helpers/testEnv";

let dir: string;
let db: DatabaseHandle;
let schema: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "kh-content-"));
  schema = `test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  db = await createDatabase({ databaseUrl: TEST_DATABASE_URL, schema, seedUsers: true });
});

afterEach(async () => {
  try { await db.close(); } catch { /* app.close may have already closed the pool */ }
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  try {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await pool.end();
  }
  rmSync(dir, { recursive: true, force: true });
});

async function insertPackageWithComponent(opts: { runId: string; storageUri: string }) {
  await db.adapter.query(
    `INSERT INTO asset_packages (package_id, name, kind, status, description, created_by_run_id, source_version_ids, legacy_paths, quality_summary, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    ["pkg_t", "t", "kb_builder_pipeline", "draft", "", opts.runId, "[]", "[]", "{}", new Date().toISOString()],
  );
  await db.adapter.query(
    `INSERT INTO asset_components (component_id, package_id, artifact_id, group_name, kind, title, status, legacy_path, storage_uri, source_refs, quality)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    ["cmp_t", "pkg_t", "art_t", "wiki", "wiki_page", "成就", "draft", "wiki/systems/成就.md", opts.storageUri, "[]", "{}"],
  );
}

describe("getComponentFile", () => {
  it("returns file content for a component in its run workspace", async () => {
    const runId = "run_test_0001";
    const fileAbs = path.join(dir, "kb-build-runs", runId, "data", "wiki", "systems", "成就.md");
    mkdirSync(path.dirname(fileAbs), { recursive: true });
    writeFileSync(fileAbs, "# 成就系统\nhello", "utf8");
    await insertPackageWithComponent({ runId, storageUri: "data/wiki/systems/成就.md" });

    const svc = createKnowledgeQueryService(db, dir);
    const result = await svc.getComponentFile("pkg_t", "cmp_t");
    expect(result.kind).toBe("wiki_page");
    expect(result.legacyPath).toBe("wiki/systems/成就.md");
    expect(result.content).toContain("成就系统");
    expect(result.truncated).toBe(false);
  });

  it("rejects a component that does not belong to the package", async () => {
    await insertPackageWithComponent({ runId: "run_x", storageUri: "data/wiki/x.md" });
    const svc = createKnowledgeQueryService(db, dir);
    await expect(svc.getComponentFile("pkg_other", "cmp_t")).rejects.toThrow(/not found|unknown/i);
  });

  it("rejects legacy:// components", async () => {
    await insertPackageWithComponent({ runId: "run_x", storageUri: "legacy://wiki/x.md" });
    const svc = createKnowledgeQueryService(db, dir);
    await expect(svc.getComponentFile("pkg_t", "cmp_t")).rejects.toThrow(/legacy/i);
  });
});

import { buildApp } from "../src/server/app";

describe("GET /api/packages/:packageId/components/:componentId/content", () => {
  async function tokenFor(app: Awaited<ReturnType<typeof buildApp>>) {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "adminpw" } });
    return JSON.parse(res.body).token as string;
  }

  it("serves component content via HTTP", async () => {
    const runId = "run_http_0001";
    const fileAbs = path.join(dir, "kb-build-runs", runId, "data", "wiki", "systems", "成就.md");
    mkdirSync(path.dirname(fileAbs), { recursive: true });
    writeFileSync(fileAbs, "# 成就系统", "utf8");
    await insertPackageWithComponent({ runId, storageUri: "data/wiki/systems/成就.md" });

    const app = await buildApp({ db, dataDir: dir, jwtSecret: "test-secret" });
    const token = await tokenFor(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/packages/pkg_t/components/cmp_t/content",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).content).toContain("成就系统");
    await app.close();
  });

  it("returns 404 for unknown component", async () => {
    await insertPackageWithComponent({ runId: "run_x", storageUri: "data/wiki/x.md" });
    const app = await buildApp({ db, dataDir: dir, jwtSecret: "test-secret" });
    const token = await tokenFor(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/packages/pkg_t/components/nope/content",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
