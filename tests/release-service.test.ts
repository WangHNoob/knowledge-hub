import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { createReleaseService } from "../src/server/services/releaseService";
import { emitKnowledgeEvent } from "../src/server/services/eventService";
import { registerReleaseAutomation } from "../src/server/services/releaseAutomationService";
import { createTestDb, type TestDbHandle } from "./helpers/testDb";

describe("ReleaseService", () => {
  it("blocks publishing when selected packages have open blocking tasks", async () => {
    const fixture = await setupReleaseFixture({ blockingTask: true });
    try {
      const service = createReleaseService(fixture.db, fixture.dataDir);
      const draft = await service.createDraft({
        version: "2026.06.15.001",
        packageIds: ["pkg_demo"],
        requestedBy: "admin",
      });

      await expect(service.publish(draft.releaseId, "admin")).rejects.toThrow(/blocking/i);
      await expect(service.getCurrent()).resolves.toBeNull();
    } finally {
      await fixture.cleanup();
    }
  }, 15000);

  it("publishes an immutable manifest and rolls the current channel pointer", async () => {
    const first = await setupReleaseFixture({ packageId: "pkg_first" });
    await setupReleaseFixture({ handle: first.handle, packageId: "pkg_second" });
    const service = createReleaseService(first.db, first.dataDir);

    try {
      const rel1 = await service.createDraft({ version: "2026.06.15.001", packageIds: ["pkg_first"], requestedBy: "admin" });
      expect(rel1.parentReleaseId).toBeNull();
      const pub1 = await service.publish(rel1.releaseId, "admin");
      expect(pub1.status).toBe("published");
      expect(pub1.manifest.revision).toMatchObject({
        parentReleaseId: null,
        mode: "initial",
        summary: { componentsAdded: 3, componentsRemoved: 0, componentsChanged: 0 }
      });
      expect(pub1.manifestHash).toMatch(/^sha256:/u);
      expect(pub1.manifest.packageIds).toEqual(["pkg_first"]);
      expect(pub1.manifest.componentIds).toEqual(["cmp_pkg_first_graph", "cmp_pkg_first_page", "cmp_pkg_first_table_schema"]);
      expect(pub1.manifest.okf).toMatchObject({
        bundleUri: expect.stringContaining(`${pub1.releaseId}/okf_bundle`),
        graphUri: "graph/graph.json",
        tableSchemasUri: "tables/schemas.json",
        searchIndexUri: "search/index.json",
        revisionUri: "meta/revision.json",
        lintUri: expect.stringContaining(`${pub1.releaseId}/knowledge_lint.json`),
        lintMarkdownUri: expect.stringContaining(`${pub1.releaseId}/knowledge_lint.md`),
        lintSummary: expect.objectContaining({ blocking: 0 }),
        exporterVersion: 1,
        summary: { blocking: 0 },
        citationSummary: { required: 1, present: 1 }
      });
      expect(pub1.manifest.auditSummary).toMatchObject({
        version: 1,
        sources: { packageCount: 1, componentCount: 3 },
        evidence: { requiredComponents: 1, coveredComponents: 1 },
        review: { open: 0 }
      });
      expect(pub1.manifest.legislationProfile).toMatchObject({
        governanceRules: {
          agent: { includeTrustInMcp: true },
          lint: { enabledDomains: expect.arrayContaining(["mcp_feedback"]) }
        }
      });
      expect(existsSync(join(first.dataDir, "releases", pub1.releaseId, "okf_bundle", "systems", "demo.md"))).toBe(true);
      expect(readFileSync(join(first.dataDir, "releases", pub1.releaseId, "okf_bundle", "systems", "demo.md"), "utf8")).toContain('type: "system_rule"');
      expect(readFileSync(join(first.dataDir, "releases", pub1.releaseId, "okf_bundle", "log.md"), "utf8")).toContain("# Release Audit Log");
      expect(readFileSync(join(first.dataDir, "releases", pub1.releaseId, "okf_bundle", "log.md"), "utf8")).toContain("## Trust Score");
      expect(readFileSync(join(first.dataDir, "releases", pub1.releaseId, "knowledge_lint.md"), "utf8")).toContain("# Knowledge Lint Report");
      expect(JSON.parse(readFileSync(join(first.dataDir, "releases", pub1.releaseId, "knowledge_lint.json"), "utf8")).summary.blocking).toBe(0);
      expect(JSON.parse(readFileSync(join(first.dataDir, "releases", pub1.releaseId, "okf_bundle", "graph", "graph.json"), "utf8")).nodes[0].label).toBe("Demo Page");
      expect(JSON.parse(readFileSync(join(first.dataDir, "releases", pub1.releaseId, "okf_bundle", "meta", "revision.json"), "utf8"))).toMatchObject({
        okfAssetType: "release_revision",
        mode: "initial",
        summary: { componentsAdded: 3 }
      });
      expect(JSON.parse(readFileSync(join(first.dataDir, "releases", pub1.releaseId, "okf_bundle", "tables", "schemas.json"), "utf8")).tables[0].schema.table_name).toBe("Demo/Table");
      expect(JSON.parse(readFileSync(join(first.dataDir, "releases", pub1.releaseId, "okf_bundle", "search", "index.json"), "utf8")).pages[0].title).toBe("Demo Page");
      expect(existsSync(join(first.dataDir, "releases", pub1.releaseId, "okf_report.json"))).toBe(true);
      expect(pub1.publishedAt).toBeTruthy();

      const rel2 = await service.createDraft({ version: "2026.06.15.002", packageIds: ["pkg_second"], requestedBy: "admin" });
      expect(rel2.parentReleaseId).toBe(pub1.releaseId);
      await expect(service.publish(rel2.releaseId, "admin", { autoMode: true })).rejects.toThrow(/removed_components_present/u);
      const pub2 = await service.publish(rel2.releaseId, "admin");
      expect(pub2.parentReleaseId).toBe(pub1.releaseId);
      expect(pub2.manifest.revision).toMatchObject({
        parentReleaseId: pub1.releaseId,
        mode: "revision",
        summary: { packagesAdded: 1, packagesRemoved: 1, componentsAdded: 3, componentsRemoved: 3, componentsChanged: 0 }
      });
      expect(JSON.parse(readFileSync(join(first.dataDir, "releases", pub2.releaseId, "okf_bundle", "meta", "revision.json"), "utf8"))).toMatchObject({
        okfAssetType: "release_revision",
        parentReleaseId: pub1.releaseId,
        mode: "revision"
      });
      expect((await service.getCurrent())?.releaseId).toBe(pub2.releaseId);

      const rolledBack = await service.rollback(pub1.releaseId, "admin");
      expect(rolledBack.releaseId).toBe(pub1.releaseId);
      expect((await service.getCurrent())?.releaseId).toBe(pub1.releaseId);

      await expect(service.publish(pub1.releaseId, "admin")).rejects.toThrow(/already published/i);
      expect((await service.getRelease(pub1.releaseId))?.manifestHash).toBe(pub1.manifestHash);
    } finally {
      await first.cleanup();
    }
  }, 15000);

  it("deletes non-current releases and their OKF storage but protects the current release", async () => {
    const first = await setupReleaseFixture({ packageId: "pkg_delete_old" });
    await setupReleaseFixture({ handle: first.handle, packageId: "pkg_delete_current" });
    const service = createReleaseService(first.db, first.dataDir);

    try {
      const rel1 = await service.createDraft({ version: "2026.06.15.delete-old", packageIds: ["pkg_delete_old"], requestedBy: "admin" });
      const pub1 = await service.publish(rel1.releaseId, "admin");
      const rel2 = await service.createDraft({ version: "2026.06.15.delete-current", packageIds: ["pkg_delete_current"], requestedBy: "admin" });
      const pub2 = await service.publish(rel2.releaseId, "admin");

      await expect(service.deleteRelease(pub2.releaseId, "admin")).rejects.toThrow(/current Agent release/i);
      expect(existsSync(join(first.dataDir, "releases", pub2.releaseId))).toBe(true);

      const deleted = await service.deleteRelease(pub1.releaseId, "admin");
      expect(deleted.releaseId).toBe(pub1.releaseId);
      expect(await service.getRelease(pub1.releaseId)).toBeNull();
      expect(existsSync(join(first.dataDir, "releases", pub1.releaseId))).toBe(false);
      expect((await service.getCurrent())?.releaseId).toBe(pub2.releaseId);
    } finally {
      await first.cleanup();
    }
  }, 15000);

  it("reuses unchanged markdown files from the parent OKF bundle", async () => {
    const fixture = await setupReleaseFixture({ packageId: "pkg_reuse" });
    const service = createReleaseService(fixture.db, fixture.dataDir);

    try {
      const firstDraft = await service.createDraft({ version: "2026.06.15.reuse.1", packageIds: ["pkg_reuse"], requestedBy: "admin" });
      const first = await service.publish(firstDraft.releaseId, "admin");
      const firstPage = readFileSync(join(fixture.dataDir, "releases", first.releaseId, "okf_bundle", "systems", "demo.md"), "utf8");

      const secondDraft = await service.createDraft({ version: "2026.06.15.reuse.2", packageIds: ["pkg_reuse"], requestedBy: "admin" });
      expect(secondDraft.parentReleaseId).toBe(first.releaseId);
      const second = await service.publish(secondDraft.releaseId, "admin");
      expect(second.manifest.revision).toMatchObject({
        parentReleaseId: first.releaseId,
        mode: "revision",
        summary: { componentsAdded: 0, componentsRemoved: 0, componentsChanged: 0, componentsUnchanged: 3 }
      });
      const secondPage = readFileSync(join(fixture.dataDir, "releases", second.releaseId, "okf_bundle", "systems", "demo.md"), "utf8");
      expect(secondPage).toBe(firstPage);
    } finally {
      await fixture.cleanup();
    }
  }, 15000);

  it("allows auto-mode publishing when changed components have no blockers and trust does not decline", async () => {
    const fixture = await setupReleaseFixture({ packageId: "pkg_auto_ok" });
    const service = createReleaseService(fixture.db, fixture.dataDir);

    try {
      const firstDraft = await service.createDraft({ version: "2026.06.15.auto.1", packageIds: ["pkg_auto_ok"], requestedBy: "admin" });
      const first = await service.publish(firstDraft.releaseId, "admin");
      await fixture.db.adapter.query(
        "UPDATE asset_components SET title = $2 WHERE component_id = $1",
        ["cmp_pkg_auto_ok_page", "Demo Page Updated"],
      );

      const secondDraft = await service.createDraft({ version: "2026.06.15.auto.2", packageIds: ["pkg_auto_ok"], requestedBy: "admin" });
      const second = await service.publish(secondDraft.releaseId, "admin", { autoMode: true });
      expect(second.parentReleaseId).toBe(first.releaseId);
      expect(second.manifest.revision).toMatchObject({
        mode: "revision",
        summary: { componentsAdded: 0, componentsRemoved: 0, componentsChanged: 1 }
      });
      expect(second.manifest.autoPublish).toMatchObject({
        eligible: true,
        mode: "auto",
        reasons: [],
        changedComponentIds: ["cmp_pkg_auto_ok_page"],
      });
    } finally {
      await fixture.cleanup();
    }
  }, 15000);

  it("proposes one revision draft for a completed scoped build", async () => {
    const fixture = await setupReleaseFixture({ packageId: "pkg_current" });
    await setupReleaseFixture({ handle: fixture.handle, packageId: "pkg_scoped" });
    const service = createReleaseService(fixture.db, fixture.dataDir);

    try {
      const currentDraft = await service.createDraft({ version: "2026.06.15.current", packageIds: ["pkg_current"], requestedBy: "admin" });
      const current = await service.publish(currentDraft.releaseId, "admin");
      const proposal = await service.proposeRevisionDraftFromBuild({
        packageId: "pkg_scoped",
        runId: "run_scoped",
        requestedBy: "builder",
        only: "gamedocs/demo.md",
      });
      expect(proposal.created).toBe(true);
      expect(proposal.release).toMatchObject({
        parentReleaseId: current.releaseId,
        packageIds: ["pkg_scoped"],
        status: "draft",
      });
      expect(proposal.release?.note).toContain("run_scoped");

      const duplicate = await service.proposeRevisionDraftFromBuild({
        packageId: "pkg_scoped",
        runId: "run_scoped_again",
        requestedBy: "builder",
        only: "gamedocs/demo.md",
      });
      expect(duplicate.created).toBe(false);
      expect(duplicate.reason).toBe("duplicate_draft");
      expect(duplicate.release?.releaseId).toBe(proposal.release?.releaseId);

      const events = await fixture.db.adapter.query("SELECT * FROM knowledge_events WHERE event_type = 'release.revision_proposed'");
      expect(events.rows).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  }, 15000);

  it("creates a revision draft from the build.completed event subscriber", async () => {
    const fixture = await setupReleaseFixture({ packageId: "pkg_event_current" });
    await setupReleaseFixture({ handle: fixture.handle, packageId: "pkg_event_scoped" });
    const service = createReleaseService(fixture.db, fixture.dataDir);
    const unsubscribe = registerReleaseAutomation({ db: fixture.db, releaseService: service });

    try {
      const currentDraft = await service.createDraft({ version: "2026.06.15.event-current", packageIds: ["pkg_event_current"], requestedBy: "admin" });
      const current = await service.publish(currentDraft.releaseId, "admin");
      await emitKnowledgeEvent(fixture.db, {
        eventType: "build.completed",
        entityType: "build_run",
        entityId: "run_event_scoped",
        payload: {
          runId: "run_event_scoped",
          packageId: "pkg_event_scoped",
          requestedBy: "builder",
          only: "gamedocs/demo.md",
        },
      });
      const draft = await waitForDraftRevision(fixture.db, current.releaseId, "pkg_event_scoped");
      expect(draft).toMatchObject({ parent_release_id: current.releaseId, status: "draft" });
      expect(String(draft.note)).toContain("run_event_scoped");
    } finally {
      unsubscribe();
      await fixture.cleanup();
    }
  }, 15000);

  it("auto publishes eligible revision drafts when release automation is enabled", async () => {
    const fixture = await setupReleaseFixture({ packageId: "pkg_event_auto" });
    const service = createReleaseService(fixture.db, fixture.dataDir);
    const unsubscribe = registerReleaseAutomation({
      db: fixture.db,
      releaseService: service,
      autoPublishRevisions: true,
    });

    try {
      const currentDraft = await service.createDraft({ version: "2026.06.15.event-auto.1", packageIds: ["pkg_event_auto"], requestedBy: "admin" });
      const current = await service.publish(currentDraft.releaseId, "admin");
      await fixture.db.adapter.query(
        "UPDATE asset_components SET title = $2 WHERE component_id = $1",
        ["cmp_pkg_event_auto_page", "Demo Page Auto Updated"],
      );
      await emitKnowledgeEvent(fixture.db, {
        eventType: "build.completed",
        entityType: "build_run",
        entityId: "run_event_auto",
        payload: {
          runId: "run_event_auto",
          packageId: "pkg_event_auto",
          requestedBy: "builder",
          only: "gamedocs/demo.md",
        },
      });
      const published = await waitForAutoPublish(fixture.db, current.releaseId, "pkg_event_auto");
      expect(published.status).toBe("published");
      expect(published.parent_release_id).toBe(current.releaseId);
      expect((await service.getCurrent())?.releaseId).toBe(published.release_id);
      const events = await fixture.db.adapter.query("SELECT * FROM knowledge_events WHERE event_type = 'release.auto_publish_succeeded'");
      expect(events.rows).toHaveLength(1);
    } finally {
      unsubscribe();
      await fixture.cleanup();
    }
  }, 15000);

  it("backfills publish evidence from source refs before OKF export", async () => {
    const fixture = await setupReleaseFixture({ packageId: "pkg_backfill", withEvidence: false });
    const service = createReleaseService(fixture.db, fixture.dataDir);

    try {
      const draft = await service.createDraft({ version: "2026.06.15.backfill", packageIds: ["pkg_backfill"], requestedBy: "admin" });
      const published = await service.publish(draft.releaseId, "admin");
      expect(published.manifest.okf).toMatchObject({
        citationSummary: { required: 1, present: 1 }
      });
      const { rows } = await fixture.db.adapter.query("SELECT * FROM evidence_records WHERE package_id = $1", ["pkg_backfill"]);
      expect(rows.length).toBeGreaterThan(0);
      expect(String(rows[0].quote)).toContain("gamedocs/demo.md");
    } finally {
      await fixture.cleanup();
    }
  }, 15000);
});

async function setupReleaseFixture(options: {
  handle?: TestDbHandle;
  packageId?: string;
  blockingTask?: boolean;
  withEvidence?: boolean;
} = {}): Promise<{ handle: TestDbHandle; db: TestDbHandle["db"]; dataDir: string; cleanup: () => Promise<void> }> {
  const handle = options.handle ?? await createTestDb();
  const db = handle.db;
  const dataDir = options.handle ? (options.handle as TestDbHandle & { __okfDataDir?: string }).__okfDataDir ?? mkdtempSync(join(tmpdir(), "kh-release-okf-")) : mkdtempSync(join(tmpdir(), "kh-release-okf-"));
  (handle as TestDbHandle & { __okfDataDir?: string }).__okfDataDir = dataDir;
  const packageId = options.packageId ?? "pkg_demo";
  const componentId = `cmp_${packageId}_page`;
  const graphComponentId = `cmp_${packageId}_graph`;
  const tableSchemaComponentId = `cmp_${packageId}_table_schema`;
  const runId = `run_fixture_${packageId}`;
  const artifactPath = join(dataDir, "kb-build-runs", runId, "data", "wiki", "systems", "demo.md");
  const graphPath = join(dataDir, "kb-build-runs", runId, "data", "wiki", "graph.json");
  const tableSchemaPath = join(dataDir, "kb-build-runs", runId, "data", "table_schemas", "Demo__Table.json");
  mkdirSync(dirname(artifactPath), { recursive: true });
  mkdirSync(dirname(graphPath), { recursive: true });
  mkdirSync(dirname(tableSchemaPath), { recursive: true });
  writeFileSync(artifactPath, "# Demo Page\n\nDemo release content.\n", "utf8");
  writeFileSync(graphPath, JSON.stringify({
    nodes: [{ id: "Demo Page", label: "Demo Page", type: "system" }],
    edges: []
  }, null, 2), "utf8");
  writeFileSync(tableSchemaPath, JSON.stringify({
    table_name: "Demo/Table",
    rel_path: "gamedata/Demo/Table.csv",
    fields: ["Id", "Name"],
    row_count: 0,
    sheets: ["Table"]
  }, null, 2), "utf8");

  await db.adapter.query(
    `INSERT INTO asset_packages
      (package_id, name, kind, status, description, created_by_run_id, source_version_ids, legacy_paths, quality_summary, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      packageId,
      `Package ${packageId}`,
      "kb_builder_pipeline",
      "draft",
      "fixture",
      runId,
      JSON.stringify(["srcv_fixture"]),
      JSON.stringify(["wiki"]),
      JSON.stringify({ overallScore: 0.92, blockingCount: options.blockingTask ? 1 : 0, warningCount: 0 }),
      new Date().toISOString(),
    ],
  );
  const components = [
    [componentId, "wiki/systems/demo.md", "wiki", "wiki_page", "Demo Page", "data/wiki/systems/demo.md", ["gamedocs/demo.md"], { confidence: 0.92 }],
    [graphComponentId, "wiki/graph.json", "graph", "graph_snapshot", "Graph", "data/wiki/graph.json", [], { confidence: 0.92 }],
    [tableSchemaComponentId, "table_schemas/Demo__Table.json", "table", "table_schema_json", "Demo/Table", "data/table_schemas/Demo__Table.json", [], { confidence: 0.92 }],
  ] as const;
  for (const [id, artifactId, group, kind, title, storageUri, sourceRefs, quality] of components) {
    await db.adapter.query(
      `INSERT INTO asset_components
        (component_id, package_id, artifact_id, group_name, kind, title, status, legacy_path, storage_uri, source_refs, quality)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        packageId,
        artifactId,
        group,
        kind,
        title,
        "draft",
        artifactId,
        storageUri,
        JSON.stringify(sourceRefs),
        JSON.stringify(quality),
      ],
    );
  }
  if (options.withEvidence ?? true) {
    await db.adapter.query(
      `INSERT INTO evidence_records
        (evidence_id, package_id, component_id, source_version_id, quote, note, confidence, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        `ev_${packageId}_page`,
        packageId,
        componentId,
        "srcv_fixture",
        "Demo source supports the demo page.",
        "release fixture citation",
        0.9,
        new Date().toISOString(),
      ],
    );
  }

  if (options.blockingTask) {
    await db.adapter.query(
      `INSERT INTO review_tasks
        (task_id, package_id, component_id, severity, status, title, description, suggested_action, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      ["task_blocking", packageId, componentId, "blocking", "open", "Blocking issue", "fix it", "resolve before publish", new Date().toISOString()],
    );
  }

  return {
    handle,
    db,
    dataDir,
    cleanup: async () => {
      rmSync(dataDir, { recursive: true, force: true });
      await handle.cleanup();
    }
  };
}

async function waitForDraftRevision(db: TestDbHandle["db"], parentReleaseId: string, packageId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const { rows } = await db.adapter.query(
      `SELECT *
       FROM releases
       WHERE status = 'draft'
         AND parent_release_id = $1
         AND package_ids @> $2::jsonb
       LIMIT 1`,
      [parentReleaseId, JSON.stringify([packageId])],
    );
    if (rows[0]) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for draft revision ${packageId}`);
}

async function waitForAutoPublish(db: TestDbHandle["db"], parentReleaseId: string, packageId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await db.adapter.query(
      `SELECT *
       FROM releases
       WHERE status = 'published'
         AND parent_release_id = $1
         AND package_ids @> $2::jsonb
       ORDER BY published_at DESC
       LIMIT 1`,
      [parentReleaseId, JSON.stringify([packageId])],
    );
    if (rows[0]) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for auto publish ${packageId}`);
}
