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
          "",
          "| setting | required |",
          "| --- | --- |",
          "| unrelated_toggle | yes |",
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

  it("loads legacy wiki specs without template fields", () => {
    const root = mkdtempSync(join(tmpdir(), "kh-kb-specs-"));
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, "manifest.json"),
        JSON.stringify({
          page_types: {
            system_rule: {
              dir: "systems",
              description: "System rules",
              default_entity_type: "system",
            },
          },
          entity_types: ["system", "table", "concept"],
          relation_types: ["depends_on", "configured_in", "references"],
        }),
      );
      writeFileSync(
        join(root, "system_rule.md"),
        [
          "# System Rule",
          "## 章节结构",
          "- `## Overview`",
          "- `## Core Rules`",
          "- `## Data Dependencies`",
          "## facts 必填 key",
          "| key | 含义 | 示例值 |",
          "| --- | --- | --- |",
          "| `unlock_condition` | unlock condition | player_level >= 10 |",
          "| `config_table` | config table | system_config |",
          "| `max_level` / `max_count` | cap value | 99 |",
          "## 示例",
          "| key | required |",
          "| --- | --- |",
          "| unrelated_example | yes |",
        ].join("\n"),
      );

      const specs = loadWikiSpecs(root);
      expect(specs.manifest.pageTypes.system_rule).toEqual({
        dir: "systems",
        template: "system_rule.md",
      });
      expect(specs.specs.system_rule.requiredSections).toEqual([
        "Overview",
        "Core Rules",
        "Data Dependencies",
      ]);
      expect(specs.specs.system_rule.requiredFacts).toEqual([
        "unlock_condition",
        "config_table",
        "max_level",
        "max_count",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
