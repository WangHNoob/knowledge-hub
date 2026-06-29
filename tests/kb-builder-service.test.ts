import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import xlsx from "xlsx";
import { createKnowledgeService } from "../src/server/services/knowledgeService";
import { createSourceBundleService } from "../src/server/services/sourceBundleService";
import { createKbBuilderPipelineService } from "../src/server/services/kbBuilderService";
import { createTableAliasService } from "../src/server/services/tableAliasService";
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
      const aliasService = createTableAliasService(db);
      await aliasService.upsertMany([{ canonical: "Combat/Skill", aliases: ["技能表"] }], "admin", "manual");
      const imported = await sourceService.importDirectoryAsVersion({
        rootPath: sourceRoot,
        bundleId: "default",
        createdBy: "admin",
        note: "pipeline fixture"
      });
      await db.adapter.query(
        `INSERT INTO asset_packages
          (package_id, name, kind, status, description, created_by_run_id, source_version_ids, legacy_paths, quality_summary, created_at)
         VALUES ('pkg_prev_example','Previous Example','kb_builder_pipeline','draft','fixture','run_prev_example','[]','[]','{}',NOW())`
      );
      await db.adapter.query(
        `INSERT INTO asset_components
          (component_id, package_id, artifact_id, group_name, kind, title, status, legacy_path, storage_uri, source_refs, quality)
         VALUES ('cmp_prev_example','pkg_prev_example','wiki/prev.md','wiki','wiki_page','Previous','draft','wiki/prev.md','data/wiki/prev.md','[]','{}')`
      );
      await db.adapter.query(
        `INSERT INTO annotation_examples
          (example_id, package_id, component_id, task_id, rule_id, page_type, context_hash, context_snapshot, correct_value, created_by, created_at)
         VALUES ('ann_prev_example','pkg_prev_example','cmp_prev_example','task_prev','wiki.required_fact','system','sha256:prev','{}',$1,'admin',NOW())`,
        [JSON.stringify({ field: "config_table", value: "Combat/Skill" })],
      );

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
      const aliases = await aliasService.list();

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
      expect(detail.evidenceRecords.length).toBeGreaterThan(0);
      expect(detail.evidenceCoverage.evidenceRecords).toBeGreaterThan(0);
      expect(detail.evidenceCoverage.coverageRate).toBeGreaterThan(0);
      expect(detail.evidenceRecords.some((record) => record.quote.includes("gamedocs/battle.md"))).toBe(true);
      expect(aliases).toHaveLength(1);
      expect(aliases[0]).toMatchObject({ canonical: "Combat/Skill", aliases: ["技能表"] });
      expect(result.run.config.flywheel).toMatchObject({
        annotationExamplesInjected: 1,
        annotationExampleRefs: [
          {
            exampleId: "ann_prev_example",
            componentId: "cmp_prev_example",
            taskId: "task_prev",
            ruleId: "wiki.required_fact",
            pageType: "system",
            createdBy: "admin",
          }
        ]
      });
    } finally {
      await cleanup();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  }, 20000);

  it("records source file changes in the build run config for incremental rebuild planning", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-service-data-"));
    const sourceRoot = mkdtempSync(join(tmpdir(), "kh-kb-service-src-"));
    const { db, cleanup } = await createTestDb();
    try {
      mkdirSync(join(sourceRoot, "gamedocs"), { recursive: true });
      mkdirSync(join(sourceRoot, "gamedata"), { recursive: true });
      writeFileSync(join(sourceRoot, "gamedocs", "battle.md"), "# Battle\n\nBattle rules.");
      writeFileSync(join(sourceRoot, "gamedata", "Skill.csv"), "Id,Name\n1,Slash\n");

      const sourceService = createSourceBundleService(db, dataDir);
      await sourceService.importDirectoryAsVersion({
        rootPath: sourceRoot,
        bundleId: "default",
        createdBy: "admin",
        note: "base"
      });
      writeFileSync(join(sourceRoot, "gamedata", "Skill.csv"), "Id,Name\n1,Cleave\n");
      const imported = await sourceService.importDirectoryAsVersion({
        rootPath: sourceRoot,
        bundleId: "default",
        createdBy: "admin",
        note: "table patch"
      });

      const result = await createKbBuilderPipelineService(db, dataDir).build({
        bundleId: "default",
        versionId: imported.version.versionId,
        requestedBy: "admin",
        stages: ["tables"],
        model: "deterministic",
        force: false,
        only: null,
        qualityProfileId: "default"
      });

      expect(result.run.config.incremental).toMatchObject({
        parentVersionId: expect.any(String),
        changedPaths: ["gamedata/Skill.csv"],
        addedPaths: [],
        modifiedPaths: ["gamedata/Skill.csv"],
        removedPaths: []
      });
    } finally {
      await cleanup();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  }, 20000);
});
