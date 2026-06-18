import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve } from "node:path";

import type { DiagnosticLogger } from "./diagnosticService";
import type {
  DatabaseHandle,
  ReclaimRequest,
  ReclaimResult,
  StorageCategory,
  StorageCategorySummary,
  StorageEntry,
  StorageOverview,
  StorageScanReport
} from "../types";

export interface StorageMaintenanceOptions {
  webImportRetentionHours?: number;
  logRetentionDays?: number;
}

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;
const RELEASE_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;
const LOG_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.jsonl$/u;

export function createStorageMaintenanceService(
  db: DatabaseHandle,
  dataDir: string,
  diagnostics?: DiagnosticLogger,
  options: StorageMaintenanceOptions = {}
): StorageMaintenanceService {
  return new StorageMaintenanceService(db, dataDir, diagnostics, options);
}

interface CategoryScan {
  summary: StorageCategorySummary;
  entries: StorageEntry[];
}

/**
 * Read-only scanning + explicit, category-scoped reclaim of the on-disk storage
 * under `dataDir`. Never auto-deletes on a timer; the only thing reclaimed is what
 * a fresh scan classifies as a non-DB-referenced orphan. Filesystem writes live in
 * this dedicated service (not KnowledgeService), per the project's layering rule.
 */
export class StorageMaintenanceService {
  private readonly adapter;
  private readonly webImportRetentionHours: number;
  private readonly logRetentionDays: number;

  constructor(
    private readonly db: DatabaseHandle,
    private readonly dataDir: string,
    private readonly diagnostics?: DiagnosticLogger,
    options: StorageMaintenanceOptions = {}
  ) {
    this.adapter = db.adapter;
    this.webImportRetentionHours = options.webImportRetentionHours ?? 24;
    this.logRetentionDays = options.logRetentionDays ?? 14;
  }

  /** Full per-entry scan with liveness classification. */
  async scan(): Promise<StorageScanReport> {
    const scans = [
      await this.scanBlobs(),
      await this.scanKbBuildRuns(),
      await this.scanWebImports(),
      await this.scanReleases(),
      this.scanLogs()
    ];
    const categories = scans.map((s) => s.summary);
    const entries = scans.flatMap((s) => s.entries);
    return {
      categories,
      entries,
      totalBytes: categories.reduce((sum, c) => sum + c.totalBytes, 0),
      reclaimableBytes: categories.reduce((sum, c) => sum + c.reclaimableBytes, 0),
      scannedAt: new Date().toISOString()
    };
  }

  /** Per-category aggregates only (no per-entry list) for the overview page. */
  async overview(): Promise<StorageOverview> {
    const report = await this.scan();
    return {
      categories: report.categories,
      totalBytes: report.totalBytes,
      reclaimableBytes: report.reclaimableBytes,
      scannedAt: report.scannedAt
    };
  }

  /**
   * Deletes reclaimable entries in the requested categories. Re-scans internally so it
   * never trusts a client-supplied path list (avoids TOCTOU + path injection), and
   * re-validates path containment before every delete.
   */
  async reclaim(input: ReclaimRequest, actor: string): Promise<ReclaimResult> {
    const requested = new Set(input.categories);
    const report = await this.scan();
    const perCategory: ReclaimResult["perCategory"] = {};
    let deletedEntries = 0;
    let reclaimedBytes = 0;

    for (const entry of report.entries) {
      if (entry.status !== "reclaimable" || !requested.has(entry.category)) continue;
      const root = this.categoryRoot(entry.category);
      const absolutePath = join(root, entry.key);
      if (!isContained(root, absolutePath)) continue; // defense-in-depth

      rmSync(absolutePath, { recursive: true, force: true });
      deletedEntries += 1;
      reclaimedBytes += entry.bytes;
      const bucket = perCategory[entry.category] ?? { count: 0, bytes: 0 };
      bucket.count += 1;
      bucket.bytes += entry.bytes;
      perCategory[entry.category] = bucket;

      await this.diagnostics?.event({
        category: "system",
        level: "warn",
        message: "storage reclaim: deleted entry",
        actor,
        entityType: "storage_entry",
        entityId: `${entry.category}/${entry.key}`,
        context: { category: entry.category, bytes: entry.bytes, reason: entry.reason }
      });
    }

    await this.diagnostics?.event({
      category: "system",
      message: "storage reclaim: completed",
      actor,
      entityType: "storage_reclaim",
      context: { categories: input.categories, deletedEntries, reclaimedBytes, perCategory }
    });

    return { deletedEntries, reclaimedBytes, perCategory };
  }

  private categoryRoot(category: StorageCategory): string {
    switch (category) {
      case "blobs": return join(this.dataDir, "storage", "blobs");
      case "kb_build_runs": return join(this.dataDir, "kb-build-runs");
      case "web_imports": return join(this.dataDir, "web-imports");
      case "releases": return join(this.dataDir, "releases");
      case "logs": return join(this.dataDir, "logs");
    }
  }

  // --- blobs: storage/blobs/<2hex>/<sha256hex><ext> ---
  // LIVE if a source_blobs row points to the file. RECLAIMABLE only for filesystem
  // orphans (a file with no DB row — e.g. a crash between writeFileSync and INSERT).
  // DB-orphan blobs (row exists but unreferenced by source_files) are NOT auto-deleted in v1.
  private async scanBlobs(): Promise<CategoryScan> {
    const root = this.categoryRoot("blobs");
    const { rows } = await this.adapter.query("SELECT storage_uri FROM source_blobs");
    const knownAbsolute = new Set(
      rows.map((row) => join(this.dataDir, ...String(row.storage_uri).split(posix.sep)))
    );

    const entries: StorageEntry[] = [];
    const summary = emptySummary("blobs");
    if (existsSync(root)) {
      walkFiles(root, (absolutePath) => {
        const { bytes, mtimeMs } = fileStat(absolutePath);
        accumulate(summary, bytes, 1, mtimeMs);
        if (!knownAbsolute.has(absolutePath)) {
          markReclaimable(summary, bytes);
          entries.push({
            category: "blobs",
            key: relative(root, absolutePath).split(/[\\/]/u).join("/"),
            bytes,
            fileCount: 1,
            oldestMs: mtimeMs,
            newestMs: mtimeMs,
            status: "reclaimable",
            reason: "磁盘上存在但数据库无对应 blob 记录（孤儿文件）"
          });
        }
      });
    }
    return { summary, entries };
  }

  // --- kb-build-runs/<runId>/ — the biggest accumulator ---
  // v1 conservative: reclaimable ONLY when no knowledge_build_runs row exists for the
  // dir (the documented deleteRun leak: row deleted, dir left behind). Anything still
  // referenced by a package, a release, or an in-flight run is kept LIVE.
  private async scanKbBuildRuns(): Promise<CategoryScan> {
    const root = this.categoryRoot("kb_build_runs");
    const runRows = (await this.adapter.query(
      "SELECT run_id, status FROM knowledge_build_runs"
    )).rows;
    const runStatus = new Map<string, string>(runRows.map((r) => [String(r.run_id), String(r.status)]));

    const packageRunIds = new Set(
      (await this.adapter.query(
        "SELECT DISTINCT created_by_run_id FROM asset_packages WHERE created_by_run_id <> ''"
      )).rows.map((r) => String(r.created_by_run_id))
    );
    const releaseRunIds = new Set(
      (await this.adapter.query(
        `SELECT DISTINCT p.created_by_run_id
           FROM releases r
           JOIN asset_packages p
             ON p.package_id = ANY (SELECT jsonb_array_elements_text(r.package_ids))
          WHERE p.created_by_run_id <> ''`
      )).rows.map((r) => String(r.created_by_run_id))
    );

    return this.scanDirs("kb_build_runs", root, (runId) => {
      if (!RUN_ID_PATTERN.test(runId)) {
        return { status: "live", reason: "目录名不是合法 runId，保留待人工检查" };
      }
      if (packageRunIds.has(runId)) return { status: "live", reason: "被存活的资产包引用" };
      if (releaseRunIds.has(runId)) return { status: "live", reason: "被发布版本引用（含回滚目标）" };
      if (runStatus.get(runId) === "running") return { status: "live", reason: "构建进行中" };
      if (runStatus.has(runId)) {
        return { status: "live", reason: "DB 中仍有构建记录，v1 保守保留（待人工清理）" };
      }
      return { status: "reclaimable", reason: "数据库中已无对应构建记录（残留工作区）" };
    });
  }

  // --- web-imports/<unixms>-<rand6>/ — upload staging, never DB-referenced ---
  private async scanWebImports(): Promise<CategoryScan> {
    const root = this.categoryRoot("web_imports");
    const cutoff = Date.now() - this.webImportRetentionHours * 60 * 60 * 1000;
    return this.scanDirs("web_imports", root, (name, absolutePath) => {
      const parsed = Number.parseInt(name.split("-")[0] ?? "", 10);
      const createdMs = Number.isFinite(parsed) ? parsed : dirMtimeMs(absolutePath);
      return createdMs < cutoff
        ? { status: "reclaimable", reason: `上传暂存目录已超过 ${this.webImportRetentionHours} 小时` }
        : { status: "live", reason: "近期上传暂存目录" };
    });
  }

  // --- releases/<releaseId>/ — okf bundle/report; immutable + rollback-able ---
  private async scanReleases(): Promise<CategoryScan> {
    const root = this.categoryRoot("releases");
    const releaseIds = new Set(
      (await this.adapter.query("SELECT release_id FROM releases")).rows.map((r) => String(r.release_id))
    );
    return this.scanDirs("releases", root, (releaseId) => {
      if (!RELEASE_ID_PATTERN.test(releaseId)) {
        return { status: "live", reason: "目录名不是合法 releaseId，保留待人工检查" };
      }
      return releaseIds.has(releaseId)
        ? { status: "live", reason: "对应发布版本仍存在" }
        : { status: "reclaimable", reason: "数据库中已无对应发布版本（失败/中止的发布残留）" };
    });
  }

  // --- logs/YYYY-MM-DD.jsonl — already auto-pruned at startup; manual purge mirrors it ---
  private scanLogs(): CategoryScan {
    const root = this.categoryRoot("logs");
    const summary = emptySummary("logs");
    const entries: StorageEntry[] = [];
    if (!existsSync(root)) return { summary, entries };
    const today = new Date().toISOString().slice(0, 10);
    const cutoff = Date.now() - this.logRetentionDays * 24 * 60 * 60 * 1000;
    for (const file of readdirSync(root)) {
      if (!LOG_FILE_PATTERN.test(file)) continue;
      const absolutePath = join(root, file);
      const { bytes, mtimeMs } = fileStat(absolutePath);
      accumulate(summary, bytes, 1, mtimeMs);
      const day = file.slice(0, 10);
      const dayMs = Date.parse(day);
      const reclaimable = day !== today && Number.isFinite(dayMs) && dayMs < cutoff;
      if (reclaimable) markReclaimable(summary, bytes);
      entries.push({
        category: "logs",
        key: file,
        bytes,
        fileCount: 1,
        oldestMs: mtimeMs,
        newestMs: mtimeMs,
        status: reclaimable ? "reclaimable" : "live",
        reason: reclaimable ? `日志早于保留期（${this.logRetentionDays} 天）` : "在保留期内或为当日日志"
      });
    }
    return { summary, entries };
  }

  /** Shared scanner for "one entry per top-level child directory" categories. */
  private scanDirs(
    category: StorageCategory,
    root: string,
    classify: (name: string, absolutePath: string) => { status: StorageEntry["status"]; reason: string }
  ): CategoryScan {
    const summary = emptySummary(category);
    const entries: StorageEntry[] = [];
    if (!existsSync(root)) return { summary, entries };
    for (const dirent of readdirSync(root, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const absolutePath = join(root, dirent.name);
      const stats = dirStats(absolutePath);
      accumulate(summary, stats.bytes, stats.fileCount, stats.newestMs);
      if (stats.oldestMs !== null && (summary.oldestMs === null || stats.oldestMs < summary.oldestMs)) {
        summary.oldestMs = stats.oldestMs;
      }
      const { status, reason } = classify(dirent.name, absolutePath);
      if (status === "reclaimable") markReclaimable(summary, stats.bytes);
      entries.push({
        category,
        key: dirent.name,
        bytes: stats.bytes,
        fileCount: stats.fileCount,
        oldestMs: stats.oldestMs,
        newestMs: stats.newestMs,
        status,
        reason
      });
    }
    return { summary, entries };
  }
}

function emptySummary(category: StorageCategory): StorageCategorySummary {
  return {
    category,
    totalBytes: 0,
    fileCount: 0,
    entryCount: 0,
    liveBytes: 0,
    reclaimableBytes: 0,
    reclaimableEntries: 0,
    oldestMs: null,
    newestMs: null
  };
}

function accumulate(summary: StorageCategorySummary, bytes: number, fileCount: number, newestMs: number | null): void {
  summary.totalBytes += bytes;
  summary.fileCount += fileCount;
  summary.entryCount += 1;
  summary.liveBytes += bytes; // moved to reclaimable by markReclaimable
  if (newestMs !== null && (summary.newestMs === null || newestMs > summary.newestMs)) {
    summary.newestMs = newestMs;
  }
}

function markReclaimable(summary: StorageCategorySummary, bytes: number): void {
  summary.reclaimableBytes += bytes;
  summary.reclaimableEntries += 1;
  summary.liveBytes -= bytes;
}

interface DirStats { bytes: number; fileCount: number; oldestMs: number | null; newestMs: number | null; }

function dirStats(absPath: string): DirStats {
  const out: DirStats = { bytes: 0, fileCount: 0, oldestMs: null, newestMs: null };
  walkFiles(absPath, (file) => {
    const { bytes, mtimeMs } = fileStat(file);
    out.bytes += bytes;
    out.fileCount += 1;
    if (out.oldestMs === null || mtimeMs < out.oldestMs) out.oldestMs = mtimeMs;
    if (out.newestMs === null || mtimeMs > out.newestMs) out.newestMs = mtimeMs;
  });
  return out;
}

function walkFiles(dir: string, onFile: (absolutePath: string) => void): void {
  if (!existsSync(dir)) return;
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, dirent.name);
    if (dirent.isDirectory()) walkFiles(full, onFile);
    else if (dirent.isFile()) onFile(full);
  }
}

function fileStat(absolutePath: string): { bytes: number; mtimeMs: number } {
  const st = statSync(absolutePath);
  return { bytes: st.size, mtimeMs: st.mtimeMs };
}

function dirMtimeMs(absolutePath: string): number {
  try {
    return statSync(absolutePath).mtimeMs;
  } catch {
    return Date.now();
  }
}

function isContained(root: string, child: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
