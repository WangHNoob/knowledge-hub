import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createDatabase } from "../src/server/db";
import { createKnowledgeQueryService } from "../src/server/services/knowledgeQueryService";
import { createReleaseService } from "../src/server/services/releaseService";
import { createSourceBundleService } from "../src/server/services/sourceBundleService";

describe("KnowledgeQueryService", () => {
  it("returns a clear error when no current release exists", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-query-empty-"));
    const db = await createDatabase({ dataDir, seedUsers: false });
    try {
      const service = createKnowledgeQueryService(db, dataDir);
      await expect(service.runTool("kb_get_release", {}, { sessionId: "test", agentRole: "planner" }))
        .rejects.toThrow(/No current published release/i);
    } finally {
      await db.close();
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

      const page = await service.runTool("kb_get_page", { page: "Battle System" }, { sessionId: "test", agentRole: "planner" });
      expect(page.result.markdown).toContain("Stamina controls skill usage.");

      const section = await service.runTool("kb_get_section", { page: "Battle System", section: "Data Dependencies" }, { sessionId: "test", agentRole: "planner" });
      expect(section.result.markdown).toContain("Combat/Skill");

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

      const { rows: auditRows } = await fixture.db.adapter.query("SELECT * FROM mcp_audit ORDER BY created_at");
      expect(auditRows.length).toBeGreaterThanOrEqual(9);
      expect(auditRows.at(-1)?.status).toBe("hit");
    } finally {
      await fixture.db.close();
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

      const { rows: tasks } = await fixture.db.adapter.query("SELECT * FROM review_tasks ORDER BY created_at");
      expect(tasks.some((task) => task.severity === "blocking" && String(task.title).includes("错误本候选"))).toBe(true);
      expect(tasks.some((task) => task.severity === "warning" && String(task.title).includes("低质量命中"))).toBe(true);
    } finally {
      await fixture.db.close();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  }, 15000);
});

async function setupPublishedKnowledgeFixture(options: { lowQuality?: boolean; withEvidence?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "kh-query-"));
  const db = await createDatabase({ dataDir, seedUsers: false });
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
    "Uses Combat/Skill.",
    ""
  ].join("\n"));
  writeFileSync(join(buildData, "wiki", "graph.json"), JSON.stringify({
    nodes: [
      { id: "Battle System", label: "Battle System", type: "system", wiki_page: "wiki/systems/battle.md" },
      { id: "table:Combat/Skill", label: "Combat/Skill", type: "table" }
    ],
    edges: [
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

  const releaseService = createReleaseService(db);
  const draft = await releaseService.createDraft({ version: "query.1", packageIds: [packageId], requestedBy: "admin" });
  const published = await releaseService.publish(draft.releaseId, "admin");
  return { db, dataDir, releaseId: published.releaseId, pageComponentId };
}
