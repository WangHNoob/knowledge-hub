import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { createReleaseService } from "../src/server/services/releaseService";
import { createTestDb } from "./helpers/testDb";

// 设计护栏：scoped/局部重建（带 only 过滤）产出的残缺包不能作为独立全量发布，
// 否则会用缺失文档 wiki 的快照覆盖完整版本（kb_search 查不到页面）。
describe("ReleaseService scoped-package publish guard", () => {
  it("refuses to publish a scoped (only-filtered) package as a standalone release", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-scoped-guard-"));
    const { db, cleanup } = await createTestDb();
    try {
      // 真实 source version（FK 需要）。
      await db.adapter.query(
        `INSERT INTO source_bundle_versions (version_id, bundle_id, label, created_by)
         VALUES ('srcv_scoped','default','scoped fixture','admin')`,
      );
      // 一次带 only 过滤的 scoped 构建运行。
      await db.adapter.query(
        `INSERT INTO knowledge_build_runs
           (run_id, source_version_id, package_id, adapter, quality_profile_id, status, config_json)
         VALUES ('run_scoped','srcv_scoped','pkg_scoped','native','default','completed',$1)`,
        [JSON.stringify({ only: "gamedata/_AccumulativePay.xlsx", requestedBy: "admin" })],
      );
      // scoped 运行产出的残缺包。
      await db.adapter.query(
        `INSERT INTO asset_packages
           (package_id, name, kind, status, description, created_by_run_id, source_version_ids, legacy_paths, quality_summary, created_at)
         VALUES ('pkg_scoped','Scoped','kb_builder_pipeline','draft','fixture','run_scoped',$1,'[]','{}',NOW())`,
        [JSON.stringify(["srcv_scoped"])],
      );

      const service = createReleaseService(db, dataDir);
      // 显式 parentReleaseId=null：作为独立全量发布。
      const draft = await service.createDraft({
        version: "2026.06.30.001",
        packageIds: ["pkg_scoped"],
        requestedBy: "admin",
        parentReleaseId: null,
      });

      await expect(service.publish(draft.releaseId, "admin")).rejects.toThrow(/局部重建|残缺|scoped/i);
      // 自动发布路径也必须被拦截（不能绕过）。
      await expect(service.publish(draft.releaseId, "system", { autoMode: true })).rejects.toThrow(/局部重建|残缺|scoped/i);
      await expect(service.getCurrent()).resolves.toBeNull();
    } finally {
      await cleanup();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 15000);
});
