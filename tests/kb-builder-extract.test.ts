import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runExtractStage } from "../src/server/services/kbBuilder/extractStage";
import { loadWikiSpecs } from "../src/server/services/kbBuilder/specs";

describe("runExtractStage", () => {
  it("generates wiki page and meta from structured parsed markdown", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-extract-"));
    const specDir = join(dataDir, "processed", "wiki_specs");
    try {
      mkdirSync(join(dataDir, "processed", "parsed"), { recursive: true });
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, "manifest.json"), JSON.stringify({
        page_types: { system: { dir: "systems", template: "system_rule.md" } },
        entity_types: ["system", "table", "concept"],
        relation_types: ["configured_in", "references"]
      }));
      writeFileSync(join(specDir, "system_rule.md"), "## Overview\n## Data Dependencies\n| key | required |\n| --- | --- |\n| config_table | yes |");
      writeFileSync(join(dataDir, "processed", "parsed", "battle.md"), [
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
        "Uses Skill."
      ].join("\n"));

      const specs = loadWikiSpecs(specDir);
      const result = await runExtractStage({ dataDir, specs, model: "deterministic", force: false, only: null });

      expect(result.outputPaths.sort()).toEqual(["wiki/_meta/battle.json", "wiki/systems/battle.md"]);
      expect(existsSync(join(dataDir, "wiki", "systems", "battle.md"))).toBe(true);
      const meta = JSON.parse(readFileSync(join(dataDir, "wiki", "_meta", "battle.json"), "utf8"));
      expect(meta.title).toBe("Battle System");
      expect(meta.relationships[0].relation).toBe("configured_in");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
