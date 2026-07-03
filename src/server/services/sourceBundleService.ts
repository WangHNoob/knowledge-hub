import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, posix, relative, resolve, sep } from "node:path";
import xlsx from "xlsx";

import type {
  DatabaseHandle,
  ImportBundleResult,
  SourceBlob,
  SourceBundle,
  SourceBuildPlan,
  SourceBundleVersion,
  SourceCategory,
  SourceFilePreview,
  SourceFileChange,
  SourceFileEntry,
  SourcePreviewNode
} from "../types";
import { emitKnowledgeEvent } from "./eventService";

const CATEGORIES: SourceCategory[] = ["gamedata", "gamedocs"];

export interface ImportDirectoryOptions {
  rootPath: string;
  bundleId?: string;
  projectId?: string;
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

  async listBundles(projectId = "default_project"): Promise<SourceBundle[]> {
    const { rows } = await this.adapter.query(
      "SELECT * FROM source_bundles WHERE project_id = $1 ORDER BY bundle_id ASC",
      [projectId],
    );
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

  async previewVersion(versionId: string): Promise<{ tree: SourcePreviewNode[]; files: SourcePreviewNode[]; changes: SourceFileChange[] }> {
    const files = await this.listFiles(versionId);
    const changes = await this.diff(versionId);
    const changeByPath = new Map(changes.map((change) => [change.logicalPath, change.kind] as const));
    const fileNodes: SourcePreviewNode[] = files.map((file) => ({
      name: basename(file.logicalPath),
      path: file.logicalPath,
      kind: "file" as const,
      category: file.category,
      byteSize: file.byteSize,
      contentHash: file.contentHash,
      fileType: fileTypeFor(file.logicalPath),
      changeKind: changeByPath.get(file.logicalPath) ?? "unchanged",
    }));
    return { tree: buildTree(fileNodes), files: fileNodes, changes };
  }

  async previewFile(versionId: string, logicalPath: string): Promise<SourceFilePreview | null> {
    const file = await this.readFile(versionId, logicalPath);
    if (!file) return null;
    const fileType = fileTypeFor(logicalPath);
    if (fileType === "spreadsheet") {
      const workbook = xlsx.read(file.content, { type: "buffer" });
      const sheet = workbook.SheetNames[0] ?? "";
      const rows = sheet ? xlsx.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheet], { header: 1, defval: "", blankrows: false }).slice(0, 12) : [];
      return {
        logicalPath,
        category: file.entry.category,
        byteSize: file.entry.byteSize,
        contentHash: file.entry.contentHash,
        fileType,
        sheet,
        rows,
        preview: rows.map((row) => row.map((cell) => String(cell ?? "")).join(" | ")),
        truncated: rows.length >= 12,
      };
    }
    if (fileType === "binary") {
      return {
        logicalPath,
        category: file.entry.category,
        byteSize: file.entry.byteSize,
        contentHash: file.entry.contentHash,
        fileType,
        preview: ["二进制文件不提供文本预览。"],
        truncated: false,
      };
    }
    const text = file.content.toString("utf8");
    const lines = text.split(/\r?\n/u).slice(0, 60);
    return {
      logicalPath,
      category: file.entry.category,
      byteSize: file.entry.byteSize,
      contentHash: file.entry.contentHash,
      fileType,
      preview: lines,
      truncated: text.split(/\r?\n/u).length > lines.length,
    };
  }

  async buildPlan(versionId: string, projectId = "default_project"): Promise<SourceBuildPlan> {
    const version = await this.getVersion(versionId);
    if (!version) throw new Error(`Unknown source version: ${versionId}`);
    const changes = await this.diff(versionId);
    const changed = changes.filter((change) => change.kind === "added" || change.kind === "modified");
    const removed = changes.filter((change) => change.kind === "removed");
    const targets = changed.map((change) => change.logicalPath).sort();
    const warnings: string[] = [];
    if (removed.length > 0) warnings.push(`本次删除 ${removed.length} 个资料文件，建议全量构建确认知识资产是否需要移除。`);
    if (targets.length > 12) warnings.push(`本次变更 ${targets.length} 个文件，增量构建收益下降，建议全量构建。`);
    if (targets.length === 0) warnings.push("没有新增或修改的文件，不需要启动增量构建。");
    const affectedKnowledge = await this.findAffectedKnowledge(projectId, [...targets, ...removed.map((change) => change.logicalPath)]);
    const recommendedMode: SourceBuildPlan["recommendedMode"] = removed.length > 0 || targets.length === 0 || targets.length > 12 ? "full" : "incremental";
    const reason = recommendedMode === "incremental"
      ? `检测到 ${targets.length} 个新增/修改文件，可优先只重建这些资料对应的知识资产。`
      : removed.length > 0
        ? "存在删除文件，局部构建无法可靠移除旧知识，建议全量构建。"
        : targets.length === 0
          ? "没有可增量构建的资料变更。"
          : "变更文件较多，建议全量构建以减少遗漏风险。";
    return { recommendedMode, targets, reason, affectedKnowledge, warnings };
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
    const projectId = options.projectId ?? "default_project";
    const bundle = await this.requireBundle(bundleId, projectId);
    const root = resolve(options.rootPath);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new Error(`资料目录不存在或不是目录：${options.rootPath}`);
    }

    const sourceRoot = resolveSourceRoot(root);
    const entries = collectSourceFiles(sourceRoot);
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
    const driftCandidates: Array<{ logicalPath: string; previousHash: string; currentHash: string; changeKind: "modified" | "removed" }> = [];

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
          driftCandidates.push({
            logicalPath: file.logicalPath,
            previousHash: previous.contentHash,
            currentHash: contentHash,
            changeKind: "modified",
          });
        } else {
          unchanged += 1;
        }
        fileInserts.push({ logicalPath: file.logicalPath, category: file.category, contentHash, byteSize });
        totalBytes += byteSize;
      }

      const currentPaths = new Set(entries.map((e) => e.logicalPath));
      const removedEntries = parentEntries.filter((entry) => !currentPaths.has(entry.logicalPath));
      const removed = removedEntries.length;
      for (const entry of removedEntries) {
        driftCandidates.push({
          logicalPath: entry.logicalPath,
          previousHash: entry.contentHash,
          currentHash: "",
          changeKind: "removed",
        });
      }
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
      await this.markDriftedSourceCorrections({
        bundleId,
        versionId,
        actor: options.createdBy,
        now: createdAt,
        changes: driftCandidates,
      });

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

  private async requireBundle(bundleId: string, projectId = "default_project"): Promise<SourceBundle> {
    const { rows } = await this.adapter.query(
      "SELECT * FROM source_bundles WHERE bundle_id = $1 AND project_id = $2",
      [bundleId, projectId],
    );
    if (rows.length === 0) throw new Error(`未知资料集：${bundleId}`);
    return mapBundle(rows[0]);
  }

  async updateBundle(bundleId: string, patch: { name?: string; description?: string }, projectId = "default_project"): Promise<SourceBundle | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) { sets.push(`name = $${params.length + 1}`); params.push(patch.name.trim()); }
    if (patch.description !== undefined) { sets.push(`description = $${params.length + 1}`); params.push(patch.description); }
    if (sets.length === 0) return null;
    params.push(bundleId);
    const { rows } = await this.adapter.query(
      `UPDATE source_bundles SET ${sets.join(", ")} WHERE bundle_id = $${params.length} AND project_id = $${params.length + 1} RETURNING *`,
      [...params, projectId]
    );
    return rows.length ? mapBundle(rows[0]) : null;
  }

  async bundleBelongsToProject(bundleId: string, projectId: string): Promise<boolean> {
    const { rows } = await this.adapter.query(
      "SELECT 1 FROM source_bundles WHERE bundle_id = $1 AND project_id = $2",
      [bundleId, projectId],
    );
    return rows.length > 0;
  }

  async getDefaultBundle(projectId = "default_project"): Promise<SourceBundle | null> {
    const { rows } = await this.adapter.query(
      "SELECT * FROM source_bundles WHERE project_id = $1 ORDER BY created_at ASC, bundle_id ASC LIMIT 1",
      [projectId],
    );
    return rows.length ? mapBundle(rows[0]) : null;
  }

  async getBundle(bundleId: string, projectId = "default_project"): Promise<SourceBundle | null> {
    const { rows } = await this.adapter.query(
      "SELECT * FROM source_bundles WHERE bundle_id = $1 AND project_id = $2",
      [bundleId, projectId],
    );
    return rows.length ? mapBundle(rows[0]) : null;
  }

  private async findAffectedKnowledge(projectId: string, sourcePaths: string[]): Promise<SourceBuildPlan["affectedKnowledge"]> {
    const normalizedTargets = sourcePaths.map(normalizePath).filter(Boolean);
    if (normalizedTargets.length === 0) return [];
    const { rows } = await this.adapter.query(
      `SELECT c.component_id, c.package_id, c.title, c.kind, c.legacy_path, c.source_refs
       FROM asset_components c
       JOIN asset_packages p ON p.package_id = c.package_id
       WHERE p.project_id = $1
       ORDER BY c.title ASC, c.component_id ASC
       LIMIT 1000`,
      [projectId],
    );
    const affected = rows.filter((row) => {
      const refs = jsonArray(row.source_refs).map(normalizePath);
      const legacyPath = normalizePath(String(row.legacy_path ?? ""));
      const title = String(row.title ?? "").toLowerCase();
      return normalizedTargets.some((target) => {
        const stem = basename(target, extname(target)).toLowerCase();
        return refs.some((ref) => ref === target || ref.endsWith(`/${target}`) || target.endsWith(`/${ref}`))
          || legacyPath.includes(stem)
          || title.includes(stem);
      });
    });
    return affected.slice(0, 20).map((row) => ({
      componentId: String(row.component_id),
      packageId: String(row.package_id),
      title: String(row.title ?? ""),
      kind: String(row.kind ?? ""),
      legacyPath: String(row.legacy_path ?? ""),
    }));
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

  private async markDriftedSourceCorrections(input: {
    bundleId: string;
    versionId: string;
    actor: string;
    now: string;
    changes: Array<{ logicalPath: string; previousHash: string; currentHash: string; changeKind: "modified" | "removed" }>;
  }): Promise<void> {
    for (const change of input.changes) {
      const { rows } = await this.adapter.query(
        `UPDATE source_corrections
         SET state = 'pending_review', updated_at = $4
         WHERE bundle_id = $1
           AND source_path = $2
           AND state = 'active'
           AND bound_source_hash <> $3
         RETURNING correction_id, rule_id, page_type, fact_key, bound_source_hash`,
        [input.bundleId, change.logicalPath, change.currentHash, input.now],
      );
      for (const row of rows) {
        await emitKnowledgeEvent(this.db, {
          eventType: "source_correction.pending_review",
          entityType: "source_correction",
          entityId: String(row.correction_id),
          payload: {
            bundleId: input.bundleId,
            versionId: input.versionId,
            sourcePath: change.logicalPath,
            changeKind: change.changeKind,
            previousHash: change.previousHash,
            currentHash: change.currentHash,
            boundSourceHash: String(row.bound_source_hash ?? ""),
            ruleId: String(row.rule_id ?? ""),
            pageType: String(row.page_type ?? ""),
            factKey: row.fact_key ? String(row.fact_key) : "",
            actor: input.actor,
          },
        });
      }
    }
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

function resolveSourceRoot(root: string): string {
  if (hasSourceCategoryDir(root)) return root;
  const directories = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => join(root, entry.name));
  const matching = directories.filter(hasSourceCategoryDir);
  return matching.length === 1 ? matching[0] : root;
}

function hasSourceCategoryDir(root: string): boolean {
  return CATEGORIES.some((category) => {
    const dir = join(root, category);
    return existsSync(dir) && statSync(dir).isDirectory();
  });
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

function buildTree(files: SourcePreviewNode[]): SourcePreviewNode[] {
  const roots: SourcePreviewNode[] = [];
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let children = roots;
    let currentPath = "";
    for (const [index, part] of parts.entries()) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isFile = index === parts.length - 1;
      if (isFile) {
        children.push(file);
        continue;
      }
      let dir = children.find((node) => node.kind === "directory" && node.name === part);
      if (!dir) {
        dir = { name: part, path: currentPath, kind: "directory", children: [] };
        children.push(dir);
      }
      children = dir.children ?? [];
      dir.children = children;
    }
  }
  return sortTree(roots);
}

function sortTree(nodes: SourcePreviewNode[]): SourcePreviewNode[] {
  return nodes
    .map((node) => node.children ? { ...node, children: sortTree(node.children) } : node)
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

function fileTypeFor(logicalPath: string): SourcePreviewNode["fileType"] {
  const ext = extname(logicalPath).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if ([".xlsx", ".xls", ".csv"].includes(ext)) return "spreadsheet";
  if (ext === ".json") return "json";
  if ([".txt", ".tsv", ".xml", ".yaml", ".yml"].includes(ext)) return "text";
  return "binary";
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

function jsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.length > 0) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
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
  return {
    bundleId: row.bundle_id as string,
    projectId: String(row.project_id ?? "default_project"),
    name: row.name as string,
    description: row.description as string,
    createdAt: String(row.created_at)
  };
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
