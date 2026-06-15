import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import xlsx from "xlsx";
import { runTableStage } from "../src/server/services/kbBuilder/tableStage";
import { runGraphStage } from "../src/server/services/kbBuilder/graphStage";
import { runVizStage } from "../src/server/services/kbBuilder/vizStage";

describe("native table and graph stages", () => {
  it("emits table registries, deterministic table-field graph, index, and graph html", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-table-graph-"));
    try {
      mkdirSync(join(dataDir, "gamedata", "Combat"), { recursive: true });
      mkdirSync(join(dataDir, "wiki", "_meta"), { recursive: true });
      mkdirSync(join(dataDir, "wiki", "systems"), { recursive: true });
      const workbook = xlsx.utils.book_new();
      const sheet = xlsx.utils.json_to_sheet([{ Id: 1, Name: "Slash", BuffId: 10 }]);
      xlsx.utils.book_append_sheet(workbook, sheet, "Skill");
      xlsx.writeFile(workbook, join(dataDir, "gamedata", "Combat", "Skill.xlsx"));

      writeFileSync(join(dataDir, "wiki", "systems", "battle.md"), "# Battle System\n");
      writeFileSync(join(dataDir, "wiki", "_meta", "battle.json"), JSON.stringify({
        title: "Battle System",
        source: "gamedocs/battle.md",
        wiki_path: "wiki/systems/battle.md",
        entities: [{ name: "Battle System", type: "system" }, { name: "Skill", type: "table" }],
        relationships: [{ source: "Battle System", relation: "configured_in", target: "Skill" }]
      }));

      await runTableStage({ dataDir, force: false });
      await runGraphStage({ dataDir });
      await runVizStage({ dataDir });

      expect(existsSync(join(dataDir, "wiki", "_tables", "schemas.json"))).toBe(true);
      expect(existsSync(join(dataDir, "table_schemas", "Combat__Skill.json"))).toBe(true);
      const schema = JSON.parse(readFileSync(join(dataDir, "table_schemas", "Combat__Skill.json"), "utf8"));
      expect(schema.fields).toEqual(["Id", "Name", "BuffId"]);

      const graph = JSON.parse(readFileSync(join(dataDir, "wiki", "graph.json"), "utf8"));
      expect(graph.nodes.some((node: any) => node.id === "table:Combat/Skill")).toBe(true);
      expect(graph.nodes.some((node: any) => node.id === "field:Combat/Skill.BuffId")).toBe(true);
      expect(graph.edges.some((edge: any) => edge.relation === "has_field")).toBe(true);
      expect(graph.edges.some((edge: any) => edge.source === "Battle System" && edge.relation === "configured_in" && edge.target === "Skill")).toBe(true);
      expect(readFileSync(join(dataDir, "wiki", "index.md"), "utf8")).toContain("Battle System");
      expect(readFileSync(join(dataDir, "wiki", "graph.html"), "utf8")).toContain("Knowledge Graph");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
