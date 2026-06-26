import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadWikiSpecs } from "../src/server/services/kbBuilder/specs";
import { evaluateQualityGate } from "../src/server/services/kbBuilder/qualityGate";

describe("evaluateQualityGate", () => {
  it("lowers confidence when required wiki spec sections and facts are missing", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-quality-"));
    try {
      const specDir = join(dataDir, "processed", "wiki_specs");
      mkdirSync(join(dataDir, "wiki", "systems"), { recursive: true });
      mkdirSync(join(dataDir, "wiki", "_meta"), { recursive: true });
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, "manifest.json"), JSON.stringify({
        page_types: { system: { dir: "systems", template: "system_rule.md" } },
        entity_types: ["system", "table", "concept"],
        relation_types: ["configured_in", "references"]
      }));
      writeFileSync(join(specDir, "system_rule.md"), "## Overview\n## Data Dependencies\n| key | required |\n| --- | --- |\n| config_table | yes |");
      writeFileSync(join(dataDir, "wiki", "systems", "battle.md"), "---\ntype: system\ntitle: Battle\nsource: gamedocs/battle.md\n---\n\n## Overview\nOnly overview.");
      writeFileSync(join(dataDir, "wiki", "_meta", "battle.json"), JSON.stringify({
        title: "Battle",
        source: "gamedocs/battle.md",
        wiki_path: "wiki/systems/battle.md",
        facts: {},
        entities: [{ name: "Battle", type: "system" }],
        relationships: []
      }));

      const result = evaluateQualityGate({
        dataDir,
        specs: loadWikiSpecs(specDir),
        sourceLogicalPaths: new Set(["gamedocs/battle.md"]),
        profile: {
          minPackageScore: 0.75,
          rules: {
            wikiSpecCompleteness: { enabled: true, severity: "blocking", minScore: 0.75 },
            requiredFacts: { enabled: true, severity: "warning", minScore: 0.7 },
            frontmatterSource: { enabled: true, severity: "blocking" },
            graphIntegrity: { enabled: true, severity: "blocking", minScore: 0.7 },
            conceptOveruse: { enabled: true, severity: "warning", maxRatio: 0.35 }
          }
        }
      });

      expect(result.overallScore).toBeLessThan(0.75);
      expect(result.blockingCount).toBeGreaterThan(0);
      expect(result.warningCount).toBeGreaterThan(0);
      expect(result.findings.some((finding) => finding.ruleId === "wikiSpecCompleteness")).toBe(true);
      expect(result.findings.some((finding) => finding.ruleId === "requiredFacts")).toBe(true);
      expect(result.componentQuality["wiki/systems/battle.md"].factsScore).toBe(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("flags unconfirmed graph candidates and table relation candidates", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-quality-candidates-"));
    try {
      const specDir = join(dataDir, "processed", "wiki_specs");
      mkdirSync(join(dataDir, "wiki", "systems"), { recursive: true });
      mkdirSync(join(dataDir, "wiki", "_meta"), { recursive: true });
      mkdirSync(join(dataDir, "wiki", "_tables"), { recursive: true });
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, "manifest.json"), JSON.stringify({
        page_types: { system: { dir: "systems", template: "system_rule.md" } },
        entity_types: ["system", "table", "concept"],
        relation_types: ["configured_in", "references"]
      }));
      writeFileSync(join(specDir, "system_rule.md"), "## Overview\n");
      writeFileSync(join(dataDir, "wiki", "systems", "battle.md"), "---\ntype: system\ntitle: Battle\nsource: gamedocs/battle.md\n---\n\n## Overview\nBattle.");
      writeFileSync(join(dataDir, "wiki", "_meta", "battle.json"), JSON.stringify({
        title: "Battle",
        source: "gamedocs/battle.md",
        wiki_path: "wiki/systems/battle.md",
        facts: {},
        entities: [{ name: "Battle", type: "system" }],
        relationships: []
      }));
      writeFileSync(join(dataDir, "wiki", "graph.json"), JSON.stringify({
        nodes: [{ id: "Battle", label: "Battle", type: "system" }],
        edges: [
          { source: "Battle", target: "table:Skill", relation: "configured_in", edge_kind: "candidate", candidate_reason: "unknown target" }
        ]
      }));
      writeFileSync(join(dataDir, "wiki", "_tables", "table_relation_candidates.json"), JSON.stringify([
        { source: "Skill", target: "Buff", field: "BuffId", reason: "manual_confirmation_required" }
      ]));

      const result = evaluateQualityGate({
        dataDir,
        specs: loadWikiSpecs(specDir),
        sourceLogicalPaths: new Set(["gamedocs/battle.md"]),
        profile: {
          minPackageScore: 0.75,
          rules: {
            wikiSpecCompleteness: { enabled: true, severity: "blocking", minScore: 0.75 },
            requiredFacts: { enabled: true, severity: "warning", minScore: 0.7 },
            frontmatterSource: { enabled: true, severity: "blocking" },
            graphIntegrity: { enabled: true, severity: "blocking", minScore: 0.7 },
            candidateRelationships: { enabled: true, severity: "blocking" },
            tableRelationCandidates: { enabled: true, severity: "warning" },
            conceptOveruse: { enabled: true, severity: "warning", maxRatio: 0.35 }
          }
        }
      });

      expect(result.findings.some((finding) => finding.ruleId === "candidateRelationships")).toBe(true);
      expect(result.findings.some((finding) => finding.ruleId === "tableRelationCandidates")).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("accepts meta source without markdown frontmatter source", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-quality-meta-source-"));
    try {
      const specDir = join(dataDir, "processed", "wiki_specs");
      mkdirSync(join(dataDir, "wiki", "systems"), { recursive: true });
      mkdirSync(join(dataDir, "wiki", "_meta"), { recursive: true });
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, "manifest.json"), JSON.stringify({
        page_types: { system: { dir: "systems", template: "system_rule.md" } },
        entity_types: ["system"],
        relation_types: ["references"]
      }));
      writeFileSync(join(specDir, "system_rule.md"), "## Overview\n");
      writeFileSync(join(dataDir, "wiki", "systems", "battle.md"), "# Battle\n\n## Overview\nBattle.");
      writeFileSync(join(dataDir, "wiki", "_meta", "battle.json"), JSON.stringify({
        title: "Battle",
        source: "gamedocs/battle.md",
        wiki_path: "wiki/systems/battle.md",
        facts: {},
        entities: [{ name: "Battle", type: "system" }],
        relationships: []
      }));

      const result = evaluateQualityGate({
        dataDir,
        specs: loadWikiSpecs(specDir),
        sourceLogicalPaths: new Set(["gamedocs/battle.md"]),
        profile: {
          minPackageScore: 0.75,
          rules: {
            wikiSpecCompleteness: { enabled: true, severity: "warning", minScore: 0.75 },
            requiredFacts: { enabled: true, severity: "warning", minScore: 0.7 },
            frontmatterSource: { enabled: true, severity: "blocking" },
            graphIntegrity: { enabled: false }
          }
        }
      });

      expect(result.findings.some((finding) => finding.ruleId === "frontmatterSource")).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("accepts converted parsed documents as source traces for gamedocs inputs", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-quality-parsed-source-"));
    try {
      const specDir = join(dataDir, "processed", "wiki_specs");
      mkdirSync(join(dataDir, "wiki", "systems"), { recursive: true });
      mkdirSync(join(dataDir, "wiki", "_meta"), { recursive: true });
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, "manifest.json"), JSON.stringify({
        page_types: { system: { dir: "systems", template: "system_rule.md" } },
        entity_types: ["system"],
        relation_types: ["references"]
      }));
      writeFileSync(join(specDir, "system_rule.md"), "## Overview\n");
      writeFileSync(join(dataDir, "wiki", "systems", "pvp.md"), "# PVP\n\n## Overview\nPVP.");
      writeFileSync(join(dataDir, "wiki", "_meta", "pvp.json"), JSON.stringify({
        title: "PVP",
        source: "processed/parsed/pvp活动模板.md",
        wiki_path: "wiki/systems/pvp.md",
        facts: {},
        entities: [{ name: "PVP", type: "system" }],
        relationships: []
      }));

      const result = evaluateQualityGate({
        dataDir,
        specs: loadWikiSpecs(specDir),
        sourceLogicalPaths: new Set(["gamedocs/pvp活动模板.docx"]),
        profile: {
          minPackageScore: 0.75,
          rules: {
            wikiSpecCompleteness: { enabled: true, severity: "warning", minScore: 0.75 },
            requiredFacts: { enabled: true, severity: "warning", minScore: 0.7 },
            frontmatterSource: { enabled: true, severity: "blocking" },
            graphIntegrity: { enabled: false }
          }
        }
      });

      expect(result.findings.some((finding) => finding.ruleId === "frontmatterSource")).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does not apply wiki spec or source checks to generated table registry pages", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-quality-table-page-"));
    try {
      const specDir = join(dataDir, "processed", "wiki_specs");
      mkdirSync(join(dataDir, "wiki", "tables"), { recursive: true });
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, "manifest.json"), JSON.stringify({
        page_types: { table: { dir: "tables", template: "table_schema.md" } },
        entity_types: ["table"],
        relation_types: ["references"]
      }));
      writeFileSync(join(specDir, "table_schema.md"), "## 概览\n## 表用途\n| key | required |\n| --- | --- |\n| table_name | yes |\n| primary_key | yes |");
      writeFileSync(join(dataDir, "wiki", "tables", "Combat.md"), [
        "---",
        "type: table",
        "title: Combat",
        "table_schema: wiki/_tables/schemas.json",
        "---",
        "",
        "# Combat",
        "",
        "| table | fields | rows |",
        "| --- | --- | --- |",
        "| Combat/Skill | Id, Name | 1 |"
      ].join("\n"));

      const result = evaluateQualityGate({
        dataDir,
        specs: loadWikiSpecs(specDir),
        sourceLogicalPaths: new Set(),
        profile: {
          minPackageScore: 0.75,
          rules: {
            wikiSpecCompleteness: { enabled: true, severity: "blocking", minScore: 0.75 },
            requiredFacts: { enabled: true, severity: "warning", minScore: 0.7 },
            frontmatterSource: { enabled: true, severity: "blocking" },
            graphIntegrity: { enabled: false }
          }
        }
      });

      expect(result.findings.some((finding) => finding.ruleId === "wikiSpecCompleteness")).toBe(false);
      expect(result.findings.some((finding) => finding.ruleId === "requiredFacts")).toBe(false);
      expect(result.findings.some((finding) => finding.ruleId === "frontmatterSource")).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("skips dismissed rules for matching wiki component refs", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-quality-dismissed-"));
    try {
      const specDir = join(dataDir, "processed", "wiki_specs");
      mkdirSync(join(dataDir, "wiki", "systems"), { recursive: true });
      mkdirSync(join(dataDir, "wiki", "_meta"), { recursive: true });
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, "manifest.json"), JSON.stringify({
        page_types: { system: { dir: "systems", template: "system_rule.md" } },
        entity_types: ["system"],
        relation_types: ["references"]
      }));
      writeFileSync(join(specDir, "system_rule.md"), "## Overview\n## Data Dependencies\n| key | required |\n| --- | --- |\n| config_table | yes |");
      writeFileSync(join(dataDir, "wiki", "systems", "battle.md"), "---\ntype: system\ntitle: Battle\nsource: gamedocs/battle.md\n---\n\n## Overview\nOnly overview.");
      writeFileSync(join(dataDir, "wiki", "_meta", "battle.json"), JSON.stringify({
        title: "Battle",
        source: "gamedocs/battle.md",
        wiki_path: "wiki/systems/battle.md",
        facts: {},
        entities: [{ name: "Battle", type: "system" }],
        relationships: []
      }));

      const result = evaluateQualityGate({
        dataDir,
        specs: loadWikiSpecs(specDir),
        sourceLogicalPaths: new Set(["gamedocs/battle.md"]),
        profile: {
          minPackageScore: 0.75,
          rules: {
            wikiSpecCompleteness: { enabled: true, severity: "blocking", minScore: 0.75 },
            requiredFacts: { enabled: true, severity: "warning", minScore: 0.7 },
            frontmatterSource: { enabled: true, severity: "blocking" },
            graphIntegrity: { enabled: false }
          }
        },
        ruleDismissals: [
          { ruleId: "wikiSpecCompleteness", componentRef: "wiki/systems/battle.md" },
          { ruleId: "requiredFacts", componentRef: "wiki/systems/battle.md" }
        ]
      });

      expect(result.findings.some((finding) => finding.ruleId === "wikiSpecCompleteness")).toBe(false);
      expect(result.findings.some((finding) => finding.ruleId === "requiredFacts")).toBe(false);
      expect(result.dismissedRules).toEqual([
        { ruleId: "wikiSpecCompleteness", componentRef: "wiki/systems/battle.md" },
        { ruleId: "requiredFacts", componentRef: "wiki/systems/battle.md" }
      ]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
