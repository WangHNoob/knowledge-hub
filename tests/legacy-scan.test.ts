import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { scanLegacyKbBuilder } from "../src/server/services/legacyScanner";

describe("legacy kb-builder scanner", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "legacy-kb-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("summarizes legacy source, wiki, index, graph and table assets", () => {
    mkdirSync(join(dir, "gamedocs"), { recursive: true });
    mkdirSync(join(dir, "gamedata"), { recursive: true });
    mkdirSync(join(dir, "wiki", "systems"), { recursive: true });
    mkdirSync(join(dir, "wiki", "activities"), { recursive: true });
    mkdirSync(join(dir, "wiki", "_meta"), { recursive: true });
    mkdirSync(join(dir, "graph"), { recursive: true });
    mkdirSync(join(dir, "tables"), { recursive: true });

    writeFileSync(join(dir, "gamedocs", "equipment.docx"), "docx");
    writeFileSync(join(dir, "gamedata", "items.xlsx"), "xlsx");
    writeFileSync(join(dir, "wiki", "systems", "equipment.md"), "# Equipment");
    writeFileSync(join(dir, "wiki", "activities", "summer.md"), "# Summer");
    writeFileSync(join(dir, "wiki", "_meta", "topic_index.json"), "{}");
    writeFileSync(join(dir, "graph", "knowledge_graph.json"), "{}");
    writeFileSync(join(dir, "tables", "items.schema.json"), "{}");

    const summary = scanLegacyKbBuilder(dir);

    expect(summary.root).toBe(dir);
    expect(summary.sources.total).toBe(2);
    expect(summary.wiki.pages).toBe(2);
    expect(summary.index.files).toBe(1);
    expect(summary.graph.files).toBe(1);
    expect(summary.tables.files).toBe(1);
    expect(summary.recommendedPackageId).toMatch(/^pkg_legacy_/);
    expect(summary.warnings).toEqual([]);
  });

  it("reports missing expected legacy directories as warnings", () => {
    mkdirSync(join(dir, "wiki", "systems"), { recursive: true });
    writeFileSync(join(dir, "wiki", "systems", "equipment.md"), "# Equipment");

    const summary = scanLegacyKbBuilder(dir);

    expect(summary.wiki.pages).toBe(1);
    expect(summary.warnings).toContain("缺少 gamedocs/ 或 gamedata/，无法发现原始资料。");
    expect(summary.warnings).toContain("缺少 wiki/_meta/，无法发现旧索引资产。");
  });
});
