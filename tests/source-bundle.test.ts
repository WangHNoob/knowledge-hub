import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { createDatabase } from "../src/server/db";
import { createSourceBundleService } from "../src/server/services/sourceBundleService";
import type { DatabaseHandle } from "../src/server/types";
import { TEST_DATABASE_URL } from "./helpers/testEnv";

describe("source bundle service", () => {
  let dir: string;
  let raw: string;
  let db: DatabaseHandle;
  let schema: string;

  beforeAll(async () => {
    schema = `test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    db = await createDatabase({ databaseUrl: TEST_DATABASE_URL, schema, seedUsers: false });
    dir = mkdtempSync(join(tmpdir(), "kh-bundle-"));
    raw = join(dir, "raw");
    mkdirSync(join(raw, "gamedata"), { recursive: true });
    mkdirSync(join(raw, "gamedocs"), { recursive: true });
    writeFileSync(join(raw, "gamedata", "items.csv"), "id,name\n1,A\n2,B\n");
    writeFileSync(join(raw, "gamedata", "skills.csv"), "id,power\n1,10\n");
    writeFileSync(join(raw, "gamedocs", "combat.md"), "# Combat");
  });

  afterAll(async () => {
    await db.close();
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a versioned snapshot of gamedata + gamedocs", async () => {
    const service = createSourceBundleService(db, dir);
    const result = await service.importDirectoryAsVersion({ rootPath: raw, createdBy: "tester" });

    expect(result.version.fileCount).toBe(3);
    expect(result.version.addedCount).toBe(3);
    expect(result.version.modifiedCount).toBe(0);
    expect(result.version.removedCount).toBe(0);
    expect(result.newBlobCount).toBe(3);
    expect(result.version.versionId).toMatch(/^default_\d{8}_\d{6}_\d{3}_\d{4,}$/);

    const files = await service.listFiles(result.version.versionId);
    expect(files.map((f) => f.logicalPath).sort()).toEqual([
      "gamedata/items.csv",
      "gamedata/skills.csv",
      "gamedocs/combat.md"
    ]);
  });

  it("reuses blobs and reports zero modifications when re-importing the same tree", async () => {
    const service = createSourceBundleService(db, dir);
    const first = await service.importDirectoryAsVersion({ rootPath: raw, createdBy: "tester" });
    const second = await service.importDirectoryAsVersion({ rootPath: raw, createdBy: "tester" });

    expect(second.version.parentVersionId).toBe(first.version.versionId);
    expect(second.version.unchangedCount).toBe(3);
    expect(second.version.addedCount).toBe(0);
    expect(second.version.modifiedCount).toBe(0);
    expect(second.newBlobCount).toBe(0);

    const { rows: [blobRow] } = await db.adapter.query("SELECT COUNT(*)::int AS c FROM source_blobs");
    expect(blobRow.c).toBe(3);
  });

  it("detects added, modified and removed files between versions", async () => {
    const service = createSourceBundleService(db, dir);
    const first = await service.importDirectoryAsVersion({ rootPath: raw, createdBy: "tester" });

    writeFileSync(join(raw, "gamedata", "items.csv"), "id,name\n1,Apple\n2,Berry\n");
    writeFileSync(join(raw, "gamedocs", "events.md"), "# Events");
    unlinkSync(join(raw, "gamedata", "skills.csv"));

    const second = await service.importDirectoryAsVersion({ rootPath: raw, createdBy: "tester" });
    expect(second.version.fileCount).toBe(3);
    expect(second.version.addedCount).toBe(1);
    expect(second.version.modifiedCount).toBe(1);
    expect(second.version.removedCount).toBe(1);
    expect(second.version.unchangedCount).toBe(1);

    const changes = await service.diff(second.version.versionId);
    const kinds = changes.map((c) => `${c.kind}:${c.logicalPath}`).sort();
    expect(kinds).toEqual([
      "added:gamedocs/events.md",
      "modified:gamedata/items.csv",
      "removed:gamedata/skills.csv"
    ]);

    const restored = await service.readFile(first.version.versionId, "gamedata/skills.csv");
    expect(restored?.content.toString()).toBe("id,power\n1,10\n");
  });

  it("marks active source corrections as pending review when their source file drifts", async () => {
    const sourceRoot = join(dir, "drift");
    mkdirSync(join(sourceRoot, "gamedata"), { recursive: true });
    mkdirSync(join(sourceRoot, "gamedocs"), { recursive: true });
    writeFileSync(join(sourceRoot, "gamedata", "keep.csv"), "id,name\n1,A\n");
    writeFileSync(join(sourceRoot, "gamedocs", "combat.md"), "# Combat v1");

    const service = createSourceBundleService(db, dir);
    const first = await service.importDirectoryAsVersion({ rootPath: sourceRoot, createdBy: "tester" });
    const file = (await service.listFiles(first.version.versionId)).find((entry) => entry.logicalPath === "gamedocs/combat.md");
    expect(file).toBeTruthy();
    await db.adapter.query(
      `INSERT INTO source_corrections (
         correction_id, bundle_id, source_path, rule_id, page_type, fact_key,
         bound_source_hash, state, correct_value, component_id, package_id,
         example_id, task_id, created_by, created_at, updated_at
       )
       VALUES (
         'corr_drift','default','gamedocs/combat.md','wiki.required_fact','system','system_name',
         $1,'active','{"field":"system_name","value":"Combat"}',NULL,NULL,'','task_drift','tester',NOW(),NOW()
       )`,
      [file?.contentHash]
    );

    writeFileSync(join(sourceRoot, "gamedocs", "combat.md"), "# Combat v2");
    const second = await service.importDirectoryAsVersion({ rootPath: sourceRoot, createdBy: "tester" });

    const { rows } = await db.adapter.query("SELECT * FROM source_corrections WHERE correction_id = 'corr_drift'");
    expect(rows[0].state).toBe("pending_review");
    expect(rows[0].bound_source_hash).toBe(file?.contentHash);

    const events = await db.adapter.query(
      "SELECT * FROM knowledge_events WHERE event_type = 'source_correction.pending_review' AND entity_id = 'corr_drift'"
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].payload_json).toMatchObject({
      versionId: second.version.versionId,
      sourcePath: "gamedocs/combat.md",
      changeKind: "modified",
      previousHash: file?.contentHash,
      boundSourceHash: file?.contentHash
    });
  });

  it("dedupes identical content under different paths", async () => {
    const fresh = join(dir, "dedup");
    mkdirSync(join(fresh, "gamedata"), { recursive: true });
    mkdirSync(join(fresh, "gamedocs"), { recursive: true });
    writeFileSync(join(fresh, "gamedata", "a.txt"), "same");
    writeFileSync(join(fresh, "gamedocs", "b.txt"), "same");

    const service = createSourceBundleService(db, dir);
    const result = await service.importDirectoryAsVersion({ rootPath: fresh, createdBy: "tester" });

    expect(result.version.fileCount).toBe(2);
    expect(result.newBlobCount).toBeLessThanOrEqual(1);
  });

  it("rejects directories that lack gamedata/ and gamedocs/", async () => {
    const empty = join(dir, "empty");
    mkdirSync(empty, { recursive: true });
    const service = createSourceBundleService(db, dir);
    await expect(service.importDirectoryAsVersion({ rootPath: empty, createdBy: "tester" })).rejects.toThrow();
  });
});
