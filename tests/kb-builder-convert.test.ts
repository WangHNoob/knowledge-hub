import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import xlsx from "xlsx";
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

  it("returns a warning without outputs when gamedocs is missing", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-convert-"));
    try {
      const result = await runConvertStage({ dataDir, force: false, only: null });

      expect(result.stage).toBe("convert");
      expect(result.status).toBe("skipped");
      expect(result.outputPaths).toEqual([]);
      expect(result.warnings.some((warning) => warning.includes("gamedocs"))).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("normalizes only filters from source-root, docs-root, and suffix paths", async () => {
    const onlyValues = ["systems/battle.md", "gamedocs/systems/battle.md", "battle.md"];

    for (const only of onlyValues) {
      const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-convert-"));
      try {
        mkdirSync(join(dataDir, "gamedocs", "systems"), { recursive: true });
        writeFileSync(join(dataDir, "gamedocs", "systems", "battle.md"), "# Battle\n");
        writeFileSync(join(dataDir, "gamedocs", "economy.txt"), "Economy text");

        const result = await runConvertStage({ dataDir, force: false, only });

        expect(result.outputPaths).toEqual(["processed/parsed/systems/battle.md"]);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    }
  });

  it("converts xlsx sheets into markdown tables", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-convert-"));
    try {
      mkdirSync(join(dataDir, "gamedocs"), { recursive: true });
      const workbook = xlsx.utils.book_new();
      const sheet = xlsx.utils.aoa_to_sheet([
        ["Id", "Name"],
        [1, "Slash"]
      ]);
      xlsx.utils.book_append_sheet(workbook, sheet, "Skill");
      xlsx.writeFile(workbook, join(dataDir, "gamedocs", "skills.xlsx"));

      const result = await runConvertStage({ dataDir, force: false, only: null });
      const markdown = readFileSync(join(dataDir, "processed", "parsed", "skills.md"), "utf8");

      expect(result.outputPaths).toEqual(["processed/parsed/skills.md"]);
      expect(markdown).toContain("## Sheet: Skill");
      expect(markdown).toContain("| Id | Name |");
      expect(markdown).toContain("| 1 | Slash |");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("skips dot directories, cache directories, and temporary files", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-convert-"));
    try {
      mkdirSync(join(dataDir, "gamedocs", ".hidden"), { recursive: true });
      mkdirSync(join(dataDir, "gamedocs", ".cache"), { recursive: true });
      mkdirSync(join(dataDir, "gamedocs", "systems"), { recursive: true });
      writeFileSync(join(dataDir, "gamedocs", ".hidden", "secret.md"), "# Secret");
      writeFileSync(join(dataDir, "gamedocs", ".cache", "cached.md"), "# Cached");
      writeFileSync(join(dataDir, "gamedocs", "systems", "~battle.md"), "# Temp");
      writeFileSync(join(dataDir, "gamedocs", "systems", "battle.md"), "# Battle");

      const result = await runConvertStage({ dataDir, force: false, only: null });

      expect(result.outputPaths).toEqual(["processed/parsed/systems/battle.md"]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("includes the relative source path when conversion fails", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-convert-"));
    try {
      mkdirSync(join(dataDir, "gamedocs"), { recursive: true });
      writeFileSync(join(dataDir, "gamedocs", "broken.docx"), "not a docx");

      await expect(runConvertStage({ dataDir, force: false, only: null })).rejects.toThrow(
        /Failed to convert broken\.docx:/
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
