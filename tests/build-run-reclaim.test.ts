import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { createKbBuilderPipelineService } from "../src/server/services/kbBuilderService";
import { createTestDb } from "./helpers/testDb";

// 启动回收：进程重启后，上次遗留的 running 构建（进程已死、DB 行还挂着）应被标记为 failed，
// 其它状态不动。这样重启即可靠地停掉一切，例外/构建列表不会永远卡在「运行中」。
describe("KbBuilderPipelineService.failInterruptedRuns", () => {
  it("marks orphaned running runs as failed and leaves other runs untouched", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-reclaim-"));
    const { db, cleanup } = await createTestDb();
    try {
      await db.adapter.query(
        `INSERT INTO source_bundle_versions (version_id, bundle_id, label, created_by)
         VALUES ('srcv_reclaim','default','reclaim fixture','admin')`,
      );
      await db.adapter.query(
        `INSERT INTO knowledge_build_runs (run_id, source_version_id, adapter, quality_profile_id, status)
         VALUES ('run_running_1','srcv_reclaim','native','default','running'),
                ('run_running_2','srcv_reclaim','native','default','running'),
                ('run_done','srcv_reclaim','native','default','completed'),
                ('run_failed','srcv_reclaim','native','default','failed')`,
      );

      const builder = createKbBuilderPipelineService(db, dataDir);
      const reclaimed = await builder.failInterruptedRuns();
      expect(reclaimed).toBe(2);

      const { rows } = await db.adapter.query(
        "SELECT run_id, status, error FROM knowledge_build_runs ORDER BY run_id",
      );
      const byId = Object.fromEntries(rows.map((r) => [r.run_id, r]));
      expect(byId.run_running_1.status).toBe("failed");
      expect(byId.run_running_2.status).toBe("failed");
      expect(byId.run_running_1.error).toContain("重启");
      // 非 running 的不受影响。
      expect(byId.run_done.status).toBe("completed");
      expect(byId.run_failed.status).toBe("failed");
      expect(byId.run_failed.error).toBe("");

      // 幂等：再跑一次没有 running 了，回收 0。
      expect(await builder.failInterruptedRuns()).toBe(0);
    } finally {
      await cleanup();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20000);
});
