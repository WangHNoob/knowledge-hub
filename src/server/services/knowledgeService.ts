import {
  mapAgentEvent,
  mapComponent,
  mapEvidenceRecord,
  mapMcpAudit,
  mapPackage,
  mapRelease,
  mapReviewTask,
  mapUser
} from "../db/mappers";
import type {
  AgentEvent,
  AssetComponent,
  AssetGroup,
  AssetPackage,
  DatabaseHandle,
  EvidenceCoverage,
  EvidenceRecord,
  McpAuditRecord,
  PackageStatus,
  ReleaseRecord,
  ReviewSeverity,
  ReviewStatus,
  ReviewTask,
  SearchHit,
  SearchResult,
  UserRecord
} from "../types";

export function createKnowledgeService(db: DatabaseHandle) {
  return new KnowledgeService(db);
}

export class PackageDeleteConflictError extends Error {
  constructor(
    public readonly packageId: string,
    public readonly releaseIds: string[],
  ) {
    super(`Package ${packageId} is already referenced by release ${releaseIds.join(", ")}.`);
  }
}

export class KnowledgeService {
  private readonly adapter;
  constructor(private readonly db: DatabaseHandle) {
    this.adapter = db.adapter;
  }

  async getUserByUsername(username: string): Promise<UserRecord | null> {
    const { rows } = await this.adapter.query("SELECT * FROM users WHERE username = $1", [username]);
    return rows.length ? mapUser(rows[0]) : null;
  }

  async getDashboardSummary() {
    const sourceSummary = await this.getSourceBundleSummary();
    const packages = await this.listPackages();
    const components = await this.listComponents();
    const tasks = await this.listReviewTasks({});
    const releases = await this.listReleases();
    const agentEvents = await this.listAgentEvents();

    return {
      sources: sourceSummary,
      packages: {
        total: packages.length,
        byStatus: countBy(packages, (p) => p.status)
      },
      components: {
        total: components.length,
        byGroup: countBy(components, (c) => c.group)
      },
      review: {
        open: tasks.filter((task) => task.status === "open").length,
        blocking: tasks.filter((task) => task.status === "open" && task.severity === "blocking").length,
        warning: tasks.filter((task) => task.status === "open" && task.severity === "warning").length
      },
      release: {
        current: releases.find((release) => release.status === "published") ?? null,
        total: releases.length
      },
      agent: {
        recentQueries: agentEvents.length,
        misses: agentEvents.filter((event) => event.status === "miss").length,
        lowQualityHits: agentEvents.filter((event) => event.qualityFlags.length > 0).length
      },
      evidence: {
        ...(await this.getEvidenceCoverage())
      }
    };
  }

  async getSourceBundleSummary() {
    const { rows: [bundlesRow] } = await this.adapter.query("SELECT COUNT(*)::int AS c FROM source_bundles");
    const { rows: [versionsRow] } = await this.adapter.query("SELECT COUNT(*)::int AS c FROM source_bundle_versions");
    const { rows: [blobsRow] } = await this.adapter.query("SELECT COUNT(*)::int AS c, COALESCE(SUM(byte_size), 0)::bigint AS bytes FROM source_blobs");
    const { rows: latestRows } = await this.adapter.query(
      "SELECT version_id, label, created_at, file_count FROM source_bundle_versions ORDER BY created_at DESC LIMIT 1"
    );
    const latest = latestRows[0] ?? null;
    return {
      bundles: bundlesRow.c,
      versions: versionsRow.c,
      blobs: blobsRow.c,
      totalBytes: Number(blobsRow.bytes),
      latest: latest
        ? {
            versionId: latest.version_id,
            label: latest.label,
            createdAt: latest.created_at,
            fileCount: latest.file_count
          }
        : null
    };
  }

  async listPackages(filter: { q?: string; status?: PackageStatus; kind?: string } = {}): Promise<AssetPackage[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.q) {
      where.push(`(name ILIKE $${params.length + 1} OR description ILIKE $${params.length + 1})`);
      params.push(`%${filter.q}%`);
    }
    if (filter.status) { where.push(`status = $${params.length + 1}`); params.push(filter.status); }
    if (filter.kind) { where.push(`kind = $${params.length + 1}`); params.push(filter.kind); }
    const sql = `SELECT * FROM asset_packages${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC`;
    const { rows } = await this.adapter.query(sql, params);
    return rows.map(mapPackage);
  }

  /**
   * Cross-entity keyword search returning navigation-ready hits (each carries the IDs
   * the UI needs to jump to the right page). Read model only — no filesystem access.
   */
  async search(q: string, limit = 20): Promise<SearchResult> {
    const like = `%${q}%`;
    const hits: SearchHit[] = [];

    const packages = await this.adapter.query(
      "SELECT package_id, name, status FROM asset_packages WHERE name ILIKE $1 OR description ILIKE $1 ORDER BY created_at DESC LIMIT $2",
      [like, limit]
    );
    for (const row of packages.rows) {
      hits.push({ kind: "package", id: String(row.package_id), title: String(row.name), subtitle: `资产包 · ${row.status}` });
    }

    const components = await this.adapter.query(
      "SELECT component_id, package_id, title, group_name FROM asset_components WHERE title ILIKE $1 OR artifact_id ILIKE $1 ORDER BY title LIMIT $2",
      [like, limit]
    );
    for (const row of components.rows) {
      hits.push({
        kind: "component",
        id: String(row.component_id),
        title: String(row.title),
        subtitle: `组件 · ${row.group_name}`,
        packageId: String(row.package_id)
      });
    }

    const versions = await this.adapter.query(
      "SELECT version_id, label, bundle_id FROM source_bundle_versions WHERE label ILIKE $1 OR note ILIKE $1 ORDER BY created_at DESC LIMIT $2",
      [like, limit]
    );
    for (const row of versions.rows) {
      hits.push({ kind: "source_version", id: String(row.version_id), title: String(row.label), subtitle: `资料版本 · ${row.bundle_id}` });
    }

    const releases = await this.adapter.query(
      "SELECT release_id, version, status FROM releases WHERE version ILIKE $1 OR release_id ILIKE $1 ORDER BY created_at DESC LIMIT $2",
      [like, limit]
    );
    for (const row of releases.rows) {
      hits.push({ kind: "release", id: String(row.release_id), title: String(row.version), subtitle: `发布版本 · ${row.status}` });
    }

    return { query: q, hits };
  }

  async getPackageDetail(packageId: string) {    const { rows } = await this.adapter.query("SELECT * FROM asset_packages WHERE package_id = $1", [packageId]);
    if (rows.length === 0) throw new Error(`Unknown package: ${packageId}`);
    return {
      package: mapPackage(rows[0]),
      components: await this.listComponents({ packageId }),
      reviewTasks: await this.listReviewTasks({ packageId }),
      evidenceRecords: await this.listEvidenceRecords({ packageId }),
      evidenceCoverage: await this.getEvidenceCoverage({ packageId })
    };
  }

  async deletePackage(packageId: string): Promise<boolean> {
    const { rows } = await this.adapter.query("SELECT package_id FROM asset_packages WHERE package_id = $1", [packageId]);
    if (rows.length === 0) return false;

    const releases = await this.listReleases();
    const referencingReleaseIds = releases
      .filter((release) => release.packageIds.includes(packageId))
      .map((release) => release.releaseId);
    if (referencingReleaseIds.length > 0) {
      throw new PackageDeleteConflictError(packageId, referencingReleaseIds);
    }

    await this.adapter.query("DELETE FROM asset_packages WHERE package_id = $1", [packageId]);
    return true;
  }

  async listComponents(filter: { packageId?: string; group?: AssetGroup } = {}): Promise<AssetComponent[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.packageId) { where.push(`package_id = $${params.length + 1}`); params.push(filter.packageId); }
    if (filter.group) { where.push(`group_name = $${params.length + 1}`); params.push(filter.group); }
    const sql = `SELECT * FROM asset_components${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY group_name, title`;
    const { rows } = await this.adapter.query(sql, params);
    return rows.map(mapComponent);
  }

  /** Resolves which package owns a component — used for component → Assets navigation. */
  async findComponentOwner(componentId: string): Promise<string | null> {
    const { rows } = await this.adapter.query(
      "SELECT package_id FROM asset_components WHERE component_id = $1",
      [componentId]
    );
    return rows.length ? String(rows[0].package_id) : null;
  }

  async listReviewTasks(filter: { severity?: ReviewSeverity; packageId?: string; status?: ReviewStatus } = {}): Promise<ReviewTask[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.severity) { where.push(`severity = $${params.length + 1}`); params.push(filter.severity); }
    if (filter.packageId) { where.push(`package_id = $${params.length + 1}`); params.push(filter.packageId); }
    if (filter.status) { where.push(`status = $${params.length + 1}`); params.push(filter.status); }
    const sql = `SELECT * FROM review_tasks${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY CASE severity WHEN 'blocking' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at`;
    const { rows } = await this.adapter.query(sql, params);
    return rows.map(mapReviewTask);
  }

  /**
   * Transitions review tasks to a new status (resolve / dismiss / reopen). Records the
   * actor + timestamp + note for resolved/dismissed; reopening clears those fields.
   * Returns the updated tasks. Unknown task ids are silently skipped.
   */
  async transitionReviewTasks(
    taskIds: string[],
    status: ReviewStatus,
    actor: string,
    note = ""
  ): Promise<ReviewTask[]> {
    if (taskIds.length === 0) return [];
    const reopening = status === "open";
    const resolvedBy = reopening ? "" : actor;
    const resolvedAt = reopening ? null : new Date().toISOString();
    const resolutionNote = reopening ? "" : note;
    const placeholders = taskIds.map((_, index) => `$${index + 5}`).join(", ");
    const { rows } = await this.adapter.query(
      `UPDATE review_tasks
         SET status = $1, resolved_by = $2, resolved_at = $3, resolution_note = $4
       WHERE task_id IN (${placeholders})
       RETURNING *`,
      [status, resolvedBy, resolvedAt, resolutionNote, ...taskIds]
    );
    return rows.map(mapReviewTask);
  }

  async listEvidenceRecords(filter: { packageId?: string; componentId?: string } = {}): Promise<EvidenceRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.packageId) { where.push(`package_id = $${params.length + 1}`); params.push(filter.packageId); }
    if (filter.componentId) { where.push(`component_id = $${params.length + 1}`); params.push(filter.componentId); }
    const sql = `SELECT * FROM evidence_records${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, evidence_id`;
    const { rows } = await this.adapter.query(sql, params);
    return rows.map(mapEvidenceRecord);
  }

  async getEvidenceCoverage(filter: { packageId?: string } = {}): Promise<EvidenceCoverage> {
    const components = (await this.listComponents({ packageId: filter.packageId }))
      .filter((component) => EVIDENCE_COVERAGE_COMPONENT_KINDS.has(component.kind));
    const componentIds = new Set(components.map((c) => c.componentId));
    const records = await this.listEvidenceRecords({ packageId: filter.packageId });
    const coveredIds = new Set(records.map((r) => r.componentId).filter((id) => componentIds.has(id)));
    const totalComponents = components.length;
    const coveredComponents = coveredIds.size;
    return {
      totalComponents,
      coveredComponents,
      missingComponents: Math.max(totalComponents - coveredComponents, 0),
      evidenceRecords: records.length,
      coverageRate: totalComponents === 0 ? 0 : coveredComponents / totalComponents
    };
  }

  async listReleases(): Promise<ReleaseRecord[]> {
    const { rows } = await this.adapter.query("SELECT * FROM releases ORDER BY published_at DESC NULLS LAST");
    return rows.map(mapRelease);
  }

  async listAgentEvents(): Promise<AgentEvent[]> {
    const { rows } = await this.adapter.query("SELECT * FROM agent_events ORDER BY created_at DESC LIMIT 50");
    const events = rows.map(mapAgentEvent);
    const componentIds = uniqueSorted(events.flatMap((event) => event.hitComponentIds));
    if (componentIds.length === 0) return events;
    const placeholders = componentIds.map((_, index) => `$${index + 1}`).join(",");
    const { rows: componentRows } = await this.adapter.query(
      `SELECT c.component_id, c.package_id, c.title, c.kind, c.artifact_id, c.quality, COUNT(e.evidence_id)::int AS evidence_records
       FROM asset_components c
       LEFT JOIN evidence_records e ON e.component_id = c.component_id
       WHERE c.component_id IN (${placeholders})
       GROUP BY c.component_id
       ORDER BY c.kind, c.title`,
      componentIds,
    );
    const byId = new Map(componentRows.map((row) => {
      const quality = jsonObject(row.quality);
      return [String(row.component_id), {
        componentId: String(row.component_id),
        packageId: String(row.package_id),
        title: String(row.title),
        kind: String(row.kind),
        artifactId: String(row.artifact_id),
        quality,
        confidence: numberFromQuality(quality, ["confidence", "score", "overallScore"]),
        evidenceRecords: Number(row.evidence_records ?? 0),
      }] as const;
    }));
    return events.map((event) => ({
      ...event,
      components: event.hitComponentIds.map((componentId) => byId.get(componentId)).filter((component): component is NonNullable<typeof component> => Boolean(component)),
    }));
  }

  async listMcpAudit(): Promise<McpAuditRecord[]> {
    const { rows } = await this.adapter.query("SELECT * FROM mcp_audit ORDER BY created_at DESC LIMIT 100");
    return rows.map(mapMcpAudit);
  }
}

function countBy<T, K extends string>(items: T[], key: (item: T) => K): Record<K, number> {
  return items.reduce<Record<K, number>>((acc, item) => {
    const value = key(item);
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {} as Record<K, number>);
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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

const EVIDENCE_COVERAGE_COMPONENT_KINDS = new Set(["wiki_page"]);
