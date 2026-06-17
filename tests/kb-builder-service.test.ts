import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import xlsx from "xlsx";
import { createKnowledgeService } from "../src/server/services/knowledgeService";
import { createSourceBundleService } from "../src/server/services/sourceBundleService";
import { createKbBuilderPipelineService } from "../src/server/services/kbBuilderService";
import { createTestDb } from "./helpers/testDb";

describe("KbBuilderPipelineService", () => {
  it("builds one knowledge asset package from one source version", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-service-data-"));
    const sourceRoot = mkdtempSync(join(tmpdir(), "kh-kb-service-src-"));
    const { db, cleanup } = await createTestDb();
    try {
      mkdirSync(join(sourceRoot, "gamedocs"), { recursive: true });
      mkdirSync(join(sourceRoot, "gamedata", "Combat"), { recursive: true });
      writeFileSync(join(sourceRoot, "gamedocs", "battle.md"), [
        "---",
        "type: system",
        "title: Battle System",
        "source: gamedocs/battle.md",
        "facts:",
        "  config_table: Skill",
        "entities:",
        "  - name: Battle System",
        "    type: system",
        "  - name: Skill",
        "    type: table",
        "relationships:",
        "  - source: Battle System",
        "    relation: configured_in",
        "    target: Skill",
        "---",
        "## Overview",
        "Battle rules.",
        "## Data Dependencies",
        "Uses Skill."
      ].join("\n"));

      const workbook = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet([{ Id: 1, Name: "Slash" }]), "Skill");
      xlsx.writeFile(workbook, join(sourceRoot, "gamedata", "Combat", "Skill.xlsx"));

      const sourceService = createSourceBundleService(db, dataDir);
      const imported = await sourceService.importDirectoryAsVersion({
        rootPath: sourceRoot,
        bundleId: "default",
        createdBy: "admin",
        note: "pipeline fixture"
      });

      const result = await createKbBuilderPipelineService(db, dataDir).build({
        bundleId: "default",
        versionId: imported.version.versionId,
        requestedBy: "admin",
        stages: ["convert", "extract", "tables", "graph", "viz"],
        model: "deterministic",
        force: false,
        only: null,
        qualityProfileId: "default"
      });
      const detail = await createKnowledgeService(db).getPackageDetail(result.package.packageId);

      expect(result.package.kind).toBe("kb_builder_pipeline");
      expect(result.package.sourceVersionIds).toEqual([imported.version.versionId]);
      expect(result.package.createdByRunId).toBe(result.run.runId);
      expect(result.qualitySummary.overallScore).toBeGreaterThanOrEqual(0);
      expect(detail.components.map((component) => component.kind)).toEqual(expect.arrayContaining([
        "processed_doc",
        "wiki_page",
        "extract_meta",
        "table_schema_json",
        "table_registry",
        "graph_snapshot",
        "topic_index",
        "graph_view",
        "quality_report"
      ]));
    } finally {
      await cleanup();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  }, 20000);
});
