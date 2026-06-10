import type {
  AgentEvent,
  AssetComponent,
  AssetGroup,
  AssetPackage,
  DatabaseHandle,
  ReleaseRecord,
  ReviewSeverity,
  ReviewTask,
  SourceRecord,
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
    const sources = this.listSources();
    const packages = this.listPackages();
    const components = this.listComponents();
    const tasks = this.listReviewTasks({});
    const releases = this.listReleases();
    const agentEvents = this.listAgentEvents();

    return {
      sources: {
        total: sources.length,
        active: sources.filter((s) => s.status === "active").length
      },
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
      }
    };
  }

  listSources(): SourceRecord[] {
    return this.db.sqlite.prepare("SELECT * FROM sources ORDER BY title").all().map((row) => mapSource(row as unknown as SourceRow));
  }

  listPackages(): AssetPackage[] {
    return this.db.sqlite
      .prepare("SELECT * FROM asset_packages ORDER BY created_at DESC")
      .all()
      .map((row) => mapPackage(row as unknown as PackageRow));
  }

  getPackageDetail(packageId: string): { package: AssetPackage; components: AssetComponent[]; reviewTasks: ReviewTask[] } {
    const row = this.db.sqlite.prepare("SELECT * FROM asset_packages WHERE package_id = ?").get(packageId);
    if (!row) throw new Error(`Unknown package: ${packageId}`);
    return {
      package: mapPackage(row as unknown as PackageRow),
      components: this.listComponents({ packageId }),
      reviewTasks: this.listReviewTasks({ packageId })
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
