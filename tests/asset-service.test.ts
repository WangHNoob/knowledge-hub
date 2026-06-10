import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/server/db";
import { createKnowledgeService } from "../src/server/services/knowledgeService";
import type { DatabaseHandle } from "../src/server/types";

describe("knowledge asset service", () => {
  let dir: string;
  let db: DatabaseHandle | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "knowledge-hub-"));
    db = null;
  });

  afterEach(() => {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("summarizes packages, components, review tasks, releases and agent events", () => {
    db = createDatabase({ dataDir: dir, seed: true });
    const service = createKnowledgeService(db);

    const summary = service.getDashboardSummary();

    expect(summary.sources.total).toBe(3);
    expect(summary.packages.total).toBe(2);
    expect(summary.components.byGroup.wiki).toBe(4);
    expect(summary.components.byGroup.index).toBe(2);
    expect(summary.components.byGroup.graph).toBe(1);
    expect(summary.components.byGroup.table).toBe(2);
    expect(summary.review.blocking).toBe(2);
    expect(summary.release.current?.version).toBe("2026.06.10.001");
    expect(summary.agent.recentQueries).toBe(5);
    expect(summary.agent.misses).toBe(1);
  });

  it("groups asset components under a package without hiding trace identifiers", () => {
    db = createDatabase({ dataDir: dir, seed: true });
    const service = createKnowledgeService(db);

    const detail = service.getPackageDetail("pkg_legacy_core");

    expect(detail.package.name).toBe("核心玩法旧知识库导入");
    expect(detail.components.map((component) => component.group)).toContain("wiki");
    expect(detail.components.map((component) => component.group)).toContain("index");
    expect(detail.components[0]).toMatchObject({
      componentId: expect.stringMatching(/^cmp_/),
      artifactId: expect.stringMatching(/^art_/),
      sourceRefs: expect.any(Array),
      quality: expect.any(Object)
    });
  });

  it("turns quality findings into review tasks people can act on", () => {
    db = createDatabase({ dataDir: dir, seed: true });
    const service = createKnowledgeService(db);

    const blockingTasks = service.listReviewTasks({ severity: "blocking" });

    expect(blockingTasks).toHaveLength(2);
    expect(blockingTasks[0]).toMatchObject({
      severity: "blocking",
      suggestedAction: expect.stringContaining("补充")
    });
  });

  it("summarizes evidence coverage for package components", () => {
    db = createDatabase({ dataDir: dir, seed: true });
    const service = createKnowledgeService(db);

    const detail = service.getPackageDetail("pkg_legacy_core");
    const coverage = service.getEvidenceCoverage({ packageId: "pkg_legacy_core" });

    expect(detail.evidenceRecords).toHaveLength(4);
    expect(coverage).toMatchObject({
      totalComponents: 6,
      coveredComponents: 3,
      evidenceRecords: 4,
      missingComponents: 3
    });
    expect(coverage.coverageRate).toBeCloseTo(0.5);
  });
});
