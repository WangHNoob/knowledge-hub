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
  constructor(private readonly db: DatabaseHandle) {}

  getUserByUsername(username: string): UserRecord | null {
    const row = this.db.sqlite.prepare("SELECT * FROM users WHERE username = ?").get(username);
    return row ? mapUser(row as unknown as UserRow) : null;
  }

  getDashboardSummary() {
    const sourceSummary = this.getSourceBundleSummary();
    const packages = this.listPackages();
    const components = this.listComponents();
    const tasks = this.listReviewTasks({});
    const releases = this.listReleases();
    const agentEvents = this.listAgentEvents();

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
        ...this.getEvidenceCoverage()
      }
    };
  }

  getSourceBundleSummary() {
    const bundles = this.db.sqlite.prepare("SELECT COUNT(*) AS c FROM source_bundles").get() as { c: number };
    const versions = this.db.sqlite.prepare("SELECT COUNT(*) AS c FROM source_bundle_versions").get() as { c: number };
    const blobs = this.db.sqlite
      .prepare("SELECT COUNT(*) AS c, COALESCE(SUM(byte_size), 0) AS bytes FROM source_blobs")
      .get() as { c: number; bytes: number };
    const latest = this.db.sqlite
      .prepare(
        "SELECT version_id, label, created_at, file_count FROM source_bundle_versions ORDER BY created_at DESC LIMIT 1"
      )
      .get() as { version_id: string; label: string; created_at: string; file_count: number } | undefined;
    return {
      bundles: bundles.c,
      versions: versions.c,
      blobs: blobs.c,
      totalBytes: blobs.bytes,
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

  listPackages(): AssetPackage[] {
    return this.db.sqlite
      .prepare("SELECT * FROM asset_packages ORDER BY created_at DESC")
      .all()
      .map((row) => mapPackage(row as unknown as PackageRow));
  }

  getPackageDetail(packageId: string): {
    package: AssetPackage;
    components: AssetComponent[];
    reviewTasks: ReviewTask[];
    evidenceRecords: EvidenceRecord[];
    evidenceCoverage: EvidenceCoverage;
  } {
    const row = this.db.sqlite.prepare("SELECT * FROM asset_packages WHERE package_id = ?").get(packageId);
    if (!row) throw new Error(`Unknown package: ${packageId}`);
    return {
      package: mapPackage(row as unknown as PackageRow),
      components: this.listComponents({ packageId }),
      reviewTasks: this.listReviewTasks({ packageId }),
      evidenceRecords: this.listEvidenceRecords({ packageId }),
      evidenceCoverage: this.getEvidenceCoverage({ packageId })
    };
  }

  listComponents(filter: { packageId?: string; group?: AssetGroup } = {}): AssetComponent[] {
    let sql = "SELECT * FROM asset_components";
    const where: string[] = [];
    const params: string[] = [];
    if (filter.packageId) {
      where.push("package_id = ?");
      params.push(filter.packageId);
    }
    if (filter.group) {
      where.push("group_name = ?");
      params.push(filter.group);
    }
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY group_name, title";
    return this.db.sqlite.prepare(sql).all(...params).map((row) => mapComponent(row as unknown as ComponentRow));
  }

  listReviewTasks(filter: { severity?: ReviewSeverity; packageId?: string } = {}): ReviewTask[] {
    let sql = "SELECT * FROM review_tasks";
    const where: string[] = [];
    const params: string[] = [];
    if (filter.severity) {
      where.push("severity = ?");
      params.push(filter.severity);
    }
    if (filter.packageId) {
      where.push("package_id = ?");
      params.push(filter.packageId);
    }
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY CASE severity WHEN 'blocking' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at";
    return this.db.sqlite.prepare(sql).all(...params).map((row) => mapReviewTask(row as unknown as ReviewTaskRow));
  }

  listEvidenceRecords(filter: { packageId?: string; componentId?: string } = {}): EvidenceRecord[] {
    let sql = "SELECT * FROM evidence_records";
    const where: string[] = [];
    const params: string[] = [];
    if (filter.packageId) {
      where.push("package_id = ?");
      params.push(filter.packageId);
    }
    if (filter.componentId) {
      where.push("component_id = ?");
      params.push(filter.componentId);
    }
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY created_at DESC, evidence_id";
    return this.db.sqlite.prepare(sql).all(...params).map((row) => mapEvidenceRecord(row as unknown as EvidenceRow));
  }

  getEvidenceCoverage(filter: { packageId?: string } = {}): EvidenceCoverage {
    const components = this.listComponents({ packageId: filter.packageId });
    const componentIds = new Set(components.map((component) => component.componentId));
    const records = this.listEvidenceRecords({ packageId: filter.packageId });
    const coveredIds = new Set(records.map((record) => record.componentId).filter((componentId) => componentIds.has(componentId)));
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

  listReleases(): ReleaseRecord[] {
    return this.db.sqlite.prepare("SELECT * FROM releases ORDER BY published_at DESC").all().map((row) => mapRelease(row as unknown as ReleaseRow));
  }

  listAgentEvents(): AgentEvent[] {
    return this.db.sqlite.prepare("SELECT * FROM agent_events ORDER BY created_at DESC LIMIT 50").all().map((row) => mapAgentEvent(row as unknown as AgentEventRow));
  }
}

function countBy<T, K extends string>(items: T[], key: (item: T) => K): Record<K, number> {
  return items.reduce<Record<K, number>>((acc, item) => {
    const value = key(item);
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {} as Record<K, number>);
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: UserRecord["role"];
  display_name: string;
}

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role,
    displayName: row.display_name
  };
}

interface PackageRow {
  package_id: string;
  name: string;
  kind: string;
  status: AssetPackage["status"];
  description: string;
  created_by_run_id: string;
  source_version_ids: string;
  legacy_paths: string;
  quality_summary: string;
  created_at: string;
}

function mapPackage(row: PackageRow): AssetPackage {
  return {
    packageId: row.package_id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    description: row.description,
    createdByRunId: row.created_by_run_id,
    sourceVersionIds: parseJson<string[]>(row.source_version_ids, []),
    legacyPaths: parseJson<string[]>(row.legacy_paths, []),
    qualitySummary: parseJson<Record<string, unknown>>(row.quality_summary, {}),
    createdAt: row.created_at
  };
}

interface ComponentRow {
  component_id: string;
  package_id: string;
  artifact_id: string;
  group_name: AssetGroup;
  kind: string;
  title: string;
  status: string;
  legacy_path: string;
  storage_uri: string;
  source_refs: string;
  quality: string;
}

function mapComponent(row: ComponentRow): AssetComponent {
  return {
    componentId: row.component_id,
    packageId: row.package_id,
    artifactId: row.artifact_id,
    group: row.group_name,
    kind: row.kind,
    title: row.title,
    status: row.status,
    legacyPath: row.legacy_path,
    storageUri: row.storage_uri,
    sourceRefs: parseJson<string[]>(row.source_refs, []),
    quality: parseJson<Record<string, unknown>>(row.quality, {})
  };
}

interface ReviewTaskRow {
  task_id: string;
  package_id: string;
  component_id: string;
  severity: ReviewTask["severity"];
  status: ReviewTask["status"];
  title: string;
  description: string;
  suggested_action: string;
  created_at: string;
}

function mapReviewTask(row: ReviewTaskRow): ReviewTask {
  return {
    taskId: row.task_id,
    packageId: row.package_id,
    componentId: row.component_id,
    severity: row.severity,
    status: row.status,
    title: row.title,
    description: row.description,
    suggestedAction: row.suggested_action,
    createdAt: row.created_at
  };
}

interface EvidenceRow {
  evidence_id: string;
  package_id: string;
  component_id: string;
  source_version_id: string;
  quote: string;
  note: string;
  confidence: number;
  created_at: string;
}

function mapEvidenceRecord(row: EvidenceRow): EvidenceRecord {
  return {
    evidenceId: row.evidence_id,
    packageId: row.package_id,
    componentId: row.component_id,
    sourceVersionId: row.source_version_id,
    quote: row.quote,
    note: row.note,
    confidence: row.confidence,
    createdAt: row.created_at
  };
}

interface ReleaseRow {
  release_id: string;
  version: string;
  status: ReleaseRecord["status"];
  package_ids: string;
  published_at: string | null;
  quality_gate: string;
}

function mapRelease(row: ReleaseRow): ReleaseRecord {
  return {
    releaseId: row.release_id,
    version: row.version,
    status: row.status,
    packageIds: parseJson<string[]>(row.package_ids, []),
    publishedAt: row.published_at,
    qualityGate: parseJson<Record<string, unknown>>(row.quality_gate, {})
  };
}

interface AgentEventRow {
  event_id: string;
  release_id: string;
  query: string;
  hit_component_ids: string;
  quality_flags: string;
  status: AgentEvent["status"];
  created_at: string;
}

function mapAgentEvent(row: AgentEventRow): AgentEvent {
  return {
    eventId: row.event_id,
    releaseId: row.release_id,
    query: row.query,
    hitComponentIds: parseJson<string[]>(row.hit_component_ids, []),
    qualityFlags: parseJson<string[]>(row.quality_flags, []),
    status: row.status,
    createdAt: row.created_at
  };
}
