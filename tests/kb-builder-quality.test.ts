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
});
