import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProjectService } from "../src/server/services/projectService";
import { createKnowledgeQueryService } from "../src/server/services/knowledgeQueryService";
import { runHealthSweepOnce } from "../src/server/services/healthSweepScheduler";
import type { DatabaseHandle } from "../src/server/types";
import { createTestDb } from "./helpers/testDb";

describe("health sweep scheduler", () => {
  let db: DatabaseHandle;
  let cleanup: () => Promise<void>;
  let dir: string;

  beforeEach(async () => {
    const handle = await createTestDb();
    db = handle.db;
    cleanup = handle.cleanup;
    dir = mkdtempSync(join(tmpdir(), "kh-health-sweep-"));
  });

  afterEach(async () => {
    await cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs a health check for every project and records an auditable event", async () => {
    const projectService = createProjectService(db);
    const queryService = createKnowledgeQueryService(db, dir);

    const results = await runHealthSweepOnce({ projectService, queryService });

    // 至少覆盖默认项目，并返回其巡检状态（无发布版本时为 needs_attention）。
    const defaultResult = results.find((r) => r.projectId === "default_project");
    expect(defaultResult).toBeDefined();
    expect(defaultResult?.status).toBe("needs_attention");

    // 可审计：巡检结果落 knowledge_lint.health_checked 事件，进入自动化历史。
    const { rows } = await db.adapter.query(
      "SELECT count(*)::int AS n FROM knowledge_events WHERE project_id = 'default_project' AND event_type = 'knowledge_lint.health_checked'",
    );
    expect(Number(rows[0]?.n ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it("does not throw when a project sweep is retried (idempotent event emission)", async () => {
    const projectService = createProjectService(db);
    const queryService = createKnowledgeQueryService(db, dir);

    await runHealthSweepOnce({ projectService, queryService });
    await runHealthSweepOnce({ projectService, queryService });

    // 两轮巡检各记录一次事件（周期巡检会持续累积可审计历史）。
    const { rows } = await db.adapter.query(
      "SELECT count(*)::int AS n FROM knowledge_events WHERE project_id = 'default_project' AND event_type = 'knowledge_lint.health_checked'",
    );
    expect(Number(rows[0]?.n ?? 0)).toBeGreaterThanOrEqual(2);
  });
});
