import { describe, expect, it } from "vitest";

import {
  FEEDBACK_CLUSTER_MAX_CANDIDATES,
  FEEDBACK_CLUSTER_SIMILARITY_THRESHOLD,
  hashClusterQuery,
  normalizeClusterQuery,
  resolveFeedbackClusterKey,
} from "../src/server/services/feedbackClusterService";
import { DenseModelUnavailableError } from "../src/server/services/okf/denseIndexV2";
import { createTestDb } from "./helpers/testDb";

/** 可编程 embedding：query → 固定向量，用于构造确定性的相似/不相似。 */
function embedderFor(vectors: Record<string, number[]>) {
  return {
    async embed(texts: string[]) {
      return texts.map((text) => vectors[text] ?? [0, 0, 0]);
    },
  };
}

async function insertEvent(db: { adapter: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> } }, row: {
  projectId: string;
  feedbackType: string;
  query: string;
  clusterKey: string;
  createdAt?: string;
}) {
  await db.adapter.query(
    `INSERT INTO agent_events
      (event_id, project_id, release_id, query, hit_component_ids, quality_flags, status, feedback_type, suggested_action, task_id, cluster_key, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      `evt_test_${Math.random().toString(36).slice(2, 8)}`,
      row.projectId,
      "rel_test",
      row.query,
      "[]",
      "[]",
      "miss",
      row.feedbackType,
      "action",
      "",
      row.clusterKey,
      row.createdAt ?? new Date().toISOString(),
    ],
  );
}

describe("feedback cluster service (flywheel 02-P3)", () => {
  it("normalizes and hashes cluster queries deterministically", () => {
    expect(normalizeClusterQuery("kb_search: 设计  一个 游戏 ")).toBe("设计 一个 游戏");
    expect(hashClusterQuery("kb_search: Design A GAME")).toBe(hashClusterQuery("kb_search:  design   a game "));
    expect(hashClusterQuery("A")).not.toBe(hashClusterQuery("B"));
  });

  it("creates a fresh cluster key when no candidate exists", async () => {
    const fixture = await createTestDb();
    try {
      const key = await resolveFeedbackClusterKey(fixture.db, {
        projectId: "default_project",
        feedbackType: "miss",
        query: "kb_search: 全新问题甲",
      }, { embedder: embedderFor({}) });
      expect(key).toBe(`q::${hashClusterQuery("kb_search: 全新问题甲")}`);
    } finally {
      await fixture.cleanup();
    }
  }, 20000);

  it("merges similar queries into the same cluster and audits the merge", async () => {
    const fixture = await createTestDb();
    try {
      await insertEvent(fixture.db, {
        projectId: "default_project",
        feedbackType: "miss",
        query: "kb_search: 焰星 职业 元素 武器",
        clusterKey: "",
      });
      // 同义改写（向量相似 0.95）→ 归并到候选簇（按其 query 哈希）
      const vectors: Record<string, number[]> = {
        "kb_search: 焰星 职业 元素 武器": [1, 0],
        "kb_search: 焰星的职业和武器是什么": [0.95, 0.312],
      };
      const merged = await resolveFeedbackClusterKey(fixture.db, {
        projectId: "default_project",
        feedbackType: "miss",
        query: "kb_search: 焰星的职业和武器是什么",
      }, { embedder: embedderFor(vectors) });
      expect(merged).toBe(`q::${hashClusterQuery("kb_search: 焰星 职业 元素 武器")}`);

      const { rows } = await fixture.db.adapter.query(
        "SELECT category, message FROM diagnostic_logs WHERE category = 'feedback_cluster'",
      );
      expect(rows.length).toBe(1);
      expect(String(rows[0]!.message)).toContain("归并到簇");
      expect(String(rows[0]!.message)).toContain(String(FEEDBACK_CLUSTER_SIMILARITY_THRESHOLD));
    } finally {
      await fixture.cleanup();
    }
  }, 20000);

  it("reuses an existing cluster_key when the candidate already has one", async () => {
    const fixture = await createTestDb();
    try {
      await insertEvent(fixture.db, {
        projectId: "default_project",
        feedbackType: "bad_hit",
        query: "kb_search: 掉落 保底 概率",
        clusterKey: "q::abc12345",
      });
      const vectors: Record<string, number[]> = {
        "kb_search: 掉落 保底 概率": [1, 0],
        "kb_search: 抽卡保底规则": [0.99, 0.14],
      };
      const key = await resolveFeedbackClusterKey(fixture.db, {
        projectId: "default_project",
        feedbackType: "bad_hit",
        query: "kb_search: 抽卡保底规则",
      }, { embedder: embedderFor(vectors) });
      expect(key).toBe("q::abc12345");
    } finally {
      await fixture.cleanup();
    }
  }, 20000);

  it("keeps dissimilar queries in separate clusters", async () => {
    const fixture = await createTestDb();
    try {
      await insertEvent(fixture.db, {
        projectId: "default_project",
        feedbackType: "miss",
        query: "kb_search: 公会战奖励",
        clusterKey: "",
      });
      const vectors: Record<string, number[]> = {
        "kb_search: 公会战奖励": [1, 0],
        "kb_search: 体力恢复速度": [0.1, 0.99],
      };
      const key = await resolveFeedbackClusterKey(fixture.db, {
        projectId: "default_project",
        feedbackType: "miss",
        query: "kb_search: 体力恢复速度",
      }, { embedder: embedderFor(vectors) });
      expect(key).toBe(`q::${hashClusterQuery("kb_search: 体力恢复速度")}`);
    } finally {
      await fixture.cleanup();
    }
  }, 20000);

  it("falls back to exact normalized matching when the embedder is unavailable", async () => {
    const fixture = await createTestDb();
    try {
      await insertEvent(fixture.db, {
        projectId: "default_project",
        feedbackType: "miss",
        query: "kb_search: 旧查询",
        clusterKey: "",
      });
      const failing: { embed(): Promise<number[][]> } = {
        async embed() {
          throw new DenseModelUnavailableError(new Error("no model"));
        },
      };
      const key = await resolveFeedbackClusterKey(fixture.db, {
        projectId: "default_project",
        feedbackType: "miss",
        query: "kb_search: 旧查询",
      }, { embedder: failing as never });
      // 回退 = 归一化 query 精确键（旧行为）
      expect(key).toBe(`q::${normalizeClusterQuery("kb_search: 旧查询")}`);
    } finally {
      await fixture.cleanup();
    }
  }, 20000);

  it("caps candidate lookback at FEEDBACK_CLUSTER_MAX_CANDIDATES", () => {
    expect(FEEDBACK_CLUSTER_MAX_CANDIDATES).toBe(50);
  });
});
