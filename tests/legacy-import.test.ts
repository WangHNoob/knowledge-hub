import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/server/db";
import { importLegacyAsDraftPackage } from "../src/server/services/legacyImportService";
import { createKnowledgeService } from "../src/server/services/knowledgeService";
import type { DatabaseHandle } from "../src/server/types";

describe("legacy import service", () => {
  let dir: string;
  let legacy: string;
  let db: DatabaseHandle | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "knowledge-hub-legacy-import-"));
    legacy = join(dir, "legacy-data");
    db = createDatabase({ dataDir: dir, seedUsers: false });
    buildLegacyFixture(legacy);
  });

  afterEach(() => {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("imports a legacy scan as a draft asset package with grouped components", () => {
    const result = importLegacyAsDraftPackage(db!, dir, legacy);
    const service = createKnowledgeService(db!);
    const detail = service.getPackageDetail(result.package.packageId);

    expect(result.created).toBe(true);
    expect(result.importedSources).toBe(2);
    expect(result.createdComponents).toBe(5);
    expect(detail.package.status).toBe("draft");
    expect(detail.package.sourceVersionIds).toHaveLength(2);
    expect(detail.components.map((component) => component.group).sort()).toEqual([
      "graph",
      "index",
      "table",
      "wiki",
      "wiki"
    ]);
    expect(detail.components.find((component) => component.group === "wiki")).toMatchObject({
      artifactId: expect.stringMatching(/^art_pkg_legacy_.*_wiki_/),
      legacyPath: expect.stringContaining("wiki/")
    });
  });

  it("is idempotent when importing the same legacy directory again", () => {
    const first = importLegacyAsDraftPackage(db!, dir, legacy);
    const second = importLegacyAsDraftPackage(db!, dir, legacy);
    const service = createKnowledgeService(db!);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.package.packageId).toBe(first.package.packageId);
    expect(service.listPackages()).toHaveLength(1);
    expect(service.listComponents({ packageId: first.package.packageId })).toHaveLength(5);
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
