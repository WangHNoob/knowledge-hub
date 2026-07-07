import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { createLintAutoRemediationService } from "../src/server/services/lintAutoRemediation";
import { createTableAliasService } from "../src/server/services/tableAliasService";
import type { FlywheelService } from "../src/server/services/flywheelService";
import type { LlmClient } from "../src/server/services/kbBuilder/llmClient";
import type { PipelineModelConfig } from "../src/server/services/kbBuilder/modelConfig";
import { createTestDb } from "./helpers/testDb";

const RELEASE_ID = "rel_alias_test";

/** 写一份含「表依赖未解析」+「图谱 configured_in 悬空边」的发布快照到临时 dataDir。 */
function seedReleaseBundle(dataDir: string): void {
  const base = join(dataDir, "releases", RELEASE_ID);
  mkdirSync(join(base, "search"), { recursive: true });
  mkdirSync(join(base, "tables"), { recursive: true });

  const report = {
    version: 1,
    generatedAt: "2026-07-07T00:00:00.000Z",
    releaseId: RELEASE_ID,
    summary: { score: 0.7, blocking: 0, warning: 2, info: 0 },
    domains: {
      links: { blocking: 0, warning: 0, info: 0, total: 0 },
      evidence: { blocking: 0, warning: 0, info: 0, total: 0 },
      graph: { blocking: 0, warning: 1, info: 0, total: 1 },
      trust: { blocking: 0, warning: 0, info: 0, total: 0 },
      table_dependencies: { blocking: 0, warning: 1, info: 0, total: 1 },
      mcp_feedback: { blocking: 0, warning: 0, info: 0, total: 0 },
    },
    governance: { source: "rule_fallback", analyzed: 2, autoEligible: 0, manualReview: 0, rebuild: 1, monitor: 0, warnings: [] },
    issues: [
      {
        id: "table_dep_unresolved_cmp_baixing",
        domain: "table_dependencies",
        severity: "warning",
        title: "Data Dependencies 未解析到结构化表",
        message: "白星 写了 Data Dependencies，但没有解析到 canonical table。",
        componentId: "cmp_baixing",
        okfPath: "wiki/concepts/baixing.md",
        suggestedAction: "补 alias 后重新发布。",
      },
      {
        id: "graph_dangling_edge_3",
        domain: "graph",
        severity: "warning",
        title: "知识图谱存在悬空边",
        message: "白星 -> 战斗配置 (configured_in) 无法完整解析到节点或表 schema。",
        suggestedAction: "补齐对应资产。",
      },
    ],
  };
  writeFileSync(join(base, "knowledge_lint.json"), JSON.stringify(report));
  writeFileSync(
    join(base, "search", "index.json"),
    JSON.stringify({ pages: [{ componentId: "cmp_baixing", title: "白星", okfPath: "wiki/concepts/baixing.md", fields: { dataDependencies: "技能表", tables: [] } }] }),
  );
  writeFileSync(
    join(base, "tables", "schemas.json"),
    JSON.stringify({ tables: [{ schema: { table_name: "Combat/Skill" } }, { schema: { table_name: "Combat/Battle" } }] }),
  );
}

function fixedClient(text: string): LlmClient {
  return {
    provider: "openai-compatible",
    model: "test-model",
    complete: async () => ({ text }),
    ping: async () => {},
  };
}

const LLM_CONFIG: PipelineModelConfig = { provider: "openai-compatible", baseUrl: "http://x", model: "test", apiKey: "k" };

function makeFlywheelStub(calls: Array<{ mode?: string }>): Pick<FlywheelService, "sync"> {
  return {
    sync: async (input) => {
      calls.push({ mode: input.mode });
      return { syncId: "sync_alias_1", status: "started" } as unknown as Awaited<ReturnType<FlywheelService["sync"]>>;
    },
  };
}

describe("lint alias auto-remediation", () => {
  it("maps unresolved table terms to canonical names, writes aliases, and triggers a full rebuild", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-lint-alias-"));
    const { db, cleanup } = await createTestDb();
    try {
      seedReleaseBundle(dataDir);
      const tableAliases = createTableAliasService(db);
      const syncCalls: Array<{ mode?: string }> = [];
      const service = createLintAutoRemediationService({
        db,
        tableAliases,
        flywheel: makeFlywheelStub(syncCalls),
        dataDir,
        resolveModelConfig: async () => LLM_CONFIG,
        llmClientFactory: () => fixedClient(JSON.stringify({
          mappings: [
            { term: "技能表", canonical: "Combat/Skill", confidence: 0.95 },
            { term: "战斗配置", canonical: "Combat/Battle", confidence: 0.93 },
          ],
        })),
      });

      const result = await service.remediate({ projectId: "default_project", releaseId: RELEASE_ID });

      expect(result.status).toBe("applied");
      expect(result.appliedAliases.map((a) => a.canonical).sort()).toEqual(["Combat/Battle", "Combat/Skill"]);
      // 别名持久化到翻译表。
      const entries = await tableAliases.list();
      const skill = entries.find((e) => e.canonical === "Combat/Skill");
      const battle = entries.find((e) => e.canonical === "Combat/Battle");
      expect(skill?.aliases).toContain("技能表");
      expect(battle?.aliases).toContain("战斗配置");
      // 触发一次全量重建（源没变，必须 full 才能重套别名）。
      expect(syncCalls).toEqual([{ mode: "full" }]);
      // 记录审计事件。
      const { rows } = await db.adapter.query(
        "SELECT payload_json FROM knowledge_events WHERE event_type = 'knowledge_lint.alias_remediated'",
      );
      expect(rows).toHaveLength(1);

      // 幂等：别名已存在 → 不再重复触发重建。
      const again = await service.remediate({ projectId: "default_project", releaseId: RELEASE_ID });
      expect(again.status).toBe("no_action");
      expect(syncCalls).toHaveLength(1);
    } finally {
      await cleanup();
    }
  }, 20000);

  it("refuses canonical names that are not real tables and escalates instead of rebuilding", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-lint-alias-bad-"));
    const { db, cleanup } = await createTestDb();
    try {
      seedReleaseBundle(dataDir);
      const syncCalls: Array<{ mode?: string }> = [];
      const service = createLintAutoRemediationService({
        db,
        tableAliases: createTableAliasService(db),
        flywheel: makeFlywheelStub(syncCalls),
        dataDir,
        resolveModelConfig: async () => LLM_CONFIG,
        // LLM 幻觉出一个不存在的表名 → 必须被拒绝。
        llmClientFactory: () => fixedClient(JSON.stringify({
          mappings: [{ term: "技能表", canonical: "Nonexistent/Table", confidence: 0.99 }],
        })),
      });

      const result = await service.remediate({ projectId: "default_project", releaseId: RELEASE_ID });
      expect(result.status).toBe("no_action");
      expect(result.appliedAliases).toHaveLength(0);
      expect(syncCalls).toHaveLength(0);
    } finally {
      await cleanup();
    }
  }, 20000);

  it("skips when no LLM model is configured", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-lint-alias-nollm-"));
    const { db, cleanup } = await createTestDb();
    try {
      seedReleaseBundle(dataDir);
      const syncCalls: Array<{ mode?: string }> = [];
      const service = createLintAutoRemediationService({
        db,
        tableAliases: createTableAliasService(db),
        flywheel: makeFlywheelStub(syncCalls),
        dataDir,
        resolveModelConfig: async () => ({ provider: "deterministic", model: "deterministic" }),
      });

      const result = await service.remediate({ projectId: "default_project", releaseId: RELEASE_ID });
      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("no_llm_model");
      expect(syncCalls).toHaveLength(0);
    } finally {
      await cleanup();
    }
  }, 20000);
});
