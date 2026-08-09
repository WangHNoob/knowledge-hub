// tests/task-policy.test.ts
import { describe, expect, it } from "vitest";

import { createTestDb } from "./helpers/testDb";
import { createGapFillCandidateService, GAP_FILL_AUTO_DISMISS_THRESHOLD } from "../src/server/services/gapFillCandidateService";
import { createTaskPolicyService } from "../src/server/services/taskPolicyService";

describe("gap_fill 自动收敛（预设规则）", () => {
  it("auto-dismisses an open candidate after repeated unsourced feedback reaches the threshold", async () => {
    const { db, cleanup } = await createTestDb();
    try {
      const service = createGapFillCandidateService(db);
      let last: { status: string; eventCount: number } | null = null;
      for (let i = 0; i < GAP_FILL_AUTO_DISMISS_THRESHOLD; i += 1) {
        last = await service.upsertFromFeedback({
          projectId: "default_project",
          releaseId: "rel_test",
          query: "怪物 AI 的仇恨切换距离是多少？",
          feedbackType: "knowledge_gap",
        });
      }
      expect(last?.eventCount).toBe(GAP_FILL_AUTO_DISMISS_THRESHOLD);
      expect(last?.status).toBe("dismissed");
      const { rows } = await db.adapter.query(
        "SELECT * FROM knowledge_events WHERE event_type = 'gap.fill_candidate_auto_dismissed'",
      );
      expect(rows).toHaveLength(1);
      // 已 dismiss 的候选不占用 open 队列
      expect(await service.countOpen("default_project")).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("keeps candidates open below the threshold", async () => {
    const { db, cleanup } = await createTestDb();
    try {
      const service = createGapFillCandidateService(db);
      const candidate = await service.upsertFromFeedback({
        projectId: "default_project",
        releaseId: "rel_test",
        query: "武器精炼材料从哪里获得？",
        feedbackType: "knowledge_gap",
      });
      expect(candidate.status).toBe("open");
      expect(candidate.eventCount).toBe(1);
    } finally {
      await cleanup();
    }
  });
});

describe("TaskPolicyService.applyOpenTaskPolicies", () => {
  it("dismisses open info tasks and leaves blocking tasks untouched", async () => {
    const { db, cleanup } = await createTestDb();
    try {
      await db.adapter.query(
        `INSERT INTO asset_packages
          (package_id, name, kind, status, description, created_by_run_id, source_version_ids, legacy_paths, quality_summary, created_at)
         VALUES ('pkg_policy','Policy Pkg','kb_builder_pipeline','draft','','run_policy','[]','[]','{}',NOW())`,
      );
      await db.adapter.query(
        `INSERT INTO asset_components
          (component_id, package_id, artifact_id, group_name, kind, title, status, legacy_path, storage_uri, source_refs, quality)
         VALUES ('cmp_policy','pkg_policy','wiki/a.md','wiki','wiki_page','A','draft','wiki/a.md','data/wiki/a.md','[]','{}')`,
      );
      await db.adapter.query(
        `INSERT INTO review_tasks (task_id, package_id, component_id, severity, status, title, description, suggested_action, created_at)
         VALUES ('task_info_1','pkg_policy','cmp_policy','info','open','info task','','','2026-01-01T00:00:00Z'),
                ('task_warn_1','pkg_policy','cmp_policy','warning','open','warning task','','','2026-01-01T00:00:00Z')`,
      );

      const policy = createTaskPolicyService(db);
      const result = await policy.applyOpenTaskPolicies("default_project");
      expect(result.dismissedTasks).toBe(1);

      const { rows } = await db.adapter.query(
        "SELECT task_id, status, resolved_by FROM review_tasks WHERE task_id = ANY($1::text[]) ORDER BY task_id",
        [["task_info_1", "task_warn_1"]],
      );
      const byId = new Map(rows.map((row) => [String(row.task_id), row]));
      expect(byId.get("task_info_1")?.status).toBe("dismissed");
      expect(byId.get("task_info_1")?.resolved_by).toBe("system:task-policy");
      expect(byId.get("task_warn_1")?.status).toBe("open");
    } finally {
      await cleanup();
    }
  });
});
