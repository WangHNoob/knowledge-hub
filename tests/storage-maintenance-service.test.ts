import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";

import { buildApp } from "../src/server/app";
import { createDatabase } from "../src/server/db";
import { createStorageMaintenanceService } from "../src/server/services/storageMaintenanceService";
import { createTestDb, type TestDbHandle } from "./helpers/testDb";
import { TEST_DATABASE_URL } from "./helpers/testEnv";

function touch(path: string, content = "x"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

async function insertPackage(db: TestDbHandle["db"], packageId: string, runId: string): Promise<void> {
  await db.adapter.query(
    `INSERT INTO asset_packages
      (package_id, name, kind, status, description, created_by_run_id, source_version_ids, legacy_paths, quality_summary, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [packageId, packageId, "kb_builder_pipeline", "draft", "fixture", runId, "[]", "[]", "{}", new Date().toISOString()]
  );
}

describe("StorageMaintenanceService", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  async function setup() {
    const handle = await createTestDb();
    const dataDir = mkdtempSync(join(tmpdir(), "kh-storage-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    cleanups.push(() => handle.cleanup());
    return { db: handle.db, dataDir };
  }

  it("keeps run dirs backed by a package and reclaims orphan run dirs", async () => {
    const { db, dataDir } = await setup();
    touch(join(dataDir, "kb-build-runs", "run_live", "data", "wiki", "a.md"));
    touch(join(dataDir, "kb-build-runs", "run_orphan", "data", "b.md"));
    await insertPackage(db, "pkg_live", "run_live");

    const service = createStorageMaintenanceService(db, dataDir);
    const report = await service.scan();
    const runs = report.entries.filter((e) => e.category === "kb_build_runs");
    expect(runs.find((e) => e.key === "run_live")?.status).toBe("live");
    expect(runs.find((e) => e.key === "run_orphan")?.status).toBe("reclaimable");

    const result = await service.reclaim({ categories: ["kb_build_runs"] }, "admin");
    expect(result.deletedEntries).toBe(1);
    expect(existsSync(join(dataDir, "kb-build-runs", "run_orphan"))).toBe(false);
    expect(existsSync(join(dataDir, "kb-build-runs", "run_live"))).toBe(true);
  });

  it("reclaims web-imports staging older than the retention window", async () => {
    const { db, dataDir } = await setup();
    const oldMs = Date.now() - 100 * 60 * 60 * 1000;
    const newMs = Date.now();
    touch(join(dataDir, "web-imports", `${oldMs}-aaaaaa`, "f.txt"));
    touch(join(dataDir, "web-imports", `${newMs}-bbbbbb`, "f.txt"));

    const service = createStorageMaintenanceService(db, dataDir, undefined, { webImportRetentionHours: 24 });
    const report = await service.scan();
    const imports = report.entries.filter((e) => e.category === "web_imports");
    expect(imports.find((e) => e.key === `${oldMs}-aaaaaa`)?.status).toBe("reclaimable");
    expect(imports.find((e) => e.key === `${newMs}-bbbbbb`)?.status).toBe("live");

    await service.reclaim({ categories: ["web_imports"] }, "admin");
    expect(existsSync(join(dataDir, "web-imports", `${oldMs}-aaaaaa`))).toBe(false);
    expect(existsSync(join(dataDir, "web-imports", `${newMs}-bbbbbb`))).toBe(true);
  });

  it("reclaims release dirs with no matching release row", async () => {
    const { db, dataDir } = await setup();
    await db.adapter.query(
      "INSERT INTO releases (release_id, version, status) VALUES ($1,$2,$3)",
      ["rel_live", "2026.1", "published"]
    );
    touch(join(dataDir, "releases", "rel_live", "okf_bundle", "a.md"));
    touch(join(dataDir, "releases", "rel_orphan", "okf_bundle", "b.md"));

    const service = createStorageMaintenanceService(db, dataDir);
    const report = await service.scan();
    const releases = report.entries.filter((e) => e.category === "releases");
    expect(releases.find((e) => e.key === "rel_live")?.status).toBe("live");
    expect(releases.find((e) => e.key === "rel_orphan")?.status).toBe("reclaimable");

    await service.reclaim({ categories: ["releases"] }, "admin");
    expect(existsSync(join(dataDir, "releases", "rel_live"))).toBe(true);
    expect(existsSync(join(dataDir, "releases", "rel_orphan"))).toBe(false);
  });

  it("reclaims only filesystem-orphan blobs, never DB-referenced ones", async () => {
    const { db, dataDir } = await setup();
    const liveUri = "storage/blobs/ab/abdeadbeef.md";
    await db.adapter.query(
      "INSERT INTO source_blobs (content_hash, byte_size, storage_uri, first_seen_at) VALUES ($1,$2,$3,$4)",
      ["sha256:abdeadbeef", 4, liveUri, new Date().toISOString()]
    );
    touch(join(dataDir, "storage", "blobs", "ab", "abdeadbeef.md"), "live");
    touch(join(dataDir, "storage", "blobs", "cd", "cdfeedface.md"), "stray");

    const service = createStorageMaintenanceService(db, dataDir);
    const report = await service.scan();
    const blobs = report.entries.filter((e) => e.category === "blobs");
    expect(blobs).toHaveLength(1);
    expect(blobs[0].key).toBe("cd/cdfeedface.md");
    expect(blobs[0].status).toBe("reclaimable");

    await service.reclaim({ categories: ["blobs"] }, "admin");
    expect(existsSync(join(dataDir, "storage", "blobs", "ab", "abdeadbeef.md"))).toBe(true);
    expect(existsSync(join(dataDir, "storage", "blobs", "cd", "cdfeedface.md"))).toBe(false);
  });

  it("classifies logs by retention but keeps today's file", async () => {
    const { db, dataDir } = await setup();
    const today = new Date().toISOString().slice(0, 10);
    touch(join(dataDir, "logs", "2020-01-01.jsonl"), "{}\n");
    touch(join(dataDir, "logs", `${today}.jsonl`), "{}\n");

    const service = createStorageMaintenanceService(db, dataDir, undefined, { logRetentionDays: 14 });
    const report = await service.scan();
    const logs = report.entries.filter((e) => e.category === "logs");
    expect(logs.find((e) => e.key === "2020-01-01.jsonl")?.status).toBe("reclaimable");
    expect(logs.find((e) => e.key === `${today}.jsonl`)?.status).toBe("live");
  });

  it("overview aggregates reclaimable bytes per category", async () => {
    const { db, dataDir } = await setup();
    touch(join(dataDir, "kb-build-runs", "run_orphan", "data", "b.md"), "hello");
    const service = createStorageMaintenanceService(db, dataDir);
    const overview = await service.overview();
    const runs = overview.categories.find((c) => c.category === "kb_build_runs");
    expect(runs?.reclaimableEntries).toBe(1);
    expect(overview.reclaimableBytes).toBeGreaterThan(0);
  });
});

describe("storage routes", () => {
  let db: TestDbHandle["db"];
  let schema: string;
  let dir: string;

  afterEach(async () => {
    if (db) await db.close();
    if (schema) {
      const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function token(app: Awaited<ReturnType<typeof buildApp>>, username: string, password: string) {
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
    return login.json<{ token: string }>().token;
  }

  it("guards reclaim by admin role and exposes overview", async () => {
    schema = `test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    db = await createDatabase({ databaseUrl: TEST_DATABASE_URL, schema });
    dir = mkdtempSync(join(tmpdir(), "kh-storage-api-"));
    const app = await buildApp({ db, jwtSecret: "test-secret", dataDir: dir });

    const adminToken = await token(app, "admin", "adminpw");
    const viewerToken = await token(app, "viewer", "viewpw");

    const denied = await app.inject({
      method: "POST",
      url: "/api/storage/reclaim",
      headers: { authorization: `Bearer ${viewerToken}` },
      payload: { categories: ["web_imports"] }
    });
    expect(denied.statusCode).toBe(403);

    const ok = await app.inject({
      method: "POST",
      url: "/api/storage/reclaim",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { categories: ["web_imports"] }
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().result.deletedEntries).toBe(0);

    const overview = await app.inject({
      method: "GET",
      url: "/api/storage/overview",
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(overview.statusCode).toBe(200);
    expect(Array.isArray(overview.json().overview.categories)).toBe(true);
  });
});
