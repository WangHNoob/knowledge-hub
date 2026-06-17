import { describe, expect, it } from "vitest";

import { createReleaseService } from "../src/server/services/releaseService";
import { createTestDb, type TestDbHandle } from "./helpers/testDb";

describe("ReleaseService", () => {
  it("blocks publishing when selected packages have open blocking tasks", async () => {
    const fixture = await setupReleaseFixture({ blockingTask: true });
    try {
      const service = createReleaseService(fixture.db);
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
    const service = createReleaseService(first.db);

    try {
      const rel1 = await service.createDraft({ version: "2026.06.15.001", packageIds: ["pkg_first"], requestedBy: "admin" });
      const pub1 = await service.publish(rel1.releaseId, "admin");
      expect(pub1.status).toBe("published");
      expect(pub1.manifestHash).toMatch(/^sha256:/u);
      expect(pub1.manifest.packageIds).toEqual(["pkg_first"]);
      expect(pub1.manifest.componentIds).toEqual(["cmp_pkg_first_page"]);
      expect(pub1.publishedAt).toBeTruthy();

      const rel2 = await service.createDraft({ version: "2026.06.15.002", packageIds: ["pkg_second"], requestedBy: "admin" });
      const pub2 = await service.publish(rel2.releaseId, "admin");
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
});

async function setupReleaseFixture(options: {
  handle?: TestDbHandle;
  packageId?: string;
  blockingTask?: boolean;
} = {}): Promise<{ handle: TestDbHandle; db: TestDbHandle["db"]; cleanup: () => Promise<void> }> {
  const handle = options.handle ?? await createTestDb();
  const db = handle.db;
  const packageId = options.packageId ?? "pkg_demo";
  const componentId = `cmp_${packageId}_page`;

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
      "run_fixture",
      JSON.stringify(["srcv_fixture"]),
      JSON.stringify(["wiki"]),
      JSON.stringify({ overallScore: 0.92, blockingCount: options.blockingTask ? 1 : 0, warningCount: 0 }),
      new Date().toISOString(),
    ],
  );
  await db.adapter.query(
    `INSERT INTO asset_components
      (component_id, package_id, artifact_id, group_name, kind, title, status, legacy_path, storage_uri, source_refs, quality)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      componentId,
      packageId,
      "wiki/systems/demo.md",
      "wiki",
      "wiki_page",
      "Demo Page",
      "draft",
      "wiki/systems/demo.md",
      "kb-build-runs/run_fixture/data/wiki/systems/demo.md",
      JSON.stringify(["gamedocs/demo.md"]),
      JSON.stringify({ confidence: 0.92 }),
    ],
  );

  if (options.blockingTask) {
    await db.adapter.query(
      `INSERT INTO review_tasks
        (task_id, package_id, component_id, severity, status, title, description, suggested_action, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      ["task_blocking", packageId, componentId, "blocking", "open", "Blocking issue", "fix it", "resolve before publish", new Date().toISOString()],
    );
  }

  return { handle, db, cleanup: handle.cleanup };
}
