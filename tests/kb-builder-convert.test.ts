import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runConvertStage } from "../src/server/services/kbBuilder/convertStage";

describe("runConvertStage", () => {
  it("converts markdown and text design docs into processed parsed markdown", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-convert-"));
    try {
      mkdirSync(join(dataDir, "gamedocs", "systems"), { recursive: true });
      writeFileSync(join(dataDir, "gamedocs", "systems", "battle.md"), "# Battle\n\nsource body");
      writeFileSync(join(dataDir, "gamedocs", "economy.txt"), "Economy text");

      const result = await runConvertStage({ dataDir, force: false, only: null });

      expect(result.stage).toBe("convert");
      expect(result.outputPaths).toEqual([
        "processed/parsed/economy.md",
        "processed/parsed/systems/battle.md"
      ]);
      expect(readFileSync(join(dataDir, "processed", "parsed", "systems", "battle.md"), "utf8")).toBe("# Battle\n\nsource body");
      expect(readFileSync(join(dataDir, "processed", "parsed", "economy.md"), "utf8")).toBe("Economy text");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
