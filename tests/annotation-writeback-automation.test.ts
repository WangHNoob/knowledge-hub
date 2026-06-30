import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { emitKnowledgeEvent } from "../src/server/services/eventService";
import { createKbBuilderPipelineService } from "../src/server/services/kbBuilderService";
import { createKnowledgeService } from "../src/server/services/knowledgeService";
import { registerAnnotationWritebackAutomation } from "../src/server/services/annotationWritebackAutomationService";
import { createSourceBundleService } from "../src/server/services/sourceBundleService";
import type { KnowledgeBuildRun } from "../src/server/types";
import { createTestDb } from "./helpers/testDb";

describe("annotation writeback automation", () => {
  it("starts a scoped deterministic rebuild for override annotations", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-ann-writeback-data-"));
    const sourceRoot = mkdtempSync(join(tmpdir(), "kh-ann-writeback-src-"));
    const { db, cleanup } = await createTestDb();
    const builder = createKbBuilderPipelineService(db, dataDir);
    const unsubscribe = registerAnnotationWritebackAutomation({ db, kbBuilderService: builder });
    try {
      mkdirSync(join(sourceRoot, "gamedocs"), { recursive: true });
      mkdirSync(join(sourceRoot, "gamedata"), { recursive: true });
      writeFileSync(join(sourceRoot, "gamedocs", "battle.md"), "# Battle\n\nBattle rules.");
      const imported = await createSourceBundleService(db, dataDir).importDirectoryAsVersion({
        rootPath: sourceRoot,
        bundleId: "default",
        createdBy: "admin",
        note: "annotation writeback fixture",
      });

      await db.adapter.query(
        `INSERT INTO asset_packages
          (package_id, name, kind, status, description, created_by_run_id, source_version_ids, legacy_paths, quality_summary, created_at)
         VALUES ('pkg_ann_writeback','Annotation Writeback','kb_builder_pipeline','draft','fixture','run_prev',$1,'[]','{}',NOW())`,
        [JSON.stringify([imported.version.versionId])],
      );
      await db.adapter.query(
        `INSERT INTO asset_components
          (component_id, package_id, artifact_id, group_name, kind, title, status, legacy_path, storage_uri, source_refs, quality)
         VALUES ('cmp_ann_writeback','pkg_ann_writeback','wiki/systems/battle.md','wiki','wiki_page','Battle','draft','wiki/systems/battle.md','data/wiki/systems/battle.md',$1,'{}')`,
        [JSON.stringify(["gamedocs/battle.md"])],
      );
      await db.adapter.query(
        `INSERT INTO asset_components
          (component_id, package_id, artifact_id, group_name, kind, title, status, legacy_path, storage_uri, source_refs, quality)
         VALUES ('cmp_ann_other','pkg_ann_writeback','wiki/activities/arena.md','wiki','wiki_page','Arena','draft','wiki/activities/arena.md','data/wiki/activities/arena.md',$1,'{}')`,
        [JSON.stringify(["gamedocs/arena.md"])],
      );

      const event = await emitKnowledgeEvent(db, {
        eventType: "annotation.writeback_requested",
        entityType: "review_task",
        entityId: "task_ann_writeback",
        payload: {
          componentId: "cmp_ann_writeback",
          exampleId: "ann_writeback",
          requestedBy: "admin",
          sourcePath: "gamedocs/battle.md",
        },
      });

      const run = await waitForWritebackStartedEvent(db, builder, "task_ann_writeback");
      expect(run.config).toMatchObject({
        only: "gamedocs/battle.md",
        rebuildTaskId: "task_ann_writeback",
        requestedBy: "admin",
        mergeIntoPackageId: "pkg_ann_writeback",
      });
      await waitForRunFinished(builder, run.runId);
      const completedRun = await builder.getRun(run.runId);
      expect(completedRun?.status).toBe("completed");
      expect(completedRun?.packageId).toBe("pkg_ann_writeback");
      expect(run.model).toBe("deterministic");

      const detail = await createKnowledgeService(db).getPackageDetail("pkg_ann_writeback");
      expect(detail.components.some((component) => component.componentId === "cmp_ann_other")).toBe(true);
      expect(detail.components.some((component) => component.legacyPath.startsWith("wiki/activities/"))).toBe(true);

      const duplicate = await builder.startScopedRebuildForComponent({
        componentId: "cmp_ann_writeback",
        requestedBy: "admin",
        rebuildTaskId: "task_ann_writeback",
        traceId: event.eventId,
      });
      expect(duplicate.runId).toBe(run.runId);

      await db.adapter.query(
        `INSERT INTO review_tasks
          (task_id, package_id, component_id, severity, status, task_kind, rule_id, title, description, suggested_action, created_at)
         VALUES ('task_ann_writeback','pkg_ann_writeback','cmp_ann_writeback','warning','resolved','annotation','wiki.required_fact','Writeback task','fixture','fixture',NOW())`,
      );
      const tasks = await createKnowledgeService(db).listReviewTasks({ status: "resolved" });
      const task = tasks.find((item) => item.taskId === "task_ann_writeback");
      expect(task?.writeback).toMatchObject({
        runId: run.runId,
        only: "gamedocs/battle.md",
        sourcePath: "gamedocs/battle.md",
        runPackageId: "pkg_ann_writeback",
      });
      expect(["running", "completed"]).toContain(task?.writeback?.runStatus);
    } finally {
      unsubscribe();
      await cleanup();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  }, 15000);
});

async function waitForWritebackStartedEvent(
  db: Awaited<ReturnType<typeof createTestDb>>["db"],
  builder: ReturnType<typeof createKbBuilderPipelineService>,
  taskId: string,
): Promise<KnowledgeBuildRun> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const { rows } = await db.adapter.query(
      `SELECT entity_id AS run_id
       FROM knowledge_events
       WHERE event_type = 'annotation.writeback_rebuild_started'
         AND payload_json ->> 'taskId' = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [taskId],
    );
    if (rows[0]) {
      const run = await builder.getRun(String(rows[0].run_id));
      if (run) return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for annotation writeback rebuild ${taskId}`);
}

async function waitForRunFinished(
  builder: ReturnType<typeof createKbBuilderPipelineService>,
  runId: string,
): Promise<KnowledgeBuildRun> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const run = await builder.getRun(runId);
    if (run && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for build run ${runId}`);
}
