import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { createDatabase } from "../src/server/db";
import { importLegacyAsDraftPackage } from "../src/server/services/legacyImportService";
import { createKnowledgeService } from "../src/server/services/knowledgeService";
import type { DatabaseHandle } from "../src/server/types";

const TEST_URL = process.env.KH_TEST_DATABASE_URL || "postgres://postgres:whbwhb2026@127.0.0.1:5432/knowledge_hub_test";

describe("legacy import service", () => {
  let dir: string;
  let db: DatabaseHandle;
  let schema: string;

  beforeAll(async () => {
    schema = `test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    db = await createDatabase({ databaseUrl: TEST_URL, schema, seedUsers: false });
    dir = mkdtempSync(join(tmpdir(), "kh-legacy-"));
  });

  afterAll(async () => {
    await db.close();
    const pool = new pg.Pool({ connectionString: TEST_URL });
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("imports a legacy scan as a draft asset package with grouped components", async () => {
    const legacy = join(dir, "fixture-1");
    buildLegacyFixture(legacy);

    const result = await importLegacyAsDraftPackage(db, dir, legacy);
    const service = createKnowledgeService(db);
    const detail = await service.getPackageDetail(result.package.packageId);

    expect(result.created).toBe(true);
    expect(result.importedSources).toBe(2);
    expect(result.createdComponents).toBe(5);
    expect(detail.package.status).toBe("draft");
    expect(detail.components.map((c) => c.group).sort()).toEqual([
      "graph", "index", "table", "wiki", "wiki"
    ]);
  });

  it("is idempotent when importing the same legacy directory again", async () => {
    const legacy = join(dir, "fixture-2");
    buildLegacyFixture(legacy);

    const first = await importLegacyAsDraftPackage(db, dir, legacy);
    const second = await importLegacyAsDraftPackage(db, dir, legacy);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.package.packageId).toBe(first.package.packageId);
  });
});

function buildLegacyFixture(root: string): void {
  mkdirSync(join(root, "gamedocs"), { recursive: true });
  mkdirSync(join(root, "gamedata"), { recursive: true });
  mkdirSync(join(root, "wiki", "systems"), { recursive: true });
  mkdirSync(join(root, "wiki", "activities"), { recursive: true });
  mkdirSync(join(root, "wiki", "_meta"), { recursive: true });
  mkdirSync(join(root, "graph"), { recursive: true });
  mkdirSync(join(root, "tables"), { recursive: true });
  writeFileSync(join(root, "gamedocs", "equipment.docx"), "equipment source");
  writeFileSync(join(root, "gamedata", "items.xlsx"), "items source");
  writeFileSync(join(root, "wiki", "systems", "equipment.md"), "# Equipment");
  writeFileSync(join(root, "wiki", "activities", "summer.md"), "# Summer");
  writeFileSync(join(root, "wiki", "_meta", "topic_index.json"), "{}");
  writeFileSync(join(root, "graph", "knowledge_graph.json"), "{}");
  writeFileSync(join(root, "tables", "items.schema.json"), "{}");
}
