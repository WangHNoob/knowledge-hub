import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";

import { buildApp } from "../src/server/app";
import { createDatabase } from "../src/server/db";
import type { DatabaseHandle } from "../src/server/types";
import { TEST_DATABASE_URL } from "./helpers/testEnv";

describe("review task transitions", () => {
  let db: DatabaseHandle;
  let schema: string;
  let dir: string;
  let app: FastifyInstance;
  let auth: { authorization: string };

  beforeAll(async () => {
    schema = `test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    db = await createDatabase({ databaseUrl: TEST_DATABASE_URL, schema });
    dir = mkdtempSync(join(tmpdir(), "kh-review-"));
    app = await buildApp({ db, jwtSecret: "test-secret", dataDir: dir });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "adminpw" } });
    auth = { authorization: `Bearer ${login.json<{ token: string }>().token}` };

    await db.adapter.query(
      `INSERT INTO asset_packages (package_id, name, kind, status, description, created_by_run_id, source_version_ids, legacy_paths, quality_summary, created_at)
       VALUES ('pkg_rev','Pkg','kb_builder_pipeline','draft','x','run_r','[]','[]','{}',NOW())`
    );
    await db.adapter.query(
      `INSERT INTO asset_components (component_id, package_id, artifact_id, group_name, kind, title, status, legacy_path, storage_uri, source_refs, quality)
       VALUES ('cmp_rev','pkg_rev','wiki/x','wiki','wiki_page','X','draft','','data/wiki/x.md','[]','{}')`
    );
    await db.adapter.query(
      `INSERT INTO review_tasks (task_id, package_id, component_id, severity, status, title, description, suggested_action, created_at)
       VALUES ('task_block','pkg_rev','cmp_rev','blocking','open','缺少证据','...','补证据',NOW()),
              ('task_warn','pkg_rev','cmp_rev','warning','open','字段缺失','...','补字段',NOW())`
    );
  });

  afterAll(async () => {
    await db.close();
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves a task with actor + note, and filters by status", async () => {
    const resolve = await app.inject({
      method: "POST",
      url: "/api/review/tasks/transition",
      headers: auth,
      payload: { taskIds: ["task_block"], status: "resolved", note: "已补充证据" }
    });
    expect(resolve.statusCode).toBe(200);
    const updated = resolve.json().tasks[0];
    expect(updated.status).toBe("resolved");
    expect(updated.resolvedBy).toBe("admin");
    expect(updated.resolvedAt).toBeTruthy();
    expect(updated.resolutionNote).toBe("已补充证据");

    const open = await app.inject({ method: "GET", url: "/api/review/tasks?status=open", headers: auth });
    expect(open.json().tasks.map((t: { taskId: string }) => t.taskId)).toEqual(["task_warn"]);

    const resolved = await app.inject({ method: "GET", url: "/api/review/tasks?status=resolved", headers: auth });
    expect(resolved.json().tasks.map((t: { taskId: string }) => t.taskId)).toEqual(["task_block"]);
  });

  it("reopen clears resolution fields", async () => {
    await app.inject({ method: "POST", url: "/api/review/tasks/transition", headers: auth, payload: { taskIds: ["task_warn"], status: "dismissed", note: "误报" } });
    const reopen = await app.inject({ method: "POST", url: "/api/review/tasks/transition", headers: auth, payload: { taskIds: ["task_warn"], status: "open" } });
    const task = reopen.json().tasks[0];
    expect(task.status).toBe("open");
    expect(task.resolvedBy).toBe("");
    expect(task.resolvedAt).toBeNull();
    expect(task.resolutionNote).toBe("");
  });

  it("records annotation examples and rule dismissals", async () => {
    await db.adapter.query(
      `INSERT INTO review_tasks (
         task_id, package_id, component_id, severity, status, task_kind, rule_id,
         title, description, suggested_action, candidates, confidence, context_snapshot, created_at
       )
       VALUES (
         'task_annotation','pkg_rev','cmp_rev','warning','open','annotation','wiki.required_fact',
         '字段候选不确定','LLM 对字段归类不确定','请选择正确字段',
         $1,$2,$3,NOW()
       )`,
      [
        JSON.stringify([
          {
            id: "cand_activity",
            label: "活动结构",
            value: { field: "activity_structure", source: "candidate" },
            confidence: 0.72,
            rationale: "正文出现了阶段和奖励配置"
          },
          {
            id: "cand_rule",
            label: "规则说明",
            value: { field: "rule_note", source: "candidate" },
            confidence: 0.21
          }
        ]),
        0.72,
        JSON.stringify({ pageType: "activity", sourceFile: "gamedocs/pvp.md" })
      ]
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/review/tasks/annotate",
      headers: auth,
      payload: {
        taskId: "task_annotation",
        selectedCandidateId: "cand_activity",
        note: "策划确认活动结构字段",
        dismissRule: true,
        dismissalReason: "这个组件不需要该必填字段规则"
      }
    });

    expect(response.statusCode).toBe(200);
    const task = response.json().task;
    expect(task.status).toBe("resolved");
    expect(task.taskKind).toBe("annotation");
    expect(task.annotatedBy).toBe("admin");
    expect(task.annotationValue).toEqual({ field: "activity_structure", source: "candidate" });

    const examples = await db.adapter.query("SELECT * FROM annotation_examples WHERE task_id = $1", ["task_annotation"]);
    expect(examples.rows).toHaveLength(1);
    expect(examples.rows[0].context_hash).toMatch(/^sha256:/);
    expect(examples.rows[0].correct_value).toEqual({ field: "activity_structure", source: "candidate" });

    const dismissals = await db.adapter.query(
      "SELECT * FROM rule_dismissals WHERE component_id = $1 AND rule_id = $2",
      ["cmp_rev", "wiki.required_fact"]
    );
    expect(dismissals.rows).toHaveLength(1);
    expect(dismissals.rows[0].active).toBe(true);

    const events = await db.adapter.query("SELECT * FROM knowledge_events WHERE event_type = $1", ["annotation.created"]);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].payload_json).toMatchObject({ componentId: "cmp_rev", ruleId: "wiki.required_fact" });

    const examplesResponse = await app.inject({ method: "GET", url: "/api/legislation/annotation-examples", headers: auth });
    expect(examplesResponse.statusCode).toBe(200);
    const example = examplesResponse.json().examples.find((item: { taskId: string }) => item.taskId === "task_annotation");
    expect(example).toMatchObject({ active: true, applyMode: "hint", taskId: "task_annotation" });
    expect(example.effect).toMatchObject({
      tasksBefore: 1,
      tasksAfter: 0,
      openTasksAfter: 0,
      openTaskIds: [],
      agentNegativeAfter: 0,
      reviewTaskId: "",
      status: "converging"
    });

    const disableResponse = await app.inject({
      method: "POST",
      url: `/api/legislation/annotation-examples/${encodeURIComponent(example.exampleId)}/active`,
      headers: auth,
      payload: { active: false }
    });
    expect(disableResponse.statusCode).toBe(200);
    expect(disableResponse.json().example).toMatchObject({ exampleId: example.exampleId, active: false });

    await db.adapter.query(
      `INSERT INTO review_tasks (
         task_id, package_id, component_id, severity, status, task_kind, rule_id,
         title, description, suggested_action, candidates, confidence, context_snapshot, created_at
       )
       VALUES (
         'task_annotation_repeat','pkg_rev','cmp_rev','warning','open','annotation','wiki.required_fact',
         '字段候选再次不确定','同组件同规则再次出现','参考上次人工标注',
         '[]',0.6,'{}',NOW()
       )`
    );

    const listed = await app.inject({
      method: "GET",
      url: "/api/review/tasks?status=open",
      headers: auth,
    });
    const repeat = listed.json().tasks.find((item: { taskId: string }) => item.taskId === "task_annotation_repeat");
    expect(repeat.learning).toMatchObject({
      recurrenceCount: 1,
      exampleCount: 1,
      lastAnnotation: {
        createdBy: "admin",
        correctValue: { field: "activity_structure", source: "candidate" }
      }
    });

    const afterRepeatResponse = await app.inject({ method: "GET", url: "/api/legislation/annotation-examples", headers: auth });
    const afterRepeat = afterRepeatResponse.json().examples.find((item: { taskId: string }) => item.taskId === "task_annotation");
    expect(afterRepeat.effect).toMatchObject({
      tasksAfter: 1,
      openTasksAfter: 1,
      openTaskIds: ["task_annotation_repeat"],
      status: "needs_review"
    });

    const reviewResponse = await app.inject({
      method: "POST",
      url: `/api/legislation/annotation-examples/${encodeURIComponent(example.exampleId)}/review`,
      headers: auth,
      payload: {}
    });
    expect(reviewResponse.statusCode).toBe(200);
    const reviewTask = reviewResponse.json().task;
    expect(reviewTask).toMatchObject({
      componentId: "cmp_rev",
      taskKind: "annotation",
      ruleId: "annotation_example.review",
      status: "open"
    });
    expect(reviewTask.contextSnapshot).toMatchObject({ exampleId: example.exampleId, createdBy: "admin" });

    const sameReviewResponse = await app.inject({
      method: "POST",
      url: `/api/legislation/annotation-examples/${encodeURIComponent(example.exampleId)}/review`,
      headers: auth,
      payload: {}
    });
    expect(sameReviewResponse.json().task.taskId).toBe(reviewTask.taskId);

    const afterReviewResponse = await app.inject({ method: "GET", url: "/api/legislation/annotation-examples", headers: auth });
    const afterReview = afterReviewResponse.json().examples.find((item: { taskId: string }) => item.taskId === "task_annotation");
    expect(afterReview.effect.reviewTaskId).toBe(reviewTask.taskId);

    const promoteResponse = await app.inject({
      method: "POST",
      url: "/api/review/tasks/annotate",
      headers: auth,
      payload: {
        taskId: reviewTask.taskId,
        selectedCandidateId: "promote_annotation_override",
        note: "复盘后转为确定性覆盖"
      }
    });
    expect(promoteResponse.statusCode).toBe(200);
    expect(promoteResponse.json().task).toMatchObject({
      taskId: reviewTask.taskId,
      status: "resolved",
      annotatedBy: "admin",
      annotationValue: {
        action: "promote_annotation_override",
        exampleId: example.exampleId,
        previousApplyMode: "hint",
        previousActive: false
      }
    });
    expect(promoteResponse.json().example).toMatchObject({
      exampleId: example.exampleId,
      applyMode: "override",
      active: true
    });

    const exampleRows = await db.adapter.query("SELECT * FROM annotation_examples WHERE example_id = $1", [example.exampleId]);
    expect(exampleRows.rows[0].apply_mode).toBe("override");
    expect(exampleRows.rows[0].active).toBe(true);

    const reviewEvents = await db.adapter.query("SELECT * FROM knowledge_events WHERE event_type = $1", ["annotation.review_resolved"]);
    expect(reviewEvents.rows[0].payload_json).toMatchObject({
      taskId: reviewTask.taskId,
      action: "promote_annotation_override",
      componentId: "cmp_rev"
    });
    const writebackEvents = await db.adapter.query(
      "SELECT * FROM knowledge_events WHERE event_type = $1 AND entity_id = $2",
      ["annotation.writeback_requested", reviewTask.taskId]
    );
    expect(writebackEvents.rows).toHaveLength(1);

    const lifecycleResponse = await app.inject({ method: "GET", url: "/api/legislation/annotation-examples", headers: auth });
    const lifecycleExample = lifecycleResponse.json().examples.find((item: { exampleId: string }) => item.exampleId === example.exampleId);
    expect(lifecycleExample.lifecycle).toMatchObject({
      lastReviewAction: "promote_annotation_override",
      lastReviewedBy: "admin",
      reviewTaskId: reviewTask.taskId,
      writebackRequested: true,
      writebackTaskId: reviewTask.taskId
    });
    expect(lifecycleExample.lifecycle.writeback).toMatchObject({
      exampleId: example.exampleId,
      runId: "",
      autoPublishStatus: "none"
    });
    expect(lifecycleExample.lifecycle.lastReviewedAt).toBeTruthy();
    expect(lifecycleExample.lifecycle.writebackRequestedAt).toBeTruthy();
    expect(lifecycleExample.lifecycle.summary).toContain("已请求回写");

    await db.adapter.query(
      `INSERT INTO source_bundle_versions (version_id, bundle_id, label, note, created_by, created_at)
       VALUES ('ver_trace','default','Trace','x','admin',NOW())
       ON CONFLICT (version_id) DO NOTHING`
    );
    await db.adapter.query(
      `INSERT INTO knowledge_build_runs
         (run_id, source_version_id, package_id, adapter, stages, model, wiki_specs_hash, quality_profile_id, status, completed_stages, finished_at, output_uri, config_json)
       VALUES
         ('run_trace','ver_trace','pkg_rev','native','["extract"]','deterministic','hash','default','completed','["extract"]',NOW(),'data/kb-build-runs/run_trace','{"only":"gamedocs/pvp.md"}')`
    );
    await db.adapter.query(
      `INSERT INTO knowledge_events (event_id, event_type, entity_type, entity_id, payload_json, created_at)
       VALUES
         ('ev_trace_started','annotation.writeback_rebuild_started','build_run','run_trace',$1,NOW()),
         ('ev_trace_completed','build.completed','build_run','run_trace',$2,NOW())`,
      [
        JSON.stringify({ taskId: reviewTask.taskId, exampleId: example.exampleId, runId: "run_trace", only: "gamedocs/pvp.md" }),
        JSON.stringify({ runId: "run_trace", packageId: "pkg_rev" }),
      ]
    );

    const tracedLifecycleResponse = await app.inject({ method: "GET", url: "/api/legislation/annotation-examples", headers: auth });
    const tracedLifecycleExample = tracedLifecycleResponse.json().examples.find((item: { exampleId: string }) => item.exampleId === example.exampleId);
    expect(tracedLifecycleExample.lifecycle.writeback).toMatchObject({
      runId: "run_trace",
      runStatus: "completed",
      runPackageId: "pkg_rev",
      only: "gamedocs/pvp.md"
    });

    const runsResponse = await app.inject({ method: "GET", url: "/api/build-runs", headers: auth });
    const traceRun = runsResponse.json().runs.find((item: { runId: string }) => item.runId === "run_trace");
    expect(traceRun.writebackTraces[0]).toMatchObject({
      taskId: reviewTask.taskId,
      exampleId: example.exampleId,
      runId: "run_trace",
      taskRuleId: "annotation_example.review",
      componentId: "cmp_rev"
    });
  });

  it("rejects viewers", async () => {
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "viewer", password: "viewpw" } });
    const viewerToken = login.json<{ token: string }>().token;
    const denied = await app.inject({
      method: "POST",
      url: "/api/review/tasks/transition",
      headers: { authorization: `Bearer ${viewerToken}` },
      payload: { taskIds: ["task_block"], status: "open" }
    });
    expect(denied.statusCode).toBe(403);
  });
});
