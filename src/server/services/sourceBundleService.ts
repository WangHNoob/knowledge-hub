import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, posix, relative, resolve, sep } from "node:path";

import type {
  DatabaseHandle,
  ImportBundleResult,
  SourceBlob,
  SourceBundle,
  SourceBundleVersion,
  SourceCategory,
  SourceFileChange,
  SourceFileEntry
} from "../types";

const CATEGORIES: SourceCategory[] = ["gamedata", "gamedocs"];

export interface ImportDirectoryOptions {
  rootPath: string;
  bundleId?: string;
  createdBy: string;
  note?: string;
}

export function createSourceBundleService(db: DatabaseHandle, dataDir: string) {
  return new SourceBundleService(db, dataDir);
}

export class SourceBundleService {
  private readonly adapter;
  constructor(private readonly db: DatabaseHandle, private readonly dataDir: string) {
    this.adapter = db.adapter;
  }

  async listBundles(): Promise<SourceBundle[]> {
    const { rows } = await this.adapter.query("SELECT * FROM source_bundles ORDER BY bundle_id ASC");
    return rows.map(mapBundle);
  }

  async listVersions(bundleId: string): Promise<SourceBundleVersion[]> {
    const { rows } = await this.adapter.query(
      "SELECT * FROM source_bundle_versions WHERE bundle_id = $1 ORDER BY created_at DESC, version_id DESC",
      [bundleId]
    );
    return rows.map(mapVersion);
  }

  async getVersion(versionId: string): Promise<SourceBundleVersion | null> {
    const { rows } = await this.adapter.query(
      "SELECT * FROM source_bundle_versions WHERE version_id = $1",
      [versionId]
    );
    return rows.length ? mapVersion(rows[0]) : null;
  }

  async listFiles(versionId: string): Promise<SourceFileEntry[]> {
    const { rows } = await this.adapter.query(
      "SELECT * FROM source_files WHERE version_id = $1 ORDER BY category ASC, logical_path ASC",
      [versionId]
    );
    return rows.map(mapFile);
  }

  async readFile(versionId: string, logicalPath: string): Promise<{ entry: SourceFileEntry; blob: SourceBlob; content: Buffer } | null> {
    const { rows: fileRows } = await this.adapter.query(
      "SELECT * FROM source_files WHERE version_id = $1 AND logical_path = $2",
      [versionId, logicalPath]
    );
    if (fileRows.length === 0) return null;
    const { rows: blobRows } = await this.adapter.query(
      "SELECT * FROM source_blobs WHERE content_hash = $1",
      [fileRows[0].content_hash]
    );
    if (blobRows.length === 0) return null;
    const absolute = blobAbsolutePath(this.dataDir, blobRows[0].storage_uri);
    const content = readFileSync(absolute);
    return { entry: mapFile(fileRows[0]), blob: mapBlob(blobRows[0]), content };
  }

  async diff(versionId: string): Promise<SourceFileChange[]> {
    const version = await this.getVersion(versionId);
    if (!version) return [];
    const current = await this.listFiles(versionId);
    const previous = version.parentVersionId ? await this.listFiles(version.parentVersionId) : [];
    return diffEntries(previous, current);
  }

  async importDirectoryAsVersion(options: ImportDirectoryOptions): Promise<ImportBundleResult> {
    const bundleId = options.bundleId ?? "default";
    const bundle = await this.requireBundle(bundleId);
    const root = resolve(options.rootPath);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new Error(`资料目录不存在或不是目录：${options.rootPath}`);
    }

    const entries = collectSourceFiles(root);
    if (entries.length === 0) {
      throw new Error("目录下未发现 gamedata/ 或 gamedocs/ 内容。");
    }

    const parent = await this.findLatestVersion(bundleId);
    const parentEntries = parent ? await this.listFiles(parent.versionId) : [];
    const parentMap = new Map(parentEntries.map((entry) => [entry.logicalPath, entry] as const));

    const timestamp = formatTimestamp(new Date());
    const versionId = `${bundleId}_${timestamp}`;
    const createdAt = new Date().toISOString();

    let added = 0;
    let modified = 0;
    let unchanged = 0;
    let totalBytes = 0;
    let newBlobCount = 0;

    try {
      await this.adapter.query("BEGIN");

      const fileInserts: Array<{ logicalPath: string; category: string; contentHash: string; byteSize: number }> = [];
      for (const file of entries) {
        const { contentHash, byteSize, isNew } = await ensureBlob(this.adapter, this.dataDir, file.absolutePath);
        if (isNew) newBlobCount += 1;
        const previous = parentMap.get(file.logicalPath);
        if (!previous) {
          added += 1;
        } else if (previous.contentHash !== contentHash) {
          modified += 1;
        } else {
          unchanged += 1;
        }
        fileInserts.push({ logicalPath: file.logicalPath, category: file.category, contentHash, byteSize });
        totalBytes += byteSize;
      }

      const currentPaths = new Set(entries.map((e) => e.logicalPath));
      const removed = parentEntries.filter((entry) => !currentPaths.has(entry.logicalPath)).length;
      const label = options.note?.trim() ? `${timestamp}__${options.note.trim().slice(0, 64)}` : timestamp;

      await this.adapter.query(
        `INSERT INTO source_bundle_versions
          (version_id, bundle_id, parent_version_id, label, note, created_by, created_at,
           file_count, added_count, modified_count, removed_count, unchanged_count, total_bytes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [versionId, bundleId, parent?.versionId ?? null, label, options.note ?? "", options.createdBy, createdAt,
         entries.length, added, modified, removed, unchanged, totalBytes]
      );

      for (const file of fileInserts) {
        await this.adapter.query(
          "INSERT INTO source_files (version_id, logical_path, category, content_hash, byte_size) VALUES ($1,$2,$3,$4,$5)",
          [versionId, file.logicalPath, file.category, file.contentHash, file.byteSize]
        );
      }

      await this.adapter.query("COMMIT");
    } catch (error) {
      await this.adapter.query("ROLLBACK");
      throw error;
    }

    const version = (await this.getVersion(versionId))!;
    const changes = await this.diff(versionId);
    return { bundle, version, changes, newBlobCount };
  }

  private async findLatestVersion(bundleId: string): Promise<SourceBundleVersion | null> {
    const { rows } = await this.adapter.query(
      "SELECT * FROM source_bundle_versions WHERE bundle_id = $1 ORDER BY created_at DESC, version_id DESC LIMIT 1",
      [bundleId]
    );
    return rows.length ? mapVersion(rows[0]) : null;
  }

  private async requireBundle(bundleId: string): Promise<SourceBundle> {
    const { rows } = await this.adapter.query("SELECT * FROM source_bundles WHERE bundle_id = $1", [bundleId]);
    if (rows.length === 0) throw new Error(`未知资料集：${bundleId}`);
    return mapBundle(rows[0]);
  }

  async updateBundle(bundleId: string, patch: { name?: string; description?: string }): Promise<SourceBundle | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) { sets.push(`name = $${params.length + 1}`); params.push(patch.name.trim()); }
    if (patch.description !== undefined) { sets.push(`description = $${params.length + 1}`); params.push(patch.description); }
    if (sets.length === 0) return null;
    params.push(bundleId);
    const { rows } = await this.adapter.query(
      `UPDATE source_bundles SET ${sets.join(", ")} WHERE bundle_id = $${params.length} RETURNING *`,
      params
    );
    return rows.length ? mapBundle(rows[0]) : null;
  }

  async updateVersion(versionId: string, patch: { label?: string; note?: string }): Promise<SourceBundleVersion | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.label !== undefined) { sets.push(`label = $${params.length + 1}`); params.push(patch.label.trim()); }
    if (patch.note !== undefined) { sets.push(`note = $${params.length + 1}`); params.push(patch.note); }
    if (sets.length === 0) return null;
    params.push(versionId);
    const { rows } = await this.adapter.query(
      `UPDATE source_bundle_versions SET ${sets.join(", ")} WHERE version_id = $${params.length} RETURNING *`,
      params
    );
    return rows.length ? mapVersion(rows[0]) : null;
  }
}

interface ScannedFile {
  absolutePath: string;
  logicalPath: string;
  category: SourceCategory;
}

function collectSourceFiles(root: string): ScannedFile[] {
  const out: ScannedFile[] = [];
  for (const category of CATEGORIES) {
    const dir = join(root, category);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    walk(dir, (absolutePath) => {
      const relPath = relative(dir, absolutePath).split(sep).join(posix.sep);
      out.push({ absolutePath, category, logicalPath: posix.join(category, relPath) });
    });
  }
  out.sort((a, b) => a.logicalPath.localeCompare(b.logicalPath));
  return out;
}

function walk(dir: string, onFile: (absolutePath: string) => void): void {
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (dirent.name.startsWith(".")) continue;
    const full = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      walk(full, onFile);
    } else if (dirent.isFile()) {
      onFile(full);
    }
  }
}

async function ensureBlob(
  adapter: import("../db-adapter").DatabaseAdapter,
  dataDir: string,
  absolutePath: string
): Promise<{ contentHash: string; byteSize: number; isNew: boolean }> {
  const content = readFileSync(absolutePath);
  const hash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const byteSize = content.byteLength;

  const { rows } = await adapter.query("SELECT storage_uri FROM source_blobs WHERE content_hash = $1", [hash]);
  if (rows.length > 0) return { contentHash: hash, byteSize, isNew: false };

  const hexOnly = hash.slice("sha256:".length);
  const shard = hexOnly.slice(0, 2);
  const ext = extname(absolutePath).toLowerCase();
  const fileName = `${hexOnly}${ext}`;
  const relUri = posix.join("storage", "blobs", shard, fileName);
  const targetDir = join(dataDir, "storage", "blobs", shard);
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, fileName), content);

  await adapter.query(
    "INSERT INTO source_blobs (content_hash, byte_size, storage_uri, first_seen_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
    [hash, byteSize, relUri, new Date().toISOString()]
  );
  return { contentHash: hash, byteSize, isNew: true };
}

function diffEntries(previous: SourceFileEntry[], current: SourceFileEntry[]): SourceFileChange[] {
  const prevMap = new Map(previous.map((e) => [e.logicalPath, e] as const));
  const currMap = new Map(current.map((e) => [e.logicalPath, e] as const));
  const changes: SourceFileChange[] = [];
  for (const entry of current) {
    const prev = prevMap.get(entry.logicalPath);
    if (!prev) {
      changes.push({ kind: "added", logicalPath: entry.logicalPath, category: entry.category, contentHash: entry.contentHash });
    } else if (prev.contentHash !== entry.contentHash) {
      changes.push({ kind: "modified", logicalPath: entry.logicalPath, category: entry.category, contentHash: entry.contentHash, previousHash: prev.contentHash });
    }
  }
  for (const entry of previous) {
    if (!currMap.has(entry.logicalPath)) {
      changes.push({ kind: "removed", logicalPath: entry.logicalPath, category: entry.category, previousHash: entry.contentHash });
    }
  }
  return changes;
}

let timestampMonotonicCounter = 0n;

function formatTimestamp(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  timestampMonotonicCounter += 1n;
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    `_${pad(date.getMilliseconds(), 3)}` +
    `_${timestampMonotonicCounter.toString().padStart(4, "0")}`
  );
}

function blobAbsolutePath(dataDir: string, storageUri: string): string {
  return join(dataDir, ...storageUri.split(posix.sep));
}

function mapBundle(row: Record<string, unknown>): SourceBundle {
  return { bundleId: row.bundle_id as string, name: row.name as string, description: row.description as string, createdAt: String(row.created_at) };
}

function mapVersion(row: Record<string, unknown>): SourceBundleVersion {
  return {
    versionId: row.version_id as string,
    bundleId: row.bundle_id as string,
    parentVersionId: (row.parent_version_id as string | null) ?? null,
    label: row.label as string,
    note: row.note as string,
    createdBy: row.created_by as string,
    createdAt: String(row.created_at),
    fileCount: Number(row.file_count),
    addedCount: Number(row.added_count),
    modifiedCount: Number(row.modified_count),
    removedCount: Number(row.removed_count),
    unchangedCount: Number(row.unchanged_count),
    totalBytes: Number(row.total_bytes)
  };
}

function mapFile(row: Record<string, unknown>): SourceFileEntry {
  return {
    versionId: row.version_id as string,
    logicalPath: row.logical_path as string,
    category: row.category as SourceCategory,
    contentHash: row.content_hash as string,
    byteSize: Number(row.byte_size)
  };
}

function mapBlob(row: Record<string, unknown>): SourceBlob {
  return {
    contentHash: row.content_hash as string,
    byteSize: Number(row.byte_size),
    storageUri: row.storage_uri as string,
    firstSeenAt: String(row.first_seen_at)
  };
}
