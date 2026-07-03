import { describe, expect, it } from "vitest";

import { createLintRemediationService } from "../src/server/services/lintRemediationService";
import { createGovernanceProfileService } from "../src/server/services/governanceProfileService";
import { createFlywheelService } from "../src/server/services/flywheelService";
import { createKnowledgeService } from "../src/server/services/knowledgeService";
import { createSourceBundleService } from "../src/server/services/sourceBundleService";
import { createKbBuilderPipelineService } from "../src/server/services/kbBuilderService";
import { createReleaseService } from "../src/server/services/releaseService";
import { createProjectService } from "../src/server/services/projectService";
import type { KnowledgeLintReport } from "../src/server/services/okf/lintService";
import { createTestDb } from "./helpers/testDb";

function lintReport(): KnowledgeLintReport {
  const gov = (over: Partial<KnowledgeLintReport["issues"][number]["governance"]>) => ({
    source: "llm" as const,
    confidence: 0.9,
    actionType: "auto_remediation" as const,
    autoEligible: true,
    diagnosis: "d",
    risk: "r",
    remediation: "fix it",
    rationale: "x",
    ...over,
  });
  return {
    version: 1,
    generatedAt: "2026-07-03T00:00:00.000Z",
    releaseId: "rel_gov",
    summary: { score: 0.8, blocking: 0, warning: 3, info: 0 },
    domains: {
      links: { blocking: 0, warning: 1, info: 0, total: 1 },
      evidence: { blocking: 0, warning: 0, info: 0, total: 0 },
      graph: { blocking: 0, warning: 1, info: 0, total: 1 },
      trust: { blocking: 0, warning: 0, info: 0, total: 0 },
      table_dependencies: { blocking: 0, warning: 0, info: 0, total: 0 },
      mcp_feedback: { blocking: 0, warning: 1, info: 0, total: 1 },
    },
    governance: { source: "llm", analyzed: 3, autoEligible: 1, manualReview: 1, rebuild: 1, monitor: 0, warnings: [] },
    issues: [
      { id: "links_fmt_1", domain: "links", severity: "warning", title: "断链格式", message: "m", suggestedAction: "s", componentId: "cmp_lint_target", okfPath: "wiki/concepts/hero.md", governance: gov({ actionType: "auto_remediation", autoEligible: true }) },
      { id: "graph_rebuild_1", domain: "graph", severity: "warning", title: "图谱需要重建", message: "m", suggestedAction: "s", governance: gov({ actionType: "rebuild", autoEligible: false }) },
      { id: "mcp_manual_1", domain: "mcp_feedback", severity: "warning", title: "高频 miss", message: "m", suggestedAction: "s", componentId: "cmp_pkg_x_hero", governance: gov({ actionType: "manual_review", autoEligible: false }) },
    ],
  };
}

describe("lint remediation queue", () => {
  it("records governance decisions as a tracked queue and summarizes them", async () => {
    const fixture = await createTestDb();
    try {
      const service = createLintRemediationService(fixture.db);
      const recorded = await service.recordFromReport({ projectId: "default_project", releaseId: "rel_gov", report: lintReport() });
      expect(recorded).toHaveLength(3);

      const byIssue = Object.fromEntries(recorded.map((r) => [r.issueId, r]));
      expect(byIssue.links_fmt_1.status).toBe("pending");
      expect(byIssue.links_fmt_1.autoEligible).toBe(true);
      expect(byIssue.graph_rebuild_1.status).toBe("needs_human");
      expect(byIssue.mcp_manual_1.status).toBe("needs_human");

      const summary = await service.summary("default_project", "rel_gov");
      expect(summary.total).toBe(3);
      expect(summary.autoGoverned).toBe(0);
      expect(summary.needsHuman).toBe(2);
      expect(summary.byStatus.pending).toBe(1);

      const rebuildRequests: Array<{ componentId: string; requestedBy: string; sourcePath?: string }> = [];
      const executed = await service.executePending({
        projectId: "default_project",
        releaseId: "rel_gov",
        requestedBy: "system",
        kbBuilderService: {
          startScopedRebuildForComponent: async (input) => {
            rebuildRequests.push(input);
            return { runId: "run_lint_1" } as Awaited<ReturnType<ReturnType<typeof createKbBuilderPipelineService>["startScopedRebuildForComponent"]>>;
          },
        },
      });
      expect(executed).toHaveLength(1);
      expect(executed[0].status).toBe("running");
      expect(executed[0].runId).toBe("run_lint_1");
      expect(rebuildRequests).toEqual([{ componentId: "cmp_lint_target", requestedBy: "system", sourcePath: "wiki/concepts/hero.md" }]);

      await service.markCompletedByRunId("run_lint_1");
      const completedSummary = await service.summary("default_project", "rel_gov");
      expect(completedSummary.autoGoverned).toBe(1);
      expect(completedSummary.pending).toBe(0);

      // 再次记录同一报告应幂等（不重复插入）。
      const again = await service.recordFromReport({ projectId: "default_project", releaseId: "rel_gov", report: lintReport() });
      expect(again).toHaveLength(3);
      const listed = await service.listRemediations({ projectId: "default_project", releaseId: "rel_gov" });
      expect(listed).toHaveLength(3);

      const needsHuman = await service.listRemediations({ projectId: "default_project", status: "needs_human" });
      expect(needsHuman).toHaveLength(2);
    } finally {
      await fixture.cleanup();
    }
  }, 20000);
});

describe("agent feedback clusters", () => {
  it("aggregates negative MCP events into business-facing clusters", async () => {
    const fixture = await createTestDb();
    try {
      const now = new Date().toISOString();
      // 两次同一 miss 查询 → 一个 knowledge_gap 簇（高频）。
      for (let i = 0; i < 2; i += 1) {
        await fixture.db.adapter.query(
          `INSERT INTO agent_events (event_id, project_id, release_id, query, hit_component_ids, quality_flags, status, feedback_type, suggested_action, task_id, created_at)
           VALUES ($1,'default_project','rel_1',$2,'[]','[]','miss','miss','s','',$3)`,
          [`evt_miss_${i}`, "kb_search:荣耀连战", now],
        );
      }
      // 一次低质命中 → 一个 low_trust_hit 簇。
      await fixture.db.adapter.query(
        `INSERT INTO agent_events (event_id, project_id, release_id, query, hit_component_ids, quality_flags, status, feedback_type, suggested_action, task_id, created_at)
         VALUES ('evt_lq','default_project','rel_1','kb_search:竞技狂欢','["cmp_pkg_a_arena"]','["low_trust:0.4"]','hit','low_quality_hit','s','',$1)`,
        [now],
      );

      const flywheel = createFlywheelService({
        db: fixture.db,
        knowledgeService: createKnowledgeService(fixture.db),
        bundleService: createSourceBundleService(fixture.db, "."),
        kbBuilderService: createKbBuilderPipelineService(fixture.db, "."),
        releaseService: createReleaseService(fixture.db, "."),
        projectService: createProjectService(fixture.db),
        lintRemediationService: createLintRemediationService(fixture.db),
        governanceProfileService: createGovernanceProfileService(fixture.db),
      });

      const clusters = await flywheel.listFeedbackClusters("default_project");
      const gap = clusters.find((c) => c.type === "knowledge_gap");
      const lowTrust = clusters.find((c) => c.type === "low_trust_hit");

      expect(gap).toBeTruthy();
      expect(gap?.count).toBe(2);
      expect(gap?.severity).toBe("blocking");
      expect(gap?.queryExamples).toContain("荣耀连战");
      expect(gap?.primaryAction.type).toBe("rerun");

      expect(lowTrust).toBeTruthy();
      expect(lowTrust?.primaryAction.type).toBe("annotate");
    } finally {
      await fixture.cleanup();
    }
  }, 20000);
});
