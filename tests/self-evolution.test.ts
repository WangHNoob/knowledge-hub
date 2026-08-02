import { describe, expect, it } from "vitest";

import { createAttributionAuditService } from "../src/server/services/attributionAuditService";
import { createFeedbackService } from "../src/server/services/feedbackService";
import { createGapFillCandidateService } from "../src/server/services/gapFillCandidateService";
import { createGovernanceProfileService } from "../src/server/services/governanceProfileService";
import { createKnowledgeService } from "../src/server/services/knowledgeService";
import { createReleaseService } from "../src/server/services/releaseService";
import { emitKnowledgeEvent } from "../src/server/services/eventService";
import type { ReleaseRecord } from "../src/server/types";
import { createTestDb } from "./helpers/testDb";

function stubRelease(overrides: Partial<ReleaseRecord> = {}): ReleaseRecord {
  return {
    releaseId: "rel_gap",
    projectId: "default_project",
    parentReleaseId: null,
    version: "0.0.1",
    status: "published",
    packageIds: [],
    note: "",
    publishedAt: new Date().toISOString(),
    publishedBy: "admin",
    createdBy: "admin",
    createdAt: new Date().toISOString(),
    manifestHash: "",
    manifest: {},
    qualityGate: {},
    ...overrides,
  };
}

describe("self-evolution flywheel extensions", () => {
  it("records untargeted gaps as fill candidates without binding a random component", async () => {
    const { db, cleanup } = await createTestDb();
    try {
      await db.adapter.query(
        `INSERT INTO releases (release_id, project_id, version, status, package_ids, published_at, published_by, created_by, created_at)
         VALUES ('rel_gap', 'default_project', '0.0.1', 'published', '[]'::jsonb, NOW(), 'admin', 'admin', NOW())`,
      );
      const result = await createFeedbackService(db).recordExplicitFeedback({
        release: stubRelease(),
        toolName: "kb_report_gap",
        payload: { query: "missing stamina system", expected: "stamina wiki", reason: "no page" },
        feedbackType: "knowledge_gap",
        hitComponentIds: [],
      });
      expect(result.targetComponentId).toBeNull();
      expect(result.taskId).toBeNull();

      const candidates = await createGapFillCandidateService(db).listOpen("default_project");
      expect(candidates).toHaveLength(1);
      expect(candidates[0].queryRaw).toContain("missing stamina");
      expect(candidates[0].status).toBe("open");
      expect(candidates[0].expected).toContain("stamina wiki");
    } finally {
      await cleanup();
    }
  }, 20000);

  it("writes attribution ungrounded segments into evidence tasks and gap candidates", async () => {
    const { db, cleanup } = await createTestDb();
    try {
      await db.adapter.query(
        `INSERT INTO asset_packages (package_id, project_id, name, kind, status, description, created_by_run_id, source_version_ids, quality_summary)
         VALUES ('pkg_attr', 'default_project', 'Attr Pack', 'kb', 'ready', '', 'run_attr', '[]'::jsonb, '{}'::jsonb)`,
      );
      await db.adapter.query(
        `INSERT INTO asset_components (component_id, package_id, kind, group_name, title, artifact_id, status)
         VALUES ('cmp_attr', 'pkg_attr', 'wiki_page', 'wiki', 'Attr Page', 'art_attr', 'ready')`,
      );
      await db.adapter.query(
        `INSERT INTO releases (release_id, project_id, version, status, package_ids, published_at, published_by, created_by, created_at)
         VALUES ('rel_attr', 'default_project', '0.0.2', 'published', '["pkg_attr"]'::jsonb, NOW(), 'admin', 'admin', NOW())`,
      );

      const service = createAttributionAuditService(db);
      const audit = await service.createAudit({
        releaseId: "rel_attr",
        projectId: "default_project",
        createdBy: "agent",
        title: "ungrounded output",
        segments: [
          { text: "cited", trace: { componentIds: ["cmp_attr"], evidenceIds: ["ev_1"] } },
          { text: "derived without evidence", trace: { componentIds: ["cmp_attr"], evidenceIds: [] } },
          { text: "pure creation", trace: {} },
        ],
      });
      expect(audit.segments.map((s) => s.attributionType)).toEqual(["引用", "推导", "创作"]);

      const { rows: tasks } = await db.adapter.query(
        `SELECT rule_id, severity, status FROM review_tasks
         WHERE component_id = 'cmp_attr' AND rule_id = 'attribution.ungrounded_segment'`,
      );
      expect(tasks).toHaveLength(1);
      expect(tasks[0].severity).toBe("blocking");

      const gaps = await createGapFillCandidateService(db).listOpen("default_project");
      expect(gaps.some((g) => g.queryRaw.includes(audit.auditId))).toBe(true);

      const stats = await service.getStats("default_project");
      expect(stats.totalSegments).toBe(3);
      expect(stats.byType["创作"]).toBe(1);
      expect(stats.creationRatio).toBeCloseTo(1 / 3);
    } finally {
      await cleanup();
    }
  }, 20000);

  it("exposes pilot metrics including skip reason distribution", async () => {
    const { db, cleanup } = await createTestDb();
    try {
      await emitKnowledgeEvent(db, {
        eventType: "release.auto_publish_skipped",
        entityType: "release",
        entityId: "rel_skip",
        payload: {
          projectId: "default_project",
          releaseId: "rel_skip",
          reasonDetails: [{ code: "retrieval_eval_regression", label: "检索黄金集回归未通过" }],
        },
      });
      await emitKnowledgeEvent(db, {
        eventType: "knowledge_lint.alias_remediated",
        entityType: "release",
        entityId: "rel_alias",
        payload: { projectId: "default_project", appliedAliases: [{ alias: "战斗表", canonical: "battle" }] },
      });
      await emitKnowledgeEvent(db, {
        eventType: "release.auto_publish_succeeded",
        entityType: "release",
        entityId: "rel_ok",
        payload: { projectId: "default_project", releaseId: "rel_ok" },
      });

      const summary = await createKnowledgeService(db).getFlywheelConvergenceSummary("default_project");
      expect(summary.pilot).toBeDefined();
      expect(summary.pilot!.skipReasonDistribution.some((item) => item.code === "retrieval_eval_regression")).toBe(true);
      expect(summary.pilot!.aliasRemediation.applied).toBe(1);
      expect(summary.pilot!.aliasRemediation.successRate).toBe(1);
      expect(summary.automation.autoPublished).toBe(1);
      expect(summary.automation.autoSkipped).toBe(1);
    } finally {
      await cleanup();
    }
  }, 20000);

  it("resolves retrieval eval governance defaults for auto-publish gate", async () => {
    const { db, cleanup } = await createTestDb();
    try {
      const governance = createGovernanceProfileService(db, {
        evalEnabled: true,
        evalBlockOnRegression: true,
        evalMinHitAtK: 0.99,
        evalGoldPath: "evals/retrieval-gold.json",
      });
      const releaseService = createReleaseService(db, process.cwd(), undefined, governance, async () => ({
        hitAtK: 0.1,
        citationCoverage: 0.1,
        trustPassRate: 1,
        total: 2,
      }));
      const profile = await governance.resolve("default_project");
      expect(profile.eval.enabled).toBe(true);
      expect(profile.eval.minHitAtK).toBe(0.99);
      expect(releaseService).toBeTruthy();
    } finally {
      await cleanup();
    }
  }, 20000);
});
