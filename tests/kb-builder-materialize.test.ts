import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/server/db";
import { createSourceBundleService } from "../src/server/services/sourceBundleService";
import type { SourceBundleService } from "../src/server/services/sourceBundleService";
import { materializeSourceVersion } from "../src/server/services/kbBuilder/materialize";
import type { DatabaseHandle, SourceFileEntry } from "../src/server/types";

describe("materializeSourceVersion", () => {
  it("copies gamedocs and gamedata files into an isolated run workspace", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-data-"));
    const sourceRoot = mkdtempSync(join(tmpdir(), "kh-kb-src-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "kh-kb-work-"));
    mkdirSync(join(sourceRoot, "gamedocs", "systems"), { recursive: true });
    mkdirSync(join(sourceRoot, "gamedata", "Config"), { recursive: true });
    writeFileSync(join(sourceRoot, "gamedocs", "systems", "battle.md"), "# Battle\n");
    writeFileSync(join(sourceRoot, "gamedata", "Config", "Skill.csv"), "Id,Name\n1,Slash\n");

    const db = await createDatabase({ dataDir, seedUsers: false });
    try {
      const sourceService = createSourceBundleService(db, dataDir);
      const imported = await sourceService.importDirectoryAsVersion({
        rootPath: sourceRoot,
        bundleId: "default",
        createdBy: "admin",
        note: "fixture"
      });

      const result = await materializeSourceVersion({
        db,
        sourceService,
        versionId: imported.version.versionId,
        workspaceRoot,
        runId: "run_native_test"
      });

      expect(result.workspaceDir.endsWith("run_native_test")).toBe(true);
      expect(existsSync(join(result.dataDir, "gamedocs", "systems", "battle.md"))).toBe(true);
      expect(existsSync(join(result.dataDir, "gamedata", "Config", "Skill.csv"))).toBe(true);
      expect(readFileSync(join(result.dataDir, "gamedocs", "systems", "battle.md"), "utf8")).toContain("# Battle");
      expect(result.files.map((file) => file.logicalPath).sort()).toEqual([
        "gamedata/Config/Skill.csv",
        "gamedocs/systems/battle.md"
      ]);
    } finally {
      await db.close();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(sourceRoot, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("rejects logical paths outside exact gamedocs and gamedata roots", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "kh-kb-work-"));
    const badPaths = [
      "gamedatabase/foo.csv",
      "gamedocs-old/x.md",
      "../gamedocs/foo.md",
      "/gamedocs/foo.md",
      "gamedocs/../gamedata/foo.csv"
    ];

    try {
      for (const [index, logicalPath] of badPaths.entries()) {
        const file: SourceFileEntry = {
          versionId: "version_bad_paths",
          logicalPath,
          category: "gamedocs",
          contentHash: "sha256:bad",
          byteSize: 4
        };
        const sourceService = {
          listFiles: async () => [file],
          readFile: async () => ({ entry: file, blob: {} as never, content: Buffer.from("bad\n") })
        } as unknown as SourceBundleService;

        await expect(
          materializeSourceVersion({
            db: {} as DatabaseHandle,
            sourceService,
            versionId: file.versionId,
            workspaceRoot,
            runId: `run_bad_path_${index}`
          })
        ).rejects.toThrow(`Unsupported source logical path: ${logicalPath}`);
      }
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
