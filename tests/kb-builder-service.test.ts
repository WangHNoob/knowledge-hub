import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
            valuePreview: "{\"field\":\"config_table\",\"value\":\"Combat/Skill\"}",
            influence: "提示样例 · 补字段值",
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

  it("applies active source corrections as deterministic extraction overrides", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-service-data-"));
    const sourceRoot = mkdtempSync(join(tmpdir(), "kh-kb-service-src-"));
    const { db, cleanup } = await createTestDb();
    try {
      mkdirSync(join(sourceRoot, "gamedocs"), { recursive: true });
      mkdirSync(join(sourceRoot, "gamedata"), { recursive: true });
      writeFileSync(join(sourceRoot, "gamedata", "keep.csv"), "id,name\n1,A\n");
      writeFileSync(join(sourceRoot, "gamedocs", "battle.md"), [
        "---",
        "type: system",
        "title: Battle",
        "source: gamedocs/battle.md",
        "facts:",
        "  config_table: OldSkill",
        "---",
        "## Overview",
        "Battle rules."
      ].join("\n"));

      const sourceService = createSourceBundleService(db, dataDir);
      const imported = await sourceService.importDirectoryAsVersion({
        rootPath: sourceRoot,
        bundleId: "default",
        createdBy: "admin",
        note: "source correction fixture"
      });
      const sourceFile = (await sourceService.listFiles(imported.version.versionId)).find((file) => file.logicalPath === "gamedocs/battle.md");
      await db.adapter.query(
        `INSERT INTO source_corrections (
           correction_id, bundle_id, source_path, rule_id, page_type, fact_key,
           bound_source_hash, state, correct_value, component_id, package_id,
           example_id, task_id, created_by, created_at, updated_at
         )
         VALUES (
           'corr_extract_override','default','gamedocs/battle.md','wiki.required_fact','system','config_table',
           $1,'active',$2,NULL,NULL,'','task_extract_override','admin',NOW(),NOW()
         )`,
        [
          sourceFile?.contentHash ?? "",
          JSON.stringify({ setFacts: { config_table: "NewSkill", source: "人工修正" } })
        ],
      );

      const result = await createKbBuilderPipelineService(db, dataDir).build({
        bundleId: "default",
        versionId: imported.version.versionId,
        requestedBy: "admin",
        stages: ["convert", "extract"],
        model: "deterministic",
        force: true,
        only: null,
        qualityProfileId: "default"
      });

      const meta = JSON.parse(readFileSync(join(dataDir, "kb-build-runs", result.run.runId, "data", "wiki", "_meta", "battle.json"), "utf8"));
      expect(meta.facts).toMatchObject({ config_table: "NewSkill", source: "人工修正" });
      expect(result.run.config.flywheel).toMatchObject({
        annotationOverridesInjected: 1,
        annotationExampleRefs: [
          expect.objectContaining({
            exampleId: "corr_extract_override",
            ruleId: "wiki.required_fact",
            influence: expect.stringContaining("确定性覆盖 · 补 facts")
          })
        ]
      });
    } finally {
      await cleanup();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  }, 20000);

  it("does not inject inactive annotation examples", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-service-data-"));
    const sourceRoot = mkdtempSync(join(tmpdir(), "kh-kb-service-src-"));
    const { db, cleanup } = await createTestDb();
    try {
      mkdirSync(join(sourceRoot, "gamedocs"), { recursive: true });
      writeFileSync(join(sourceRoot, "gamedocs", "battle.md"), "# Battle\n\nBattle rules.");
      const imported = await createSourceBundleService(db, dataDir).importDirectoryAsVersion({
        rootPath: sourceRoot,
        bundleId: "default",
        createdBy: "admin",
        note: "inactive annotation fixture"
      });
      await db.adapter.query(
        `INSERT INTO asset_packages
          (package_id, name, kind, status, description, created_by_run_id, source_version_ids, legacy_paths, quality_summary, created_at)
         VALUES ('pkg_inactive_example','Inactive Example','kb_builder_pipeline','draft','fixture','run_inactive_example','[]','[]','{}',NOW())`
      );
      await db.adapter.query(
        `INSERT INTO asset_components
          (component_id, package_id, artifact_id, group_name, kind, title, status, legacy_path, storage_uri, source_refs, quality)
         VALUES ('cmp_inactive_example','pkg_inactive_example','wiki/prev.md','wiki','wiki_page','Previous','draft','wiki/prev.md','data/wiki/prev.md','[]','{}')`
      );
      await db.adapter.query(
        `INSERT INTO annotation_examples
          (example_id, package_id, component_id, task_id, rule_id, apply_mode, page_type, context_hash, context_snapshot, correct_value, active, created_by, created_at)
         VALUES ('ann_inactive_example','pkg_inactive_example','cmp_inactive_example','task_prev','wiki.required_fact','override','system','sha256:inactive','{}',$1,false,'admin',NOW())`,
        [JSON.stringify({ field: "config_table", value: "Combat/Skill" })],
      );

      const result = await createKbBuilderPipelineService(db, dataDir).build({
        bundleId: "default",
        versionId: imported.version.versionId,
        requestedBy: "admin",
        stages: ["convert", "extract"],
        model: "deterministic",
        force: false,
        only: null,
        qualityProfileId: "default"
      });

      expect(result.run.config.flywheel).toMatchObject({
        annotationExamplesInjected: 0,
        annotationOverridesInjected: 0,
        annotationExampleRefs: []
      });
    } finally {
      await cleanup();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  }, 20000);
});
