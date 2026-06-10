import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, parse } from "node:path";

import type { DatabaseHandle, SourceRecord } from "../types";

export interface SourceImportInput {
  filename: string;
  content: Buffer;
  title?: string;
}

export interface SourceImportResult {
  created: boolean;
  source: SourceRecord;
}

export function createSourceImportService(db: DatabaseHandle, dataDir: string) {
  return new SourceImportService(db, dataDir);
}

export class SourceImportService {
  constructor(
    private readonly db: DatabaseHandle,
    private readonly dataDir: string
  ) {}

  importFile(path: string, title?: string): SourceImportResult {
    return this.importBuffer({
      filename: basename(path),
      content: readFileSync(path),
      title
    });
  }

  importBuffer(input: SourceImportInput): SourceImportResult {
    const cleanName = basename(input.filename || "source.bin");
    const sourceId = `src_${deriveSourceSlug(cleanName)}`;
    const contentHash = `sha256:${createHash("sha256").update(input.content).digest("hex")}`;
    const shortHash = contentHash.slice("sha256:".length, "sha256:".length + 12);
    const sourceVersionId = `srcv_${sourceId.replace(/^src_/, "")}_${shortHash}`;
    const existing = this.db.sqlite
      .prepare("SELECT * FROM sources WHERE source_version_id = ?")
      .get(sourceVersionId);

    if (existing) {
      return { created: false, source: mapSource(existing as unknown as SourceRow) };
    }

    const storageDir = join(this.dataDir, "storage", "sources", sourceId);
    mkdirSync(storageDir, { recursive: true });
    const storedName = `${shortHash}__${cleanName}`;
    const absolutePath = join(storageDir, storedName);
    writeFileSync(absolutePath, input.content);
    const storageUri = join("storage", "sources", sourceId, storedName).replaceAll("\\", "/");

    const source: SourceRecord = {
      sourceId,
      sourceVersionId,
      title: input.title?.trim() || parse(cleanName).name,
      sourceType: extname(cleanName).replace(".", "").toLowerCase() || "unknown",
      status: "active",
      contentHash,
      storageUri
    };

    this.db.sqlite
      .prepare(`
        INSERT INTO sources
          (source_id, source_version_id, title, source_type, status, content_hash, storage_uri)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        source.sourceId,
        source.sourceVersionId,
        source.title,
        source.sourceType,
        source.status,
        source.contentHash,
        source.storageUri
      );

    return { created: true, source };
  }
}

interface SourceRow {
  source_id: string;
  source_version_id: string;
  title: string;
  source_type: string;
  status: string;
  content_hash: string;
  storage_uri: string;
}

function mapSource(row: SourceRow): SourceRecord {
  return {
    sourceId: row.source_id,
    sourceVersionId: row.source_version_id,
    title: row.title,
    sourceType: row.source_type,
    status: row.status,
    contentHash: row.content_hash,
    storageUri: row.storage_uri
  };
}

function deriveSourceSlug(filename: string): string {
  const stem = parse(filename).name.toLowerCase();
  const ascii = stem
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (ascii) return ascii;
  const phraseMap: Record<string, string> = {
    装备异化: "equipment"
  };
  if (phraseMap[stem]) return phraseMap[stem];
  const pinyinLike: Record<string, string> = {
    装: "zhuang",
    备: "bei",
    异: "yi",
    化: "hua"
  };
  const mapped = Array.from(stem).map((char) => pinyinLike[char] ?? "").join("_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return mapped || "source";
}
