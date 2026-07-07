import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import xlsx from "xlsx";

import { createKnowledgeService } from "../src/server/services/knowledgeService";
import { createSourceBundleService } from "../src/server/services/sourceBundleService";
import { createKbBuilderPipelineService } from "../src/server/services/kbBuilderService";
import { createTestDb } from "./helpers/testDb";

function seedSource(sourceRoot: string): void {
  mkdirSync(join(sourceRoot, "gamedocs"), { recursive: true });
  mkdirSync(join(sourceRoot, "gamedata", "Combat"), { recursive: true });
  writeFileSync(join(sourceRoot, "gamedocs", "battle.md"), [
    "---",
    "type: system",
    "title: Battle System",
    "source: gamedocs/battle.md",
    "facts:",
    "  config_table: Skill",
    "entities:",
    "  - name: Battle System",
    "    type: system",
    "  - name: Skill",
    "    type: table",
    "relationships:",
    "  - source: Battle System",
    "    relation: configured_in",
    "    target: Skill",
    "---",
    "## Overview",
    "Battle rules.",
    "## Data Dependencies",
    "Uses Skill.",
  ].join("\n"));
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet([{ Id: 1, Name: "Slash" }]), "Skill");
  xlsx.writeFile(workbook, join(sourceRoot, "gamedata", "Combat", "Skill.xlsx"));
}

describe("graph stage-scoped rebuild", () => {
  it("rebuilds only the graph component, leaves other components untouched, keeps the package complete", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-graph-rebuild-data-"));
    const sourceRoot = mkdtempSync(join(tmpdir(), "kh-graph-rebuild-src-"));
    const { db, cleanup } = await createTestDb();
    try {
      seedSource(sourceRoot);
      const sourceService = createSourceBundleService(db, dataDir);
      const imported = await sourceService.importDirectoryAsVersion({
        rootPath: sourceRoot,
        bundleId: "default",
        createdBy: "admin",
        note: "graph rebuild fixture",
      });

      const builder = createKbBuilderPipelineService(db, dataDir);
      const knowledge = createKnowledgeService(db);

      // 1) 全量构建出完整包（含 wiki 页 + 图谱等组件）。
      const full = await builder.build({
        bundleId: "default",
        versionId: imported.version.versionId,
        requestedBy: "admin",
        stages: ["convert", "extract", "tables", "graph", "viz"],
        model: "deterministic",
        force: false,
        only: null,
        qualityProfileId: "default",
      });
      const packageId = full.package.packageId;
      const before = await knowledge.getPackageDetail(packageId);
      const beforeKinds = before.components.map((c) => c.kind).sort();
      expect(beforeKinds).toContain("graph_snapshot");
      expect(beforeKinds).toContain("wiki_page");

      const wikiBefore = before.components.find((c) => c.kind === "wiki_page")!;
      const graphBefore = before.components.find((c) => c.kind === "graph_snapshot")!;

      // 2) 图谱阶段级重建：全量跑流水线，但只把 graph 阶段组件合并回同一个包。
      const graphRun = await builder.build({
        bundleId: "default",
        versionId: imported.version.versionId,
        requestedBy: "admin",
        stages: ["convert", "extract", "tables", "graph", "viz"],
        model: "deterministic",
        force: false,
        only: null,
        qualityProfileId: "default",
        mergeIntoPackageId: packageId,
        scopedStage: "graph",
      });

      // 合并回同一个包，而不是新建包。
      expect(graphRun.package.packageId).toBe(packageId);

      const after = await knowledge.getPackageDetail(packageId);
      // 组件集合不变（没有丢失未受影响的组件，包仍然完整）。
      expect(after.components.map((c) => c.kind).sort()).toEqual(beforeKinds);
      expect(after.components.length).toBe(before.components.length);

      const graphAfter = after.components.find((c) => c.componentId === graphBefore.componentId)!;
      const wikiAfter = after.components.find((c) => c.componentId === wikiBefore.componentId)!;

      // 图谱组件被本次运行重建（打上 lastScopedRebuild = 新 run）。
      const graphRebuild = (graphAfter.quality as Record<string, { runId?: string }>).lastScopedRebuild;
      expect(graphRebuild?.runId).toBe(graphRun.run.runId);

      // wiki 页组件未被本次运行触碰（没有新 run 的 lastScopedRebuild 标记）。
      const wikiRebuild = (wikiAfter.quality as Record<string, { runId?: string }>).lastScopedRebuild;
      expect(wikiRebuild?.runId).not.toBe(graphRun.run.runId);
    } finally {
      await cleanup();
    }
  }, 30000);
});
