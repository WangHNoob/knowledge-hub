import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildKnowledgeLintReport } from "../src/server/services/okf/lintService";
import type { ReleaseAuditSummary } from "../src/server/services/releaseAudit";
import type { ConformanceReport } from "../src/server/services/okf/types";

describe("Knowledge Lint", () => {
  it("unifies OKF, graph, trust, table dependency, and MCP feedback issues", () => {
    const dir = mkdtempSync(join(tmpdir(), "kh-lint-"));
    try {
      mkdirSync(join(dir, "graph"), { recursive: true });
      mkdirSync(join(dir, "tables"), { recursive: true });
      mkdirSync(join(dir, "search"), { recursive: true });
      writeFileSync(join(dir, "graph", "graph.json"), JSON.stringify({
        nodes: [{ id: "page:one", label: "One" }],
        edges: [{ source: "page:one", target: "table:Missing/Table", relation: "configured_in" }],
      }), "utf8");
      writeFileSync(join(dir, "tables", "schemas.json"), JSON.stringify({ tables: [] }), "utf8");
      writeFileSync(join(dir, "search", "index.json"), JSON.stringify({
        okfAssetType: "search_index",
        version: "v1",
        generatedAt: "2026-06-26T00:00:00.000Z",
        pages: [{
          componentId: "cmp_one",
          title: "One",
          artifactId: "wiki/systems/one.md",
          okfPath: "/systems/one.md",
          kind: "wiki_page",
          type: "system_rule",
          trust: null,
          fields: {
            title: "One",
            path: "/systems/one.md",
            type: "system_rule",
            headings: ["Data Dependencies"],
            body: "body",
            dataDependencies: "未解析：Missing/Table",
            tables: [],
            citations: [],
          },
          terms: {},
        }],
      }), "utf8");

      const report = buildKnowledgeLintReport({
        releaseId: "rel_lint",
        generatedAt: "2026-06-26T00:00:00.000Z",
        bundleDir: dir,
        conformance: conformanceFixture(),
        audit: auditFixture(),
      });

      expect(report.summary.blocking).toBeGreaterThan(0);
      expect(report.domains.links.total).toBe(1);
      expect(report.domains.evidence.total).toBeGreaterThan(0);
      expect(report.domains.graph.total).toBeGreaterThan(0);
      expect(report.domains.trust.total).toBeGreaterThan(0);
      expect(report.domains.table_dependencies.total).toBeGreaterThan(0);
      expect(report.domains.mcp_feedback.total).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function conformanceFixture(): ConformanceReport {
  return {
    okfVersion: "0.1",
    exporterVersion: 1,
    scannedAt: "2026-06-26T00:00:00.000Z",
    conceptCount: 1,
    referenceCount: 0,
    issues: [{
      okfPath: "/systems/one.md",
      issueType: "broken_link",
      layer: "kh_publish_quality",
      blocking: false,
      message: "link target not found: /missing.md",
    }],
    summary: { blocking: 0, warning: 1, info: 0 },
    linkSummary: { resolved: 0, ambiguous: 0, unresolved: 1 },
    citationSummary: { required: 1, present: 0 },
  };
}

function auditFixture(): ReleaseAuditSummary {
  return {
    version: 1,
    generatedAt: "2026-06-26T00:00:00.000Z",
    release: {
      releaseId: "rel_lint",
      version: "2026.06.26.001",
      publishedAt: "2026-06-26T00:00:00.000Z",
      publishedBy: "admin",
    },
    sources: {
      sourceVersionIds: ["srcv_lint"],
      packageCount: 1,
      componentCount: 1,
      packages: [{ packageId: "pkg_lint", name: "Lint", status: "published", sourceVersionIds: ["srcv_lint"] }],
    },
    build: {
      runCount: 1,
      completed: 1,
      failed: 0,
      running: 0,
      cachedStages: 0,
      runs: [],
    },
    assets: { byGroup: { wiki: 1 }, byKind: { wiki_page: 1 } },
    evidence: {
      requiredComponents: 1,
      coveredComponents: 0,
      missingComponents: 1,
      evidenceRecords: 0,
      coverageRate: 0,
    },
    trust: {
      averageScore: 0.42,
      minScore: 0.42,
      statusCounts: { blocked: 1 },
      lowTrustComponents: [{
        componentId: "cmp_one",
        title: "One",
        artifactId: "wiki/systems/one.md",
        kind: "wiki_page",
        score: 0.42,
        status: "blocked",
        reasons: ["缺少证据"],
      }],
    },
    review: {
      open: 0,
      blocking: 0,
      warning: 0,
      info: 0,
      resolvedSincePreviousRelease: 0,
      topOpenTasks: [],
    },
    agentFeedback: {
      windowStart: null,
      windowEnd: "2026-06-26T00:00:00.000Z",
      mcpCalls: 3,
      mcpMisses: 3,
      mcpErrors: 0,
      feedbackEvents: 1,
      feedbackByType: { repeated_query: 1 },
      topQueries: [{ query: "kb_search:missing", count: 3 }],
    },
    qualityGate: {},
    legislationProfileHash: "hash",
  };
}
