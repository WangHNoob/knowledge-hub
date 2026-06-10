import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/server/db";
import { createSourceBundleService } from "../src/server/services/sourceBundleService";
import type { DatabaseHandle } from "../src/server/types";

describe("source bundle service", () => {
  let dir: string;
  let raw: string;
  let db: DatabaseHandle | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "knowledge-hub-bundle-"));
    raw = join(dir, "raw");
    mkdirSync(join(raw, "gamedata"), { recursive: true });
    mkdirSync(join(raw, "gamedocs"), { recursive: true });
    writeFileSync(join(raw, "gamedata", "items.csv"), "id,name\n1,A\n2,B\n");
    writeFileSync(join(raw, "gamedata", "skills.csv"), "id,power\n1,10\n");
    writeFileSync(join(raw, "gamedocs", "combat.md"), "# Combat");
    db = createDatabase({ dataDir: dir, seedUsers: false });
  });

  afterEach(() => {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a versioned snapshot of gamedata + gamedocs", () => {
    const service = createSourceBundleService(db!, dir);
    const result = service.importDirectoryAsVersion({ rootPath: raw, createdBy: "tester" });

    expect(result.version.fileCount).toBe(3);
    expect(result.version.addedCount).toBe(3);
    expect(result.version.modifiedCount).toBe(0);
    expect(result.version.removedCount).toBe(0);
    expect(result.newBlobCount).toBe(3);
    expect(result.version.versionId).toMatch(/^default_\d{8}_\d{6}_\d{3}_\d{4,}$/);

    const files = service.listFiles(result.version.versionId);
    expect(files.map((f) => f.logicalPath).sort()).toEqual([
      "gamedata/items.csv",
      "gamedata/skills.csv",
      "gamedocs/combat.md"
    ]);
  });

  it("reuses blobs and reports zero modifications when re-importing the same tree", () => {
    const service = createSourceBundleService(db!, dir);
    const first = service.importDirectoryAsVersion({ rootPath: raw, createdBy: "tester" });
    const second = service.importDirectoryAsVersion({ rootPath: raw, createdBy: "tester" });

    expect(second.version.parentVersionId).toBe(first.version.versionId);
    expect(second.version.unchangedCount).toBe(3);
    expect(second.version.addedCount).toBe(0);
    expect(second.version.modifiedCount).toBe(0);
    expect(second.newBlobCount).toBe(0);

    const blobCount = (db!.sqlite.prepare("SELECT COUNT(*) AS c FROM source_blobs").get() as { c: number }).c;
    expect(blobCount).toBe(3);
  });

  it("detects added, modified and removed files between versions", () => {
    const service = createSourceBundleService(db!, dir);
    const first = service.importDirectoryAsVersion({ rootPath: raw, createdBy: "tester" });

    // 修改一个、新增一个、删除一个
    writeFileSync(join(raw, "gamedata", "items.csv"), "id,name\n1,Apple\n2,Berry\n");
    writeFileSync(join(raw, "gamedocs", "events.md"), "# Events");
    unlinkSync(join(raw, "gamedata", "skills.csv"));

    const second = service.importDirectoryAsVersion({ rootPath: raw, createdBy: "tester" });
    expect(second.version.fileCount).toBe(3);
    expect(second.version.addedCount).toBe(1);
    expect(second.version.modifiedCount).toBe(1);
    expect(second.version.removedCount).toBe(1);
    expect(second.version.unchangedCount).toBe(1);

    const changes = service.diff(second.version.versionId);
    const kinds = changes.map((c) => `${c.kind}:${c.logicalPath}`).sort();
    expect(kinds).toEqual([
      "added:gamedocs/events.md",
      "modified:gamedata/items.csv",
      "removed:gamedata/skills.csv"
    ]);

    // blobs: 第一版 3 个 + 修改后 items.csv 新 hash + 新增 events.md = 5
    const blobs = (db!.sqlite.prepare("SELECT COUNT(*) AS c FROM source_blobs").get() as { c: number }).c;
    expect(blobs).toBe(5);

    // 引用：v1 还能完整还原 skills.csv
    const restored = service.readFile(first.version.versionId, "gamedata/skills.csv");
    expect(restored?.content.toString()).toBe("id,power\n1,10\n");
  });

  it("dedupes identical content under different paths", () => {
    writeFileSync(join(raw, "gamedocs", "duplicate.md"), "# Combat");
    const service = createSourceBundleService(db!, dir);
    const result = service.importDirectoryAsVersion({ rootPath: raw, createdBy: "tester" });

    expect(result.version.fileCount).toBe(4);
    const blobs = (db!.sqlite.prepare("SELECT COUNT(*) AS c FROM source_blobs").get() as { c: number }).c;
    expect(blobs).toBe(3);
  });

  it("rejects directories that lack gamedata/ and gamedocs/", () => {
    const empty = join(dir, "empty");
    mkdirSync(empty, { recursive: true });
    const service = createSourceBundleService(db!, dir);
    expect(() => service.importDirectoryAsVersion({ rootPath: empty, createdBy: "tester" })).toThrow();
  });
});
