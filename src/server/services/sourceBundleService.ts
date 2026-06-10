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
  constructor(
    private readonly db: DatabaseHandle,
    private readonly dataDir: string
  ) {}

  listBundles(): SourceBundle[] {
    const rows = this.db.sqlite
      .prepare("SELECT * FROM source_bundles ORDER BY bundle_id ASC")
      .all() as unknown as BundleRow[];
    return rows.map(mapBundle);
  }

  listVersions(bundleId: string): SourceBundleVersion[] {
    const rows = this.db.sqlite
      .prepare(
        "SELECT * FROM source_bundle_versions WHERE bundle_id = ? ORDER BY created_at DESC, version_id DESC"
      )
      .all(bundleId) as unknown as VersionRow[];
    return rows.map(mapVersion);
  }

  getVersion(versionId: string): SourceBundleVersion | null {
    const row = this.db.sqlite
      .prepare("SELECT * FROM source_bundle_versions WHERE version_id = ?")
      .get(versionId) as VersionRow | undefined;
    return row ? mapVersion(row) : null;
  }

  listFiles(versionId: string): SourceFileEntry[] {
    const rows = this.db.sqlite
      .prepare(
        "SELECT * FROM source_files WHERE version_id = ? ORDER BY category ASC, logical_path ASC"
      )
      .all(versionId) as unknown as FileRow[];
    return rows.map(mapFile);
  }

  readFile(versionId: string, logicalPath: string): { entry: SourceFileEntry; blob: SourceBlob; content: Buffer } | null {
    const fileRow = this.db.sqlite
      .prepare("SELECT * FROM source_files WHERE version_id = ? AND logical_path = ?")
      .get(versionId, logicalPath) as FileRow | undefined;
    if (!fileRow) return null;
    const blobRow = this.db.sqlite
      .prepare("SELECT * FROM source_blobs WHERE content_hash = ?")
      .get(fileRow.content_hash) as BlobRow | undefined;
    if (!blobRow) return null;
    const absolute = blobAbsolutePath(this.dataDir, blobRow.storage_uri);
    const content = readFileSync(absolute);
    return { entry: mapFile(fileRow), blob: mapBlob(blobRow), content };
  }

  diff(versionId: string): SourceFileChange[] {
    const version = this.getVersion(versionId);
    if (!version) return [];
    const current = this.listFiles(versionId);
    const previous = version.parentVersionId ? this.listFiles(version.parentVersionId) : [];
    return diffEntries(previous, current);
  }

  importDirectoryAsVersion(options: ImportDirectoryOptions): ImportBundleResult {
    const bundleId = options.bundleId ?? "default";
    const bundle = this.requireBundle(bundleId);
    const root = resolve(options.rootPath);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new Error(`资料目录不存在或不是目录：${options.rootPath}`);
    }

    const entries = collectSourceFiles(root);
    if (entries.length === 0) {
      throw new Error("目录下未发现 gamedata/ 或 gamedocs/ 内容。");
    }

    const parent = this.findLatestVersion(bundleId);
    const parentEntries = parent ? this.listFiles(parent.versionId) : [];
    const parentMap = new Map(parentEntries.map((entry) => [entry.logicalPath, entry] as const));

    const timestamp = formatTimestamp(new Date());
    const versionId = `${bundleId}_${timestamp}`;
    const createdAt = new Date().toISOString();

    let added = 0;
    let modified = 0;
    let unchanged = 0;
    let totalBytes = 0;
    let newBlobCount = 0;

    const sqlite = this.db.sqlite;
    const insertBlobStmt = sqlite.prepare(
      `INSERT OR IGNORE INTO source_blobs (content_hash, byte_size, storage_uri, first_seen_at)
       VALUES (?, ?, ?, ?)`
    );
    const insertFileStmt = sqlite.prepare(
      `INSERT INTO source_files (version_id, logical_path, category, content_hash, byte_size)
       VALUES (?, ?, ?, ?, ?)`
    );
    const insertVersionStmt = sqlite.prepare(
      `INSERT INTO source_bundle_versions
        (version_id, bundle_id, parent_version_id, label, note, created_by, created_at,
         file_count, added_count, modified_count, removed_count, unchanged_count, total_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    sqlite.exec("BEGIN");
    try {
      const fileInserts: Array<{ logicalPath: string; category: string; contentHash: string; byteSize: number }> = [];
      for (const file of entries) {
        const { contentHash, byteSize, isNew } = ensureBlob(this.dataDir, file.absolutePath, insertBlobStmt, sqlite);
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
      insertVersionStmt.run(
        versionId,
        bundleId,
        parent?.versionId ?? null,
        label,
        options.note ?? "",
        options.createdBy,
        createdAt,
        entries.length,
        added,
        modified,
        removed,
        unchanged,
        totalBytes
      );
      for (const file of fileInserts) {
        insertFileStmt.run(versionId, file.logicalPath, file.category, file.contentHash, file.byteSize);
      }
      sqlite.exec("COMMIT");

      const version = this.getVersion(versionId)!;
      const changes = diffEntries(parentEntries, this.listFiles(versionId));
      return { bundle, version, changes, newBlobCount };
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  private findLatestVersion(bundleId: string): SourceBundleVersion | null {
    const row = this.db.sqlite
      .prepare(
        "SELECT * FROM source_bundle_versions WHERE bundle_id = ? ORDER BY created_at DESC, version_id DESC LIMIT 1"
      )
      .get(bundleId) as VersionRow | undefined;
    return row ? mapVersion(row) : null;
  }

  private requireBundle(bundleId: string): SourceBundle {
    const row = this.db.sqlite
      .prepare("SELECT * FROM source_bundles WHERE bundle_id = ?")
      .get(bundleId) as BundleRow | undefined;
    if (!row) throw new Error(`未知资料集：${bundleId}`);
    return mapBundle(row);
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
      out.push({
        absolutePath,
        category,
        logicalPath: posix.join(category, relPath)
      });
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

function ensureBlob(
  dataDir: string,
  absolutePath: string,
  insertBlobStmt: ReturnType<DatabaseHandle["sqlite"]["prepare"]>,
  sqlite: DatabaseHandle["sqlite"]
): { contentHash: string; byteSize: number; isNew: boolean } {
  const content = readFileSync(absolutePath);
  const hash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const byteSize = content.byteLength;
  const existing = sqlite
    .prepare("SELECT storage_uri FROM source_blobs WHERE content_hash = ?")
    .get(hash) as { storage_uri: string } | undefined;
  if (existing) return { contentHash: hash, byteSize, isNew: false };

  const hexOnly = hash.slice("sha256:".length);
  const shard = hexOnly.slice(0, 2);
  const ext = extname(absolutePath).toLowerCase();
  const fileName = `${hexOnly}${ext}`;
  const relUri = posix.join("storage", "blobs", shard, fileName);
  const targetDir = join(dataDir, "storage", "blobs", shard);
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, fileName), content);
  insertBlobStmt.run(hash, byteSize, relUri, new Date().toISOString());
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
      changes.push({
        kind: "modified",
        logicalPath: entry.logicalPath,
        category: entry.category,
        contentHash: entry.contentHash,
        previousHash: prev.contentHash
      });
    }
  }
  for (const entry of previous) {
    if (!currMap.has(entry.logicalPath)) {
      changes.push({
        kind: "removed",
        logicalPath: entry.logicalPath,
        category: entry.category,
        previousHash: entry.contentHash
      });
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

interface BundleRow {
  bundle_id: string;
  name: string;
  description: string;
  created_at: string;
}

interface VersionRow {
  version_id: string;
  bundle_id: string;
  parent_version_id: string | null;
  label: string;
  note: string;
  created_by: string;
  created_at: string;
  file_count: number;
  added_count: number;
  modified_count: number;
  removed_count: number;
  unchanged_count: number;
  total_bytes: number;
}

interface FileRow {
  version_id: string;
  logical_path: string;
  category: string;
  content_hash: string;
  byte_size: number;
}

interface BlobRow {
  content_hash: string;
  byte_size: number;
  storage_uri: string;
  first_seen_at: string;
}

function mapBundle(row: BundleRow): SourceBundle {
  return {
    bundleId: row.bundle_id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at
  };
}

function mapVersion(row: VersionRow): SourceBundleVersion {
  return {
    versionId: row.version_id,
    bundleId: row.bundle_id,
    parentVersionId: row.parent_version_id,
    label: row.label,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
    fileCount: row.file_count,
    addedCount: row.added_count,
    modifiedCount: row.modified_count,
    removedCount: row.removed_count,
    unchangedCount: row.unchanged_count,
    totalBytes: row.total_bytes
  };
}

function mapFile(row: FileRow): SourceFileEntry {
  return {
    versionId: row.version_id,
    logicalPath: row.logical_path,
    category: row.category as SourceCategory,
    contentHash: row.content_hash,
    byteSize: row.byte_size
  };
}

function mapBlob(row: BlobRow): SourceBlob {
  return {
    contentHash: row.content_hash,
    byteSize: row.byte_size,
    storageUri: row.storage_uri,
    firstSeenAt: row.first_seen_at
  };
}
