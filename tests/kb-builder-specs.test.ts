import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWikiSpecs } from "../src/server/services/kbBuilder/specs";

describe("loadWikiSpecs", () => {
  it("loads manifest page types plus required sections and facts", () => {
    const root = mkdtempSync(join(tmpdir(), "kh-kb-specs-"));
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, "manifest.json"),
        JSON.stringify({
          page_types: {
            system: { dir: "systems", template: "system_rule.md" },
          },
          entity_types: ["system", "table", "concept"],
          relation_types: ["depends_on", "configured_in", "references"],
        }),
      );
      writeFileSync(
        join(root, "system_rule.md"),
        [
          "# System Rule",
          "## Overview",
          "## Core Rules",
          "## Data Dependencies",
          "| key | default | required |",
          "| --- | --- | --- |",
          "| unlock_condition | no | yes |",
          "| config_table | no | yes |",
          "| debug_flag | yes | no |",
        ].join("\n"),
      );

      const specs = loadWikiSpecs(root);
      expect(specs.manifest.pageTypes.system.dir).toBe("systems");
      expect(specs.specs.system.requiredSections).toEqual([
        "Overview",
        "Core Rules",
        "Data Dependencies",
      ]);
      expect(specs.specs.system.requiredFacts).toEqual(["unlock_condition", "config_table"]);
      expect(specs.entityTypes).toEqual(new Set(["system", "table", "concept"]));
      expect(specs.relationTypes).toEqual(new Set(["depends_on", "configured_in", "references"]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
