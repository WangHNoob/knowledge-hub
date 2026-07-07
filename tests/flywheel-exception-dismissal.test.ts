import { describe, expect, it } from "vitest";

import { createFlywheelService } from "../src/server/services/flywheelService";
import { createKnowledgeService } from "../src/server/services/knowledgeService";
import { createSourceBundleService } from "../src/server/services/sourceBundleService";
import { createKbBuilderPipelineService } from "../src/server/services/kbBuilderService";
import { createReleaseService } from "../src/server/services/releaseService";
import { createProjectService } from "../src/server/services/projectService";
import { createLintRemediationService } from "../src/server/services/lintRemediationService";
import { createGovernanceProfileService } from "../src/server/services/governanceProfileService";
import { createTestDb } from "./helpers/testDb";

function makeFlywheel(db: Parameters<typeof createKnowledgeService>[0]) {
  return createFlywheelService({
    db,
    knowledgeService: createKnowledgeService(db),
    bundleService: createSourceBundleService(db, "."),
    kbBuilderService: createKbBuilderPipelineService(db, "."),
    releaseService: createReleaseService(db, "."),
    projectService: createProjectService(db),
    lintRemediationService: createLintRemediationService(db),
    governanceProfileService: createGovernanceProfileService(db),
  });
}

describe("exception soft-dismissal", () => {
  it("hides a dismissed exception, records it, and can restore it", async () => {
    const fixture = await createTestDb();
    try {
      // 种一个"自动发布被跳过"事件 → 派生一个 publish_blocker 例外（无外键依赖）。
      await fixture.db.adapter.query(
        `INSERT INTO knowledge_events (event_id, project_id, event_type, entity_type, entity_id, payload_json, created_at)
         VALUES ('evt_skip_1', 'default_project', 'release.auto_publish_skipped', 'release', 'rel_1', $1, NOW())`,
        [JSON.stringify({ releaseId: "rel_1", reason: "质量门禁未通过" })],
      );

      const flywheel = makeFlywheel(fixture.db);

      const before = await flywheel.listExceptions("default_project");
      const target = before.find((e) => e.id === "skip-evt_skip_1");
      expect(target).toBeTruthy();

      // 忽略它 → 从收件箱消失，但进入已忽略列表并留痕。
      const dismissed = await flywheel.dismissException({
        projectId: "default_project",
        key: "skip-evt_skip_1",
        exceptionType: target!.type,
        title: target!.title,
        reason: "本期先不处理",
        dismissedBy: "dev",
      });
      expect(dismissed.dedupKey).toBe("skip-evt_skip_1");
      expect(dismissed.restoredAt).toBeNull();

      const afterDismiss = await flywheel.listExceptions("default_project");
      expect(afterDismiss.find((e) => e.id === "skip-evt_skip_1")).toBeFalsy();

      const dismissedList = await flywheel.listDismissedExceptions("default_project");
      expect(dismissedList).toHaveLength(1);
      expect(dismissedList[0].reason).toBe("本期先不处理");
      expect(dismissedList[0].dismissedBy).toBe("dev");

      // 状态聚合里的待处理例外数不应把已忽略项算进去。
      const status = await flywheel.getStatus("default_project");
      expect(status.metrics.pendingExceptions).toBe(0);

      // 恢复 → 重新出现在收件箱，且从已忽略列表移除。
      await flywheel.restoreException({ projectId: "default_project", key: "skip-evt_skip_1", restoredBy: "dev" });
      const afterRestore = await flywheel.listExceptions("default_project");
      expect(afterRestore.find((e) => e.id === "skip-evt_skip_1")).toBeTruthy();
      expect(await flywheel.listDismissedExceptions("default_project")).toHaveLength(0);

      // 再次忽略同一例外应复用同一行（唯一键），不重复插入。
      await flywheel.dismissException({ projectId: "default_project", key: "skip-evt_skip_1", dismissedBy: "dev", reason: "再压一次" });
      const redismissed = await flywheel.listDismissedExceptions("default_project");
      expect(redismissed).toHaveLength(1);
      expect(redismissed[0].reason).toBe("再压一次");
    } finally {
      await fixture.cleanup();
    }
  }, 20000);
});
