import { describe, expect, it } from "vitest";

import {
  flagLowConsumptionStale,
  getConsumptionStatsByComponent,
  isZeroConsumption,
} from "../src/server/services/consumptionMetricsService";
import { createTestDb } from "./helpers/testDb";

async function seedReleaseWithComponents(db: { adapter: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> } }, opts: {
  publishedDaysAgo?: number;
  components?: string[];
} = {}) {
  const publishedDaysAgo = opts.publishedDaysAgo ?? 60;
  const components = opts.components ?? ["cmp_a", "cmp_b"];
  await db.adapter.query(
    `INSERT INTO asset_packages (package_id, name, kind, status, description, created_by_run_id, source_version_ids, legacy_paths, quality_summary, created_at)
     VALUES ('pkg_r5', 'R5 Pkg', 'kb_builder_pipeline', 'published', 'r5 fixture', 'run_r5', '[]', '[]', '{}', NOW())`,
  );
  await db.adapter.query(
    `INSERT INTO releases (release_id, project_id, version, status, package_ids, manifest_json, created_by, created_at, published_at)
     VALUES ('rel_r5', 'default_project', 'v-r5', 'published', '["pkg_r5"]', $1, 'admin', NOW() - ($2 || ' days')::interval, NOW() - ($2 || ' days')::interval)`,
    [JSON.stringify({ componentIds: components }), publishedDaysAgo],
  );
  await db.adapter.query(
    `INSERT INTO release_channels (channel_id, project_id, current_release_id, updated_by, updated_at)
     VALUES ('default', 'default_project', 'rel_r5', 'admin', NOW())
     ON CONFLICT (channel_id) DO UPDATE SET current_release_id = EXCLUDED.current_release_id`,
  );
  for (const componentId of components) {
    await db.adapter.query(
      `INSERT INTO asset_components (component_id, package_id, artifact_id, group_name, kind, title, status, legacy_path, storage_uri, source_refs, quality)
       VALUES ($1, 'pkg_r5', $2, 'wiki', 'wiki_page', $3, 'published', '', '', '[]', '{}')`,
      [componentId, `wiki/${componentId}.md`, `页面 ${componentId}`],
    );
  }
}

describe("consumption metrics + R5 stale signal (flywheel 02 收尾)", () => {
  it("isZeroConsumption treats missing stats as zero", () => {
    expect(isZeroConsumption(undefined)).toBe(true);
    expect(isZeroConsumption({ attributionCount: 0, searchCount: 0, clickCount: 0, negativeFeedbackCount: 3 })).toBe(true);
    expect(isZeroConsumption({ attributionCount: 1, searchCount: 0, clickCount: 0, negativeFeedbackCount: 0 })).toBe(false);
    expect(isZeroConsumption({ attributionCount: 0, searchCount: 2, clickCount: 0, negativeFeedbackCount: 0 })).toBe(false);
  });

  it("flags zero-consumption components with dedupe and audits via knowledge_events", async () => {
    const fixture = await createTestDb();
    try {
      await seedReleaseWithComponents(fixture.db);
      // cmp_b 有检索消费 → 不标；cmp_a 零消费 → 标 stale
      await fixture.db.adapter.query(
        `INSERT INTO mcp_audit (audit_id, project_id, tool_name, release_id, query_payload, hit_component_ids, quality_flags, status, latency_ms, created_at)
         VALUES ('audit_b', 'default_project', 'kb_search', 'rel_r5', '{}', '["cmp_b"]', '[]', 'hit', 10, NOW())`,
      );

      const first = await flagLowConsumptionStale(fixture.db, "default_project", { actor: "test" });
      expect(first.flagged).toBe(1);
      expect(first.sample[0]?.componentId).toBe("cmp_a");

      const { rows: tasks } = await fixture.db.adapter.query(
        "SELECT rule_id, component_id, status FROM review_tasks WHERE rule_id = 'agent_feedback.stale_candidate'",
      );
      expect(tasks).toHaveLength(1);
      expect(String(tasks[0]!.component_id)).toBe("cmp_a");

      const { rows: events } = await fixture.db.adapter.query(
        "SELECT feedback_type FROM agent_events WHERE feedback_type = 'stale_knowledge'",
      );
      expect(events.length).toBeGreaterThan(0);

      const { rows: knowledgeEvents } = await fixture.db.adapter.query(
        "SELECT event_type FROM knowledge_events WHERE event_type = 'knowledge_lint.stale_candidate'",
      );
      expect(knowledgeEvents).toHaveLength(1);

      // 幂等：再次运行不再新建任务/事件
      const second = await flagLowConsumptionStale(fixture.db, "default_project", { actor: "test" });
      expect(second.flagged).toBe(0);
      const { rows: tasksAfter } = await fixture.db.adapter.query(
        "SELECT COUNT(*)::int AS c FROM review_tasks WHERE rule_id = 'agent_feedback.stale_candidate'",
      );
      expect(Number(tasksAfter[0]!.c)).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  }, 20000);

  it("skips releases younger than the min age (新知识不误标)", async () => {
    const fixture = await createTestDb();
    try {
      await seedReleaseWithComponents(fixture.db, { publishedDaysAgo: 5 });
      const result = await flagLowConsumptionStale(fixture.db, "default_project", { actor: "test" });
      expect(result.flagged).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  }, 20000);

  it("getConsumptionStatsByComponent aggregates clicks and searches", async () => {
    const fixture = await createTestDb();
    try {
      await seedReleaseWithComponents(fixture.db, { components: ["cmp_x"] });
      await fixture.db.adapter.query(
        `INSERT INTO mcp_audit (audit_id, project_id, tool_name, release_id, query_payload, hit_component_ids, quality_flags, status, latency_ms, created_at)
         VALUES ('a1','default_project','kb_search','rel_r5','{}','["cmp_x"]','[]','hit',1,NOW()),
                ('a2','default_project','kb_search','rel_r5','{}','["cmp_x"]','[]','hit',1,NOW()),
                ('a3','default_project','kb_get_page','rel_r5','{}','["cmp_x"]','[]','hit',1,NOW())`,
      );
      const stats = await getConsumptionStatsByComponent(fixture.db, "default_project", ["cmp_x"]);
      const s = stats.get("cmp_x");
      expect(s).toEqual({ attributionCount: 0, searchCount: 2, clickCount: 1, negativeFeedbackCount: 0 });
      expect(isZeroConsumption(s)).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  }, 20000);
});
