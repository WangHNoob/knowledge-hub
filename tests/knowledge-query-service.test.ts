import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createKnowledgeQueryService } from "../src/server/services/knowledgeQueryService";
import { createKnowledgeService } from "../src/server/services/knowledgeService";
import { createReleaseService } from "../src/server/services/releaseService";
import { createSourceBundleService } from "../src/server/services/sourceBundleService";
import { createTestDb, type TestDbHandle } from "./helpers/testDb";

describe("KnowledgeQueryService", () => {
  it("returns a clear error when no current release exists", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-query-empty-"));
    const { db, cleanup } = await createTestDb();
    try {
      const service = createKnowledgeQueryService(db, dataDir);
      await expect(service.runTool("kb_get_release", {}, { sessionId: "test", agentRole: "planner" }))
        .rejects.toThrow(/No current published release/i);
    } finally {
      await cleanup();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 15000);

  it("queries wiki, graph, table data, quality, evidence, and writes audit records", async () => {
    const fixture = await setupPublishedKnowledgeFixture();
    const service = createKnowledgeQueryService(fixture.db, fixture.dataDir);
    try {
      const release = await service.runTool("kb_get_release", {}, { sessionId: "test", agentRole: "planner" });
      expect(release.release.releaseId).toBe(fixture.releaseId);
      expect(release.result.version).toBe("query.1");

      const search = await service.runTool("kb_search", { query: "Battle stamina" }, { sessionId: "test", agentRole: "planner" });
      expect(search.result.items[0].title).toBe("Battle System");
      expect(search.trace.componentIds).toContain(fixture.pageComponentId);
      expect(search.trust.components[0].trust?.score).toBeGreaterThan(0);
      expect(search.result.items[0].trust?.version).toBe("v2-lite");
      expect(search.result.items[0].matchedFields).toContain("title");
      expect(search.result.items[0].why.length).toBeGreaterThan(0);
      expect(search.result.cards[0]).toMatchObject({
        title: "Battle System",
        componentId: fixture.pageComponentId,
        evidence: { count: 1, traceable: true, suggestedTool: "kb_get_evidence" }
      });
      expect(search.result.cards[0].suggestedNextTools).toEqual(expect.arrayContaining(["kb_get_page", "kb_get_evidence", "kb_get_quality"]));
      expect(search.result.guidance).toMatchObject({ status: "hit", topComponentId: fixture.pageComponentId });

      const page = await service.runTool("kb_get_page", { page: "Battle System" }, { sessionId: "test", agentRole: "planner" });
      expect(page.result.markdown).toContain("Stamina controls skill usage.");

      const section = await service.runTool("kb_get_section", { page: "Battle System", section: "Data Dependencies" }, { sessionId: "test", agentRole: "planner" });
      expect(section.result.markdown).toContain("Combat/Skill");

      const pageTables = await service.runTool("kb_get_page_tables", { page: "Battle System" }, { sessionId: "test", agentRole: "planner" });
      expect(pageTables.result.tables[0].table).toBe("Combat/Skill");

      const entity = await service.runTool("kb_get_entity", { entityId: "Battle System" }, { sessionId: "test", agentRole: "planner" });
      expect(entity.result.node.type).toBe("system");

      const neighbors = await service.runTool("kb_get_neighbors", { entityId: "Battle System" }, { sessionId: "test", agentRole: "planner" });
      expect(neighbors.result.edges[0].relation).toBe("configured_in");

      const schema = await service.runTool("kb_get_table_schema", { table: "Combat/Skill" }, { sessionId: "test", agentRole: "planner" });
      expect(schema.result.schema.fields).toContain("StaminaCost");

      const rows = await service.runTool("kb_query_table", { table: "Combat/Skill", limit: 2 }, { sessionId: "test", agentRole: "planner" });
      expect(rows.result.rows).toEqual([{ Id: 1, Name: "Slash", StaminaCost: 10 }]);

      const value = await service.runTool("kb_check_table_value", { table: "Combat/Skill", field: "Name", value: "Slash" }, { sessionId: "test", agentRole: "planner" });
      expect(value.result.matches[0].StaminaCost).toBe(10);

      const evidence = await service.runTool("kb_get_evidence", { componentId: fixture.pageComponentId }, { sessionId: "test", agentRole: "planner" });
      expect(evidence.result.records[0].quote).toContain("stamina");

      const evidenceByQuery = await service.runTool("kb_get_evidence", { query: "Battle stamina" }, { sessionId: "test", agentRole: "planner" });
      expect(evidenceByQuery.trace.componentIds).toContain(fixture.pageComponentId);
      expect(evidenceByQuery.trace.evidenceIds).toContain("ev_query_page");

      const { rows: auditRows } = await fixture.db.adapter.query("SELECT * FROM mcp_audit ORDER BY created_at");
      expect(auditRows.length).toBeGreaterThanOrEqual(9);
      expect(auditRows.at(-1)?.status).toBe("hit");
    } finally {
      await fixture.cleanup();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  }, 15000);

  it("resolves page tables from graph relations when markdown dependencies are translated", async () => {
    const fixture = await setupPublishedKnowledgeFixture({ dependencyText: "Uses 技能表." });
    const service = createKnowledgeQueryService(fixture.db, fixture.dataDir);
    try {
      const pageTables = await service.runTool("kb_get_page_tables", { page: "Battle System" }, { sessionId: "test", agentRole: "planner" });
      expect(pageTables.result.tables[0].table).toBe("Combat/Skill");
      expect(pageTables.trace.componentIds).toContain(fixture.pageComponentId);
    } finally {
      await fixture.cleanup();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  }, 15000);

  it("resolves page tables and schemas from OKF table aliases when graph links are missing", async () => {
    const fixture = await setupPublishedKnowledgeFixture({ dependencyText: "Uses 技能表.", withGraphRelation: false });
    const service = createKnowledgeQueryService(fixture.db, fixture.dataDir);
    try {
      const pageTables = await service.runTool("kb_get_page_tables", { page: "Battle System" }, { sessionId: "test", agentRole: "planner" });
      expect(pageTables.result.tables[0].table).toBe("Combat/Skill");

      const schema = await service.runTool("kb_get_table_schema", { table: "技能表" }, { sessionId: "test", agentRole: "planner" });
      expect(schema.result.found).toBe(true);
      expect(schema.result.schema.table_name).toBe("Combat/Skill");
    } finally {
      await fixture.cleanup();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  }, 15000);

  it("uses OKF search index intent expansion and table aliases for explainable hits", async () => {
    const fixture = await setupPublishedKnowledgeFixture({ dependencyText: "Uses 技能表." });
    const service = createKnowledgeQueryService(fixture.db, fixture.dataDir);
    try {
      const search = await service.runTool("kb_search", { query: "配置表" }, { sessionId: "test", agentRole: "planner" });
      expect(search.result.items[0].title).toBe("Battle System");
      expect(search.result.items[0].matchedFields).toEqual(expect.arrayContaining(["dataDependencies", "tables"]));
      expect(search.result.items[0].why.some((line: string) => line.includes("配置表意图扩展"))).toBe(true);
      expect(search.result.items[0].tableDependencies).toContain("Combat/Skill");
      expect(search.result.cards[0].tableDependencies).toContain("Combat/Skill");
      expect(search.result.cards[0].suggestedNextTools).toContain("kb_get_page_tables");
    } finally {
      await fixture.cleanup();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  }, 15000);

  it("resolves topics to actionable table, entity, and page targets", async () => {
    const fixture = await setupPublishedKnowledgeFixture({ dependencyText: "Uses 技能表." });
    const service = createKnowledgeQueryService(fixture.db, fixture.dataDir);
    try {
      const tableTopic = await service.runTool("kb_resolve_topic", { topic: "技能表" }, { sessionId: "test", agentRole: "planner" });
      expect(tableTopic.result.resolvedType).toBe("table");
      expect(tableTopic.result.resolved.id).toBe("Combat/Skill");
      expect(tableTopic.result.suggestedTools).toContain("kb_get_table_schema");
      expect(tableTopic.result.nextStep).toContain("kb_get_table_schema");

      const entityTopic = await service.runTool("kb_resolve_topic", { topic: "Battle System" }, { sessionId: "test", agentRole: "planner" });
      expect(entityTopic.result.targets.some((target: { type: string }) => target.type === "entity")).toBe(true);
      expect(entityTopic.result.suggestedTools).toContain("kb_get_neighbors");

      const pageTopic = await service.runTool("kb_resolve_topic", { topic: "Battle stamina" }, { sessionId: "test", agentRole: "planner" });
      expect(pageTopic.result.targets.some((target: { type: string; title: string }) => target.type === "page" && target.title === "Battle System")).toBe(true);
      expect(pageTopic.result.suggestedTools).toContain("kb_get_page");
    } finally {
      await fixture.cleanup();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  }, 15000);

  it("serves wiki knowledge from the published OKF bundle instead of internal component files", async () => {
    const fixture = await setupPublishedKnowledgeFixture({ withEvidence: false });
    const service = createKnowledgeQueryService(fixture.db, fixture.dataDir);
    const okfPagePath = join(fixture.dataDir, "releases", fixture.releaseId, "okf_bundle", "systems", "battle.md");
    writeFileSync(okfPagePath, [
      "---",
      'type: "knowledge_note"',
      'title: "Battle System"',
      'artifactId: "wiki/systems/battle.md"',
      'tags: ["wiki_page"]',
      "kh:",
      `  componentId: "${fixture.pageComponentId}"`,
      '  packageId: "pkg_query_fixture"',
      '  artifactId: "wiki/systems/battle.md"',
      "---",
      "# Battle System",
      "",
      "OKF-only rage meter is consumed by agents.",
      "",
      "## Data Dependencies",
      "Uses Combat/Skill.",
      "",
      "# Citations",
      "",
      "1. OKF citation quote (okf_manual_evidence; source src_okf; confidence 0.93)",
      ""
    ].join("\n"), "utf8");

    try {
      const search = await service.runTool("kb_search", { query: "OKF-only rage" }, { sessionId: "test", agentRole: "planner" });
      expect(search.result.items[0].okfPath).toBe("/systems/battle.md");
      expect(search.trace.componentIds).toContain(fixture.pageComponentId);
      expect(search.trace.evidenceIds).toContain("okf_manual_evidence");
      expect(search.qualityFlags).not.toContain(`evidence_missing:${fixture.pageComponentId}`);

      const page = await service.runTool("kb_get_page", { page: "Battle System" }, { sessionId: "test", agentRole: "planner" });
      expect(page.result.markdown).toContain("OKF-only rage meter");
      expect(page.result.markdown).not.toContain("Stamina controls skill usage.");

      const evidence = await service.runTool("kb_get_evidence", { page: "Battle System" }, { sessionId: "test", agentRole: "planner" });
      expect(evidence.result.source).toBe("okf_bundle");
      expect(evidence.trace.evidenceIds).toContain("okf_manual_evidence");
    } finally {
      await fixture.cleanup();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  }, 15000);

  it("serves graph and table contracts from the published OKF bundle", async () => {
    const fixture = await setupPublishedKnowledgeFixture();
    const service = createKnowledgeQueryService(fixture.db, fixture.dataDir);
    const okfRoot = join(fixture.dataDir, "releases", fixture.releaseId, "okf_bundle");
    writeFileSync(join(okfRoot, "graph", "graph.json"), JSON.stringify({
      okfAssetType: "knowledge_graph",
      componentId: fixture.graphComponentId,
      packageId: "pkg_query_fixture",
      artifactId: "wiki/graph.json",
      nodes: [
        { id: "OKF Battle", label: "OKF Battle", type: "system" },
        { id: "table:Combat/SkillFromOKF", label: "Combat/SkillFromOKF", type: "table" }
      ],
      edges: [
        { source: "OKF Battle", target: "table:Combat/SkillFromOKF", relation: "configured_in", edge_kind: "semantic" }
      ]
    }, null, 2), "utf8");
    writeFileSync(join(okfRoot, "tables", "schemas.json"), JSON.stringify({
      okfAssetType: "table_schema_manifest",
      releaseId: fixture.releaseId,
      sourceVersionIds: [fixture.sourceVersionId],
      tables: [{
        componentId: fixture.tableSchemaComponentId,
        packageId: "pkg_query_fixture",
        artifactId: "table_schemas/Combat__Skill.json",
        sourceVersionIds: [fixture.sourceVersionId],
        schema: {
          table_name: "Combat/SkillFromOKF",
          rel_path: "gamedata/Combat/Skill.csv",
          fields: ["Id", "Name", "StaminaCost"],
          row_count: 1,
          sheets: ["Skill"]
        }
      }]
    }, null, 2), "utf8");

    try {
      const entity = await service.runTool("kb_get_entity", { entityId: "OKF Battle" }, { sessionId: "test", agentRole: "planner" });
      expect(entity.result.node.label).toBe("OKF Battle");
      expect(entity.trace.componentIds).toContain(fixture.graphComponentId);

      const relations = await service.runTool("kb_get_relations", { source: "OKF Battle" }, { sessionId: "test", agentRole: "planner" });
      expect(relations.result.edges[0].target).toBe("table:Combat/SkillFromOKF");

      const schema = await service.runTool("kb_get_table_schema", { table: "Combat/SkillFromOKF" }, { sessionId: "test", agentRole: "planner" });
      expect(schema.result.schema.rel_path).toBe("gamedata/Combat/Skill.csv");
      expect(schema.trace.componentIds).toContain(fixture.tableSchemaComponentId);

      const rows = await service.runTool("kb_query_table", { table: "Combat/SkillFromOKF", where: { Name: "Slash" } }, { sessionId: "test", agentRole: "planner" });
      expect(rows.result.rows).toEqual([{ Id: 1, Name: "Slash", StaminaCost: 10 }]);
    } finally {
      await fixture.cleanup();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  }, 15000);

  it("turns misses and low-quality hits into feedback events and review tasks", async () => {
    const fixture = await setupPublishedKnowledgeFixture({ lowQuality: true, withEvidence: false });
    const service = createKnowledgeQueryService(fixture.db, fixture.dataDir);
    try {
      await service.runTool("kb_search", { query: "nonexistent resurrection economy" }, { sessionId: "test", agentRole: "planner" });
      await service.runTool("kb_search", { query: "nonexistent resurrection economy" }, { sessionId: "test", agentRole: "planner" });
      await service.runTool("kb_search", { query: "nonexistent resurrection economy" }, { sessionId: "test", agentRole: "planner" });
      await service.runTool("kb_get_page", { page: "Battle System" }, { sessionId: "test", agentRole: "planner" });

      const { rows: events } = await fixture.db.adapter.query("SELECT * FROM agent_events ORDER BY created_at");
      expect(events.map((event) => event.feedback_type)).toContain("miss");
      expect(events.map((event) => event.feedback_type)).toContain("low_quality_hit");
      const feedbackEvents = await createKnowledgeService(fixture.db).listAgentEvents();
      const lowQualityEvent = feedbackEvents.find((event) => event.feedbackType === "low_quality_hit");
      expect(lowQualityEvent?.components[0]).toMatchObject({
        componentId: fixture.pageComponentId,
        title: "Battle System",
        confidence: 0.42,
        evidenceRecords: 1
      });
      expect(lowQualityEvent?.components[0].trust?.score).toBeLessThan(0.7);

      const { rows: tasks } = await fixture.db.adapter.query("SELECT * FROM review_tasks ORDER BY created_at");
      expect(tasks.some((task) => task.severity === "blocking" && String(task.title).includes("错误本候选"))).toBe(true);
      expect(tasks.some((task) => task.severity === "warning" && String(task.title).includes("低可信命中"))).toBe(true);
    } finally {
      await fixture.cleanup();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  }, 15000);

  it("routes explicit Agent feedback reports into review tasks", async () => {
    const fixture = await setupPublishedKnowledgeFixture();
    const service = createKnowledgeQueryService(fixture.db, fixture.dataDir);
    try {
      const badHit = await service.runTool("kb_report_bad_hit", {
        query: "Battle stamina",
        componentId: fixture.pageComponentId,
        reason: "Agent judged this hit misleading for the user's intent.",
        expected: "A page about stamina recovery rules."
      }, { sessionId: "test", agentRole: "planner" });
      expect(badHit.result.recorded).toBe(true);
      expect(badHit.result.feedbackType).toBe("bad_hit");
      expect(badHit.result.taskId).toMatch(/^task_mcp_bad_hit_/);
      expect(badHit.trace.componentIds).toContain(fixture.pageComponentId);

      const gap = await service.runTool("kb_report_gap", {
        query: "missing resurrection economy",
        expected: "Need an economy spec page.",
        reason: "Search results cannot answer the question."
      }, { sessionId: "test", agentRole: "planner" });
      expect(gap.result.recorded).toBe(true);
      expect(gap.result.feedbackType).toBe("knowledge_gap");

      const { rows: events } = await fixture.db.adapter.query("SELECT feedback_type, query FROM agent_events ORDER BY created_at");
      expect(events.map((event) => event.feedback_type)).toEqual(expect.arrayContaining(["bad_hit", "knowledge_gap"]));
      const { rows: tasks } = await fixture.db.adapter.query("SELECT title, description, suggested_action FROM review_tasks ORDER BY created_at");
      expect(tasks.some((task) => String(task.title).includes("错命中"))).toBe(true);
      expect(tasks.some((task) => String(task.title).includes("知识缺口"))).toBe(true);
      expect(tasks.some((task) => String(task.description).includes("stamina recovery rules"))).toBe(true);
    } finally {
      await fixture.cleanup();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  }, 15000);
});

async function setupPublishedKnowledgeFixture(options: { lowQuality?: boolean; withEvidence?: boolean; dependencyText?: string; withGraphRelation?: boolean } = {}): Promise<{ db: TestDbHandle["db"]; dataDir: string; releaseId: string; pageComponentId: string; graphComponentId: string; tableSchemaComponentId: string; sourceVersionId: string; cleanup: () => Promise<void> }> {
  const dataDir = mkdtempSync(join(tmpdir(), "kh-query-"));
  const handle = await createTestDb();
  const db = handle.db;
  const sourceRoot = join(dataDir, "raw");
  mkdirSync(join(sourceRoot, "gamedata", "Combat"), { recursive: true });
  mkdirSync(join(sourceRoot, "gamedocs"), { recursive: true });
  writeFileSync(join(sourceRoot, "gamedata", "Combat", "Skill.csv"), "Id,Name,StaminaCost\n1,Slash,10\n");
  writeFileSync(join(sourceRoot, "gamedocs", "battle.md"), "Battle system source says stamina controls skill usage.\n");
  const imported = await createSourceBundleService(db, dataDir).importDirectoryAsVersion({
    rootPath: sourceRoot,
    bundleId: "default",
    note: "query fixture",
    createdBy: "admin"
  });

  const runId = "run_query_fixture";
  const buildData = join(dataDir, "kb-build-runs", runId, "data");
  mkdirSync(join(buildData, "wiki", "systems"), { recursive: true });
  mkdirSync(join(buildData, "wiki", "_tables"), { recursive: true });
  mkdirSync(join(buildData, "table_schemas"), { recursive: true });
  writeFileSync(join(buildData, "wiki", "systems", "battle.md"), [
    "# Battle System",
    "",
    "## Overview",
    "Stamina controls skill usage.",
    "",
    "## Data Dependencies",
    options.dependencyText ?? "Uses Combat/Skill.",
    ""
  ].join("\n"));
  writeFileSync(join(buildData, "wiki", "graph.json"), JSON.stringify({
    nodes: [
      { id: "Battle System", label: "Battle System", type: "system", wiki_page: "wiki/systems/battle.md" },
      { id: "table:Combat/Skill", label: "Combat/Skill", type: "table" }
    ],
    edges: options.withGraphRelation === false ? [] : [
      { source: "Battle System", target: "table:Combat/Skill", relation: "configured_in", edge_kind: "semantic" }
    ]
  }, null, 2));
  writeFileSync(join(buildData, "wiki", "_tables", "schemas.json"), JSON.stringify({
    "Combat/Skill": {
      table_name: "Combat/Skill",
      rel_path: "gamedata/Combat/Skill.csv",
      fields: ["Id", "Name", "StaminaCost"],
      row_count: 1,
      sheets: ["Skill"]
    }
  }, null, 2));
  writeFileSync(join(buildData, "wiki", "_tables", "table_aliases.json"), JSON.stringify([
    { table: "Combat/Skill", aliases: ["技能表"] }
  ], null, 2));
  writeFileSync(join(buildData, "table_schemas", "Combat__Skill.json"), JSON.stringify({
    table_name: "Combat/Skill",
    rel_path: "gamedata/Combat/Skill.csv",
    fields: ["Id", "Name", "StaminaCost"],
    row_count: 1,
    sheets: ["Skill"]
  }, null, 2));

  const packageId = "pkg_query_fixture";
  const pageComponentId = "cmp_query_page";
  const graphComponentId = "cmp_query_graph";
  const tableRegistryComponentId = "cmp_query_table_registry";
  const tableAliasesComponentId = "cmp_query_table_aliases";
  const tableSchemaComponentId = "cmp_query_table_schema";
  const confidence = options.lowQuality ? 0.42 : 0.91;

  await db.adapter.query(
    `INSERT INTO asset_packages
      (package_id, name, kind, status, description, created_by_run_id, source_version_ids, legacy_paths, quality_summary, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      packageId,
      "Query Fixture Package",
      "kb_builder_pipeline",
      "draft",
      "query fixture",
      runId,
      JSON.stringify([imported.version.versionId]),
      JSON.stringify(["wiki", "table_schemas"]),
      JSON.stringify({ overallScore: confidence, blockingCount: 0, warningCount: options.lowQuality ? 1 : 0 }),
      new Date().toISOString()
    ]
  );

  const components = [
    [pageComponentId, "wiki/systems/battle.md", "wiki", "wiki_page", "Battle System", "data/wiki/systems/battle.md", { confidence }],
    [graphComponentId, "wiki/graph.json", "graph", "graph_snapshot", "Graph", "data/wiki/graph.json", { confidence: 0.9 }],
    [tableRegistryComponentId, "wiki/_tables/schemas.json", "table", "table_registry", "Table Registry", "data/wiki/_tables/schemas.json", { confidence: 0.9 }],
    [tableAliasesComponentId, "wiki/_tables/table_aliases.json", "table", "table_registry", "Table Aliases", "data/wiki/_tables/table_aliases.json", { confidence: 0.9 }],
    [tableSchemaComponentId, "table_schemas/Combat__Skill.json", "table", "table_schema_json", "Combat/Skill", "data/table_schemas/Combat__Skill.json", { confidence: 0.9 }]
  ] as const;
  for (const [componentId, artifactId, group, kind, title, storageUri, quality] of components) {
    await db.adapter.query(
      `INSERT INTO asset_components
        (component_id, package_id, artifact_id, group_name, kind, title, status, legacy_path, storage_uri, source_refs, quality)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        componentId,
        packageId,
        artifactId,
        group,
        kind,
        title,
        "draft",
        artifactId,
        storageUri,
        JSON.stringify(["gamedocs/battle.md"]),
        JSON.stringify(quality)
      ]
    );
  }

  if (options.withEvidence ?? true) {
    await db.adapter.query(
      `INSERT INTO evidence_records (evidence_id, package_id, component_id, source_version_id, quote, note, confidence, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      ["ev_query_page", packageId, pageComponentId, imported.version.versionId, "stamina controls skill usage", "source quote", 0.95, new Date().toISOString()]
    );
  }

  const releaseService = createReleaseService(db, dataDir);
  const draft = await releaseService.createDraft({ version: "query.1", packageIds: [packageId], requestedBy: "admin" });
  const published = await releaseService.publish(draft.releaseId, "admin");
  return {
    db,
    dataDir,
    releaseId: published.releaseId,
    pageComponentId,
    graphComponentId,
    tableSchemaComponentId,
    sourceVersionId: imported.version.versionId,
    cleanup: handle.cleanup
  };
}
