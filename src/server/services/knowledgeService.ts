import type {
  AgentEvent,
  AssetComponent,
  AssetGroup,
  AssetPackage,
  DatabaseHandle,
  EvidenceCoverage,
  EvidenceRecord,
  ReleaseRecord,
  ReviewSeverity,
  ReviewTask,
  UserRecord
} from "../types";

export function createKnowledgeService(db: DatabaseHandle) {
  return new KnowledgeService(db);
}

export class KnowledgeService {
  private readonly pool;
  constructor(private readonly db: DatabaseHandle) {
    this.pool = db.pool;
  }

  async getUserByUsername(username: string): Promise<UserRecord | null> {
    const { rows } = await this.pool.query("SELECT * FROM users WHERE username = $1", [username]);
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
    const { rows: [bundlesRow] } = await this.pool.query("SELECT COUNT(*)::int AS c FROM source_bundles");
    const { rows: [versionsRow] } = await this.pool.query("SELECT COUNT(*)::int AS c FROM source_bundle_versions");
    const { rows: [blobsRow] } = await this.pool.query("SELECT COUNT(*)::int AS c, COALESCE(SUM(byte_size), 0)::bigint AS bytes FROM source_blobs");
    const { rows: latestRows } = await this.pool.query(
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

  async listPackages(): Promise<AssetPackage[]> {
    const { rows } = await this.pool.query("SELECT * FROM asset_packages ORDER BY created_at DESC");
    return rows.map(mapPackage);
  }

  async getPackageDetail(packageId: string) {
    const { rows } = await this.pool.query("SELECT * FROM asset_packages WHERE package_id = $1", [packageId]);
    if (rows.length === 0) throw new Error(`Unknown package: ${packageId}`);
    return {
      package: mapPackage(rows[0]),
      components: await this.listComponents({ packageId }),
      reviewTasks: await this.listReviewTasks({ packageId }),
      evidenceRecords: await this.listEvidenceRecords({ packageId }),
      evidenceCoverage: await this.getEvidenceCoverage({ packageId })
    };
  }

  async listComponents(filter: { packageId?: string; group?: AssetGroup } = {}): Promise<AssetComponent[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.packageId) { where.push(`package_id = $${params.length + 1}`); params.push(filter.packageId); }
    if (filter.group) { where.push(`group_name = $${params.length + 1}`); params.push(filter.group); }
    const sql = `SELECT * FROM asset_components${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY group_name, title`;
    const { rows } = await this.pool.query(sql, params);
    return rows.map(mapComponent);
  }

  async listReviewTasks(filter: { severity?: ReviewSeverity; packageId?: string } = {}): Promise<ReviewTask[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.severity) { where.push(`severity = $${params.length + 1}`); params.push(filter.severity); }
    if (filter.packageId) { where.push(`package_id = $${params.length + 1}`); params.push(filter.packageId); }
    const sql = `SELECT * FROM review_tasks${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY CASE severity WHEN 'blocking' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at`;
    const { rows } = await this.pool.query(sql, params);
    return rows.map(mapReviewTask);
  }

  async listEvidenceRecords(filter: { packageId?: string; componentId?: string } = {}): Promise<EvidenceRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.packageId) { where.push(`package_id = $${params.length + 1}`); params.push(filter.packageId); }
    if (filter.componentId) { where.push(`component_id = $${params.length + 1}`); params.push(filter.componentId); }
    const sql = `SELECT * FROM evidence_records${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, evidence_id`;
    const { rows } = await this.pool.query(sql, params);
    return rows.map(mapEvidenceRecord);
  }

  async getEvidenceCoverage(filter: { packageId?: string } = {}): Promise<EvidenceCoverage> {
    const components = await this.listComponents({ packageId: filter.packageId });
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
    const { rows } = await this.pool.query("SELECT * FROM releases ORDER BY published_at DESC NULLS LAST");
    return rows.map(mapRelease);
  }

  async listAgentEvents(): Promise<AgentEvent[]> {
    const { rows } = await this.pool.query("SELECT * FROM agent_events ORDER BY created_at DESC LIMIT 50");
    return rows.map(mapAgentEvent);
  }
}

function countBy<T, K extends string>(items: T[], key: (item: T) => K): Record<K, number> {
  return items.reduce<Record<K, number>>((acc, item) => {
    const value = key(item);
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {} as Record<K, number>);
}

function mapUser(row: Record<string, unknown>): UserRecord {
  return {
    id: row.id as string,
    username: row.username as string,
    passwordHash: row.password_hash as string,
    role: row.role as UserRecord["role"],
    displayName: row.display_name as string
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
    sourceVersionIds: row.source_version_ids as string[] ?? [],
    legacyPaths: row.legacy_paths as string[] ?? [],
    qualitySummary: row.quality_summary as Record<string, unknown> ?? {},
    createdAt: String(row.created_at)
  };
}

function mapComponent(row: Record<string, unknown>): AssetComponent {
  return {
    componentId: row.component_id as string,
    packageId: row.package_id as string,
    artifactId: row.artifact_id as string,
    group: row.group_name as AssetGroup,
    kind: row.kind as string,
    title: row.title as string,
    status: row.status as string,
    legacyPath: row.legacy_path as string,
    storageUri: row.storage_uri as string,
    sourceRefs: row.source_refs as string[] ?? [],
    quality: row.quality as Record<string, unknown> ?? {}
  };
}

function mapReviewTask(row: Record<string, unknown>): ReviewTask {
  return {
    taskId: row.task_id as string,
    packageId: row.package_id as string,
    componentId: row.component_id as string,
    severity: row.severity as ReviewTask["severity"],
    status: row.status as ReviewTask["status"],
    title: row.title as string,
    description: row.description as string,
    suggestedAction: row.suggested_action as string,
    createdAt: String(row.created_at)
  };
}

function mapEvidenceRecord(row: Record<string, unknown>): EvidenceRecord {
  return {
    evidenceId: row.evidence_id as string,
    packageId: row.package_id as string,
    componentId: row.component_id as string,
    sourceVersionId: row.source_version_id as string,
    quote: row.quote as string,
    note: row.note as string,
    confidence: row.confidence as number,
    createdAt: String(row.created_at)
  };
}

function mapRelease(row: Record<string, unknown>): ReleaseRecord {
  return {
    releaseId: row.release_id as string,
    version: row.version as string,
    status: row.status as ReleaseRecord["status"],
    packageIds: row.package_ids as string[] ?? [],
    publishedAt: row.published_at ? String(row.published_at) : null,
    qualityGate: row.quality_gate as Record<string, unknown> ?? {}
  };
}

function mapAgentEvent(row: Record<string, unknown>): AgentEvent {
  return {
    eventId: row.event_id as string,
    releaseId: row.release_id as string,
    query: row.query as string,
    hitComponentIds: row.hit_component_ids as string[] ?? [],
    qualityFlags: row.quality_flags as string[] ?? [],
    status: row.status as AgentEvent["status"],
    createdAt: String(row.created_at)
  };
}
