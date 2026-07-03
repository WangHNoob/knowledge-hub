import { describe, expect, it } from "vitest";

import { emitKnowledgeEvent } from "../src/server/services/eventService";
import { createKnowledgeService } from "../src/server/services/knowledgeService";
import { registerAutoRemediation } from "../src/server/services/autoRemediationService";
import type { DiagnosticLogger } from "../src/server/services/diagnosticService";
import type { DatabaseHandle } from "../src/server/types";
import type { LlmClient, LlmCompletionRequest, LlmCompletionResult } from "../src/server/services/kbBuilder/llmClient";
import type { PipelineModelConfig } from "../src/server/services/kbBuilder/modelConfig";
import { createTestDb } from "./helpers/testDb";

describe("AutoRemediationService", () => {
  it("auto-fixes high-confidence structurally valid remediation output", async () => {
    const { db, cleanup } = await createTestDb();
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    const fixture = await insertAutoRemediationFixture(db);
    const unsubscribe = registerAutoRemediation({
      db,
      knowledgeService: createKnowledgeService(db),
      diagnostics: diagnosticStub(),
      llmClientFactory: () => fixedClient(remediationJson({
        fixType: "annotation_override",
        confidence: 0.92,
        correctValue: {
          markdown: "# Battle System\n\nStamina controls skill usage and recovery. This corrected page is grounded in the feedback.",
          facts: { source: "gamedocs/battle.md" }
        }
      }))
    });

    try {
      await emitFeedback(db, fixture);
      const task = await waitForTask(db, fixture.taskId, (row) => row.auto_fixed === true);
      expect(task.status).toBe("resolved");
      expect(task.auto_fixed).toBe(true);
      expect(task.llm_analysis.confidence).toBeGreaterThanOrEqual(0.9);

      const { rows: examples } = await db.adapter.query("SELECT * FROM annotation_examples WHERE task_id = $1", [fixture.taskId]);
      expect(examples).toHaveLength(1);
      expect(examples[0].auto_generated).toBe(true);
      expect(examples[0].correct_value.markdown).toContain("Stamina controls");
    } finally {
      unsubscribe();
      restoreEnv("OPENAI_API_KEY", previousKey);
      await cleanup();
    }
  }, 15000);

  it("keeps high-confidence but structurally invalid remediation for human review", async () => {
    const { db, cleanup } = await createTestDb();
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    const fixture = await insertAutoRemediationFixture(db);
    const unsubscribe = registerAutoRemediation({
      db,
      knowledgeService: createKnowledgeService(db),
      diagnostics: diagnosticStub(),
      llmClientFactory: () => fixedClient(remediationJson({
        fixType: "annotation_override",
        confidence: 0.96,
        correctValue: { facts: { source: "gamedocs/battle.md" } }
      }))
    });

    try {
      await emitFeedback(db, fixture);
      const task = await waitForTask(db, fixture.taskId, (row) => Array.isArray(row.candidates) && row.candidates.length > 1);
      expect(task.status).toBe("open");
      expect(task.auto_fixed).toBe(false);
      expect(task.candidates[0].label).toContain("未自动执行");

      const { rows: examples } = await db.adapter.query("SELECT * FROM annotation_examples WHERE task_id = $1", [fixture.taskId]);
      expect(examples).toHaveLength(0);
    } finally {
      unsubscribe();
      restoreEnv("OPENAI_API_KEY", previousKey);
      await cleanup();
    }
  }, 15000);
});

async function insertAutoRemediationFixture(db: DatabaseHandle): Promise<{ packageId: string; componentId: string; taskId: string }> {
  const packageId = "pkg_auto_remediation_test";
  const componentId = "cmp_auto_remediation_wiki";
  const taskId = "task_auto_remediation_test";
  await db.adapter.query(
    `INSERT INTO asset_packages
      (package_id, project_id, name, kind, status, description, created_by_run_id, source_version_ids, legacy_paths, quality_summary)
     VALUES ($1,'default_project','Auto remediation fixture','native','draft','fixture','run_auto_remediation_test','[]','[]','{}')`,
    [packageId]
  );
  await db.adapter.query(
    `INSERT INTO asset_components
      (component_id, package_id, artifact_id, group_name, kind, title, status, legacy_path, storage_uri, source_refs, quality)
     VALUES ($1,$2,'wiki/battle.md','wiki','wiki_page','Battle System','draft','wiki/battle.md','data/wiki/battle.md',$3,$4)`,
    [
      componentId,
      packageId,
      JSON.stringify(["gamedocs/battle.md"]),
      JSON.stringify({
        preview: "# Battle System\n\nOutdated stamina note.",
        facts: { source: "gamedocs/battle.md" }
      })
    ]
  );
  await db.adapter.query(
    `INSERT INTO review_tasks
      (task_id, project_id, package_id, component_id, severity, status, title, description, suggested_action, task_kind, rule_id, candidates, confidence, context_snapshot)
     VALUES ($1,'default_project',$2,$3,'warning','open','MCP 低可信命中 Battle stamina','Agent feedback says stamina page is incomplete.','修正 wiki 内容。','annotation','agent_feedback.low_quality_hit',$4,0.72,$5)`,
    [
      taskId,
      packageId,
      componentId,
      JSON.stringify([{ id: "manual", label: "人工修复", value: { action: "manual" }, confidence: 0.5, rationale: "fallback" }]),
      JSON.stringify({ pageType: "system_rule", sourceFile: "gamedocs/battle.md" })
    ]
  );
  return { packageId, componentId, taskId };
}

async function emitFeedback(db: DatabaseHandle, fixture: { componentId: string; taskId: string }) {
  await emitKnowledgeEvent(db, {
    eventType: "agent.feedback.received",
    entityType: "component",
    entityId: fixture.componentId,
    payload: {
      projectId: "default_project",
      releaseId: "rel_test",
      componentId: fixture.componentId,
      taskId: fixture.taskId,
      feedbackType: "low_quality_hit",
      query: "Battle stamina",
      suggestedAction: "修正体力规则页面"
    }
  });
}

async function waitForTask(
  db: DatabaseHandle,
  taskId: string,
  predicate: (row: Record<string, any>) => boolean
): Promise<Record<string, any>> {
  let last: Record<string, any> | null = null;
  for (let i = 0; i < 40; i += 1) {
    const { rows } = await db.adapter.query("SELECT * FROM review_tasks WHERE task_id = $1", [taskId]);
    last = rows[0] ?? null;
    if (last && predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for task ${taskId}. Last=${JSON.stringify(last)}`);
}

function remediationJson(input: { fixType: "annotation_override" | "needs_human" | "no_fix"; confidence: number; correctValue: Record<string, unknown> }): string {
  return JSON.stringify({
    diagnosis: "The component is stale for the Agent query.",
    fixType: input.fixType,
    confidence: input.confidence,
    correctValueJson: JSON.stringify(input.correctValue),
    rationale: "The corrected value follows the provided component and feedback context.",
    suggestions: []
  });
}

function fixedClient(text: string): LlmClient {
  return {
    provider: "openai-compatible",
    model: "test-model",
    complete: async (_request: LlmCompletionRequest): Promise<LlmCompletionResult> => ({ text }),
    ping: async () => {}
  };
}

function diagnosticStub(): DiagnosticLogger {
  return {
    write: async () => {},
    startSpan: () => ({
      complete: async () => {},
      fail: async () => {}
    })
  } as unknown as DiagnosticLogger;
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
