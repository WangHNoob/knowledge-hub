import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/server/db";
import { createKnowledgeService } from "../src/server/services/knowledgeService";
import { createSourceImportService } from "../src/server/services/sourceImportService";
import type { DatabaseHandle } from "../src/server/types";

describe("source import service", () => {
  let dir: string;
  let db: DatabaseHandle | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "knowledge-hub-import-"));
    db = createDatabase({ dataDir: dir, seed: false });
  });

  afterEach(() => {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("imports a source buffer as an immutable source version", () => {
    const importer = createSourceImportService(db!, dir);

    const result = importer.importBuffer({
      filename: "装备异化.docx",
      content: Buffer.from("equipment design content"),
      title: "装备异化设计"
    });

    expect(result.created).toBe(true);
    expect(result.source.sourceId).toBe("src_equipment");
    expect(result.source.sourceVersionId).toMatch(/^srcv_equipment_[a-f0-9]{12}$/);
    expect(result.source.contentHash).toMatch(/^sha256:/);
    expect(existsSync(join(dir, result.source.storageUri))).toBe(true);
    expect(readFileSync(join(dir, result.source.storageUri), "utf8")).toBe("equipment design content");

    const sources = createKnowledgeService(db!).listSources();
    expect(sources.map((source) => source.title)).toContain("装备异化设计");
  });

  it("is idempotent for the same source content", () => {
    const importer = createSourceImportService(db!, dir);
    const first = importer.importBuffer({
      filename: "activity.md",
      content: Buffer.from("same content")
    });
    const second = importer.importBuffer({
      filename: "activity.md",
      content: Buffer.from("same content")
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.source.sourceVersionId).toBe(first.source.sourceVersionId);
    expect(createKnowledgeService(db!).listSources()).toHaveLength(1);
  });
});
