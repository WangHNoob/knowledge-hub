import { createHash } from "node:crypto";

import { nanoid } from "nanoid";

import type { AssetComponent, AssetPackage, DatabaseHandle, ReleaseRecord } from "../types";

export interface CreateReleaseDraftInput {
  version: string;
  packageIds: string[];
  requestedBy: string;
}

export function createReleaseService(db: DatabaseHandle) {
  return new ReleaseService(db);
}

export class ReleaseService {
  private readonly adapter;

  constructor(private readonly db: DatabaseHandle) {
    this.adapter = db.adapter;
  }

  async createDraft(input: CreateReleaseDraftInput): Promise<ReleaseRecord> {
    const packageIds = uniqueSorted(input.packageIds);
    if (packageIds.length === 0) throw new Error("Release must include at least one package.");

    const packages = await this.loadPackages(packageIds);
    if (packages.length !== packageIds.length) {
      const found = new Set(packages.map((pkg) => pkg.packageId));
      const missing = packageIds.filter((id) => !found.has(id));
      throw new Error(`Unknown package(s): ${missing.join(", ")}`);
    }

    const releaseId = `rel_${compactDate(new Date())}_${nanoid(6)}`;
    const qualityGate = summarizePackages(packages);
    const createdAt = new Date().toISOString();

    await this.adapter.query(
      `INSERT INTO releases
        (release_id, version, status, package_ids, manifest_hash, manifest_json, created_by, created_at, published_by, published_at, quality_gate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        releaseId,
        input.version,
        "draft",
        JSON.stringify(packageIds),
        "",
        JSON.stringify({}),
        input.requestedBy,
        createdAt,
        "",
        null,
        JSON.stringify(qualityGate),
      ],
    );

    const release = await this.getRelease(releaseId);
    if (!release) throw new Error("Failed to create release draft.");
    return release;
  }

  async publish(releaseId: string, publishedBy: string): Promise<ReleaseRecord> {
    const release = await this.getRelease(releaseId);
    if (!release) throw new Error(`Unknown release: ${releaseId}`);
    if (release.status === "published") throw new Error(`Release ${releaseId} is already published.`);

    const blockers = await this.findOpenBlockingTasks(release.packageIds);
    if (blockers.length > 0) {
      throw new Error(`Cannot publish release with open blocking tasks: ${blockers.map((task) => task.task_id).join(", ")}`);
    }

    const packages = await this.loadPackages(release.packageIds);
    const components = await this.loadComponents(release.packageIds);
    const qualityGate = summarizePackages(packages, components);
    const publishedAt = new Date().toISOString();
    const manifest = buildManifest({
      release,
      packages,
      components,
      qualityGate,
      publishedAt,
      publishedBy,
    });
    const manifestHash = hashManifest(manifest);

    await this.adapter.query("BEGIN");
    try {
      await this.adapter.query(
        `UPDATE releases
         SET status = $2,
             manifest_hash = $3,
             manifest_json = $4,
             quality_gate = $5,
             published_by = $6,
             published_at = $7
         WHERE release_id = $1 AND status = 'draft'`,
        [
          releaseId,
          "published",
          manifestHash,
          JSON.stringify(manifest),
          JSON.stringify(qualityGate),
          publishedBy,
          publishedAt,
        ],
      );
      await this.pointChannelToRelease(releaseId, publishedBy);
      await this.adapter.query("COMMIT");
    } catch (error) {
      await this.adapter.query("ROLLBACK");
      throw error;
    }

    const published = await this.getRelease(releaseId);
    if (!published) throw new Error(`Unknown release after publish: ${releaseId}`);
    return published;
  }

  async rollback(releaseId: string, requestedBy: string): Promise<ReleaseRecord> {
    const release = await this.getRelease(releaseId);
    if (!release) throw new Error(`Unknown release: ${releaseId}`);
    if (release.status !== "published") throw new Error("Can only rollback to a published release.");
    await this.pointChannelToRelease(releaseId, requestedBy);
    return release;
  }

  async getCurrent(): Promise<ReleaseRecord | null> {
    const { rows } = await this.adapter.query(
      `SELECT r.*
       FROM release_channels c
       JOIN releases r ON r.release_id = c.current_release_id
       WHERE c.channel_id = $1`,
      ["default"],
    );
    return rows.length ? mapRelease(rows[0]) : null;
  }

  async getRelease(releaseId: string): Promise<ReleaseRecord | null> {
    const { rows } = await this.adapter.query("SELECT * FROM releases WHERE release_id = $1", [releaseId]);
    return rows.length ? mapRelease(rows[0]) : null;
  }

  private async pointChannelToRelease(releaseId: string, requestedBy: string): Promise<void> {
    await this.adapter.query(
      `INSERT INTO release_channels (channel_id, current_release_id, updated_by, updated_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (channel_id)
       DO UPDATE SET current_release_id = EXCLUDED.current_release_id,
                     updated_by = EXCLUDED.updated_by,
                     updated_at = EXCLUDED.updated_at`,
      ["default", releaseId, requestedBy, new Date().toISOString()],
    );
  }

  private async findOpenBlockingTasks(packageIds: string[]): Promise<Record<string, unknown>[]> {
    if (packageIds.length === 0) return [];
    const placeholders = packageIds.map((_, index) => `$${index + 1}`).join(",");
    const { rows } = await this.adapter.query(
      `SELECT task_id, package_id, component_id, title
       FROM review_tasks
       WHERE package_id IN (${placeholders}) AND severity = 'blocking' AND status = 'open'
       ORDER BY created_at, task_id`,
      packageIds,
    );
    return rows;
  }

  private async loadPackages(packageIds: string[]): Promise<AssetPackage[]> {
    if (packageIds.length === 0) return [];
    const placeholders = packageIds.map((_, index) => `$${index + 1}`).join(",");
    const { rows } = await this.adapter.query(
      `SELECT *
       FROM asset_packages
       WHERE package_id IN (${placeholders})
       ORDER BY package_id`,
      packageIds,
    );
    return rows.map(mapPackage);
  }

  private async loadComponents(packageIds: string[]): Promise<AssetComponent[]> {
    if (packageIds.length === 0) return [];
    const placeholders = packageIds.map((_, index) => `$${index + 1}`).join(",");
    const { rows } = await this.adapter.query(
      `SELECT *
       FROM asset_components
       WHERE package_id IN (${placeholders})
       ORDER BY package_id, group_name, component_id`,
      packageIds,
    );
    return rows.map(mapComponent);
  }
}

function buildManifest(input: {
  release: ReleaseRecord;
  packages: AssetPackage[];
  components: AssetComponent[];
  qualityGate: Record<string, unknown>;
  publishedAt: string;
  publishedBy: string;
}) {
  const componentIds = input.components.map((component) => component.componentId).sort();
  const sourceVersionIds = uniqueSorted(input.packages.flatMap((pkg) => pkg.sourceVersionIds));
  return {
    releaseId: input.release.releaseId,
    version: input.release.version,
    packageIds: input.packages.map((pkg) => pkg.packageId).sort(),
    componentIds,
    sourceVersionIds,
    packages: input.packages.map((pkg) => ({
      packageId: pkg.packageId,
      name: pkg.name,
      kind: pkg.kind,
      status: pkg.status,
      sourceVersionIds: pkg.sourceVersionIds,
      qualitySummary: pkg.qualitySummary,
    })),
    components: input.components.map((component) => ({
      componentId: component.componentId,
      packageId: component.packageId,
      artifactId: component.artifactId,
      group: component.group,
      kind: component.kind,
      title: component.title,
      storageUri: component.storageUri,
      sourceRefs: component.sourceRefs,
      quality: component.quality,
    })),
    qualityGate: input.qualityGate,
    publishedAt: input.publishedAt,
    publishedBy: input.publishedBy,
  };
}

function summarizePackages(packages: AssetPackage[], components: AssetComponent[] = []): Record<string, unknown> {
  const scores = packages
    .map((pkg) => numberFromQuality(pkg.qualitySummary, ["overallScore", "score", "confidence"]))
    .filter((score): score is number => Number.isFinite(score));
  const componentScores = components
    .map((component) => numberFromQuality(component.quality, ["confidence", "score", "overallScore"]))
    .filter((score): score is number => Number.isFinite(score));
  const allScores = [...scores, ...componentScores];
  const blockingCount = packages.reduce((sum, pkg) => sum + Number(pkg.qualitySummary.blockingCount ?? 0), 0);
  const warningCount = packages.reduce((sum, pkg) => sum + Number(pkg.qualitySummary.warningCount ?? 0), 0);

  return {
    packageCount: packages.length,
    componentCount: components.length,
    sourceVersionIds: uniqueSorted(packages.flatMap((pkg) => pkg.sourceVersionIds)),
    averageScore: allScores.length === 0 ? null : round2(allScores.reduce((sum, score) => sum + score, 0) / allScores.length),
    blockingCount,
    warningCount,
  };
}

function hashManifest(manifest: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(stableStringify(manifest)).digest("hex")}`;
}

function mapRelease(row: Record<string, unknown>): ReleaseRecord {
  return {
    releaseId: row.release_id as string,
    version: row.version as string,
    status: row.status as ReleaseRecord["status"],
    packageIds: jsonArray(row.package_ids),
    publishedAt: row.published_at ? String(row.published_at) : null,
    publishedBy: String(row.published_by ?? ""),
    createdBy: String(row.created_by ?? ""),
    createdAt: String(row.created_at ?? ""),
    manifestHash: String(row.manifest_hash ?? ""),
    manifest: jsonObject(row.manifest_json),
    qualityGate: jsonObject(row.quality_gate),
  };
}

function mapPackage(row: Record<string, unknown>): AssetPackage {
  return {
    packageId: row.package_id as string,
    name: row.name as string,
    kind: row.kind as string,
    status: row.status as AssetPackage["status"],
    description: row.description as string,
    createdByRunId: row.created_by_run_id as string,
    sourceVersionIds: jsonArray(row.source_version_ids),
    legacyPaths: jsonArray(row.legacy_paths),
    qualitySummary: jsonObject(row.quality_summary),
    createdAt: String(row.created_at),
  };
}

function mapComponent(row: Record<string, unknown>): AssetComponent {
  return {
    componentId: row.component_id as string,
    packageId: row.package_id as string,
    artifactId: row.artifact_id as string,
    group: row.group_name as AssetComponent["group"],
    kind: row.kind as string,
    title: row.title as string,
    status: row.status as string,
    legacyPath: String(row.legacy_path ?? ""),
    storageUri: String(row.storage_uri ?? ""),
    sourceRefs: jsonArray(row.source_refs),
    quality: jsonObject(row.quality),
  };
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

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string" && value.length > 0) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}

function numberFromQuality(quality: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = quality[key];
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function compactDate(date: Date): string {
  return date.toISOString().replace(/\D/gu, "").slice(0, 14);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
