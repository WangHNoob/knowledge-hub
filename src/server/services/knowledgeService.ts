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
  AnnotationExample,
  AssetComponent,
  AssetGroup,
  AssetPackage,
  DatabaseHandle,
  EvidenceCoverage,
  EvidenceRecord,
  FlywheelEvent,
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
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { trustFromQuality } from "./trustScore";
import { emitKnowledgeEvent } from "./eventService";

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

  async updatePackage(packageId: string, patch: { name?: string; description?: string }): Promise<AssetPackage | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) { sets.push(`name = $${params.length + 1}`); params.push(patch.name.trim()); }
    if (patch.description !== undefined) { sets.push(`description = $${params.length + 1}`); params.push(patch.description); }
    if (sets.length === 0) return null;
    params.push(packageId);
    const { rows } = await this.adapter.query(
      `UPDATE asset_packages SET ${sets.join(", ")} WHERE package_id = $${params.length} RETURNING *`,
      params
    );
    return rows.length ? mapPackage(rows[0]) : null;
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
    return this.enrichReviewTaskLearning(rows.map(mapReviewTask));
  }

  private async enrichReviewTaskLearning(tasks: ReviewTask[]): Promise<ReviewTask[]> {
    if (tasks.length === 0) return tasks;
    const componentIds = uniqueSorted(tasks.map((task) => task.componentId));
    const packageIds = uniqueSorted(tasks.map((task) => task.packageId));
    const componentPlaceholders = componentIds.map((_, index) => `$${index + 1}`).join(",");
    const packagePlaceholders = packageIds.map((_, index) => `$${index + 1}`).join(",");

    const [taskHistoryRows, exampleRows, runRows] = await Promise.all([
      this.adapter.query(
        `SELECT component_id, rule_id, status
         FROM review_tasks
         WHERE component_id IN (${componentPlaceholders})`,
        componentIds,
      ),
      this.adapter.query(
        `SELECT DISTINCT ON (component_id, rule_id)
           component_id, rule_id, example_id, correct_value, created_by, created_at,
           COUNT(*) OVER (PARTITION BY component_id, rule_id)::int AS example_count
         FROM annotation_examples
         WHERE component_id IN (${componentPlaceholders})
         ORDER BY component_id, rule_id, created_at DESC`,
        componentIds,
      ),
      this.adapter.query(
        `SELECT p.package_id, r.config_json
         FROM asset_packages p
         LEFT JOIN knowledge_build_runs r ON r.run_id = p.created_by_run_id
         WHERE p.package_id IN (${packagePlaceholders})`,
        packageIds,
      ),
    ]);

    const history = new Map<string, { total: number; open: number }>();
    for (const row of taskHistoryRows.rows) {
      const key = reviewLearningKey(String(row.component_id), String(row.rule_id ?? ""));
      const current = history.get(key) ?? { total: 0, open: 0 };
      current.total += 1;
      if (String(row.status) === "open") current.open += 1;
      history.set(key, current);
    }

    const examples = new Map<string, ReviewTask["learning"]["lastAnnotation"] & { count?: number }>();
    for (const row of exampleRows.rows) {
      const annotation = {
        exampleId: String(row.example_id),
        correctValue: jsonObject(row.correct_value),
        createdBy: String(row.created_by ?? ""),
        createdAt: String(row.created_at),
        count: Number(row.example_count ?? 0),
      };
      examples.set(reviewLearningKey(String(row.component_id), String(row.rule_id ?? "")), annotation);
    }

    const injectedByPackage = new Map<string, number>();
    for (const row of runRows.rows) {
      const config = jsonObject(row.config_json);
      const flywheel = jsonObject(config.flywheel);
      injectedByPackage.set(String(row.package_id), Number(flywheel.annotationExamplesInjected ?? 0));
    }

    return tasks.map((task) => {
      const key = reviewLearningKey(task.componentId, task.ruleId);
      const stats = history.get(key) ?? { total: 0, open: 0 };
      const annotation = examples.get(key) ?? null;
      const lastAnnotation = annotation
        ? {
          exampleId: annotation.exampleId,
          correctValue: annotation.correctValue,
          createdBy: annotation.createdBy,
          createdAt: annotation.createdAt,
        }
        : null;
      return {
        ...task,
        learning: {
          recurrenceCount: Math.max(stats.total - 1, 0),
          openSimilarCount: Math.max(stats.open - (task.status === "open" ? 1 : 0), 0),
          exampleCount: annotation?.count ?? 0,
          buildExamplesInjected: injectedByPackage.get(task.packageId) ?? 0,
          lastAnnotation,
        },
      };
    });
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

  async annotateReviewTask(input: {
    taskId: string;
    selectedCandidateId?: string;
    correctValue?: unknown;
    note?: string;
    dismissRule?: boolean;
    dismissalReason?: string;
    actor: string;
  }): Promise<{ task: ReviewTask; example: AnnotationExample | null }> {
    const task = (await this.listReviewTasks({})).find((item) => item.taskId === input.taskId);
    if (!task) throw new Error(`Unknown review task: ${input.taskId}`);
    const selected = input.selectedCandidateId
      ? task.candidates.find((candidate) => candidate.id === input.selectedCandidateId)
      : null;
    const correctValue = normalizeAnnotationValue(input.correctValue ?? selected?.value ?? input.note ?? "");
    const contextSnapshot = {
      ...task.contextSnapshot,
      task: {
        title: task.title,
        description: task.description,
        suggestedAction: task.suggestedAction,
        ruleId: task.ruleId,
      },
      selectedCandidateId: input.selectedCandidateId ?? "",
    };
    const contextHash = hashJson(contextSnapshot);
    const now = new Date().toISOString();
    const exampleId = `ann_${slug(task.componentId)}_${nanoid(6)}`;
    const componentRef = await this.findComponentLegacyPath(task.componentId);

    await this.adapter.query("BEGIN");
    try {
      await this.adapter.query(
        `INSERT INTO annotation_examples
          (example_id, package_id, component_id, task_id, rule_id, page_type, context_hash, context_snapshot, correct_value, created_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          exampleId,
          task.packageId,
          task.componentId,
          task.taskId,
          task.ruleId,
          String(task.contextSnapshot.pageType ?? task.contextSnapshot.okfType ?? ""),
          contextHash,
          JSON.stringify(contextSnapshot),
          JSON.stringify(correctValue),
          input.actor,
          now,
        ],
      );
      if (input.dismissRule && task.ruleId) {
        const dismissalId = `dismiss_${slug(task.componentId)}_${slug(task.ruleId)}`;
        await this.adapter.query(
          `INSERT INTO rule_dismissals
            (dismissal_id, package_id, component_id, component_ref, rule_id, reason, active, created_by, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (component_id, rule_id)
           DO UPDATE SET component_ref = EXCLUDED.component_ref, reason = EXCLUDED.reason, active = true, created_by = EXCLUDED.created_by, created_at = EXCLUDED.created_at`,
          [
            dismissalId,
            task.packageId,
            task.componentId,
            componentRef,
            task.ruleId,
            input.dismissalReason ?? input.note ?? "",
            true,
            input.actor,
            now,
          ],
        );
      }
      await this.adapter.query(
        `UPDATE review_tasks
         SET task_kind = 'annotation',
             status = 'resolved',
             resolved_by = $2,
             resolved_at = $3,
             resolution_note = $4,
             annotation_value = $5,
             annotated_by = $2,
             annotated_at = $3
         WHERE task_id = $1`,
        [
          task.taskId,
          input.actor,
          now,
          input.note ?? "",
          JSON.stringify(correctValue),
        ],
      );
      await this.adapter.query("COMMIT");
    } catch (error) {
      await this.adapter.query("ROLLBACK");
      throw error;
    }

    const updated = (await this.listReviewTasks({})).find((item) => item.taskId === input.taskId);
    if (!updated) throw new Error(`Unknown review task after annotation: ${input.taskId}`);
    const example: AnnotationExample = {
      exampleId,
      packageId: task.packageId,
      componentId: task.componentId,
      taskId: task.taskId,
      ruleId: task.ruleId,
      pageType: String(task.contextSnapshot.pageType ?? task.contextSnapshot.okfType ?? ""),
      contextHash,
      contextSnapshot,
      correctValue,
      createdBy: input.actor,
      createdAt: now,
    };
    await emitKnowledgeEvent(this.db, {
      eventType: "annotation.created",
      entityType: "review_task",
      entityId: task.taskId,
      payload: { componentId: task.componentId, ruleId: task.ruleId, exampleId, dismissRule: Boolean(input.dismissRule && task.ruleId) },
    });
    return { task: updated, example };
  }

  private async findComponentLegacyPath(componentId: string): Promise<string> {
    const { rows } = await this.adapter.query("SELECT legacy_path FROM asset_components WHERE component_id = $1", [componentId]);
    return rows.length ? String(rows[0].legacy_path ?? "") : "";
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
        trust: trustFromQuality(quality),
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

  async listFlywheelEvents(): Promise<FlywheelEvent[]> {
    const { rows } = await this.adapter.query(
      `SELECT *
       FROM knowledge_events
       WHERE event_type IN (
         'agent.feedback.rebuild_proposed',
         'agent.feedback.rebuild_started',
         'build.completed',
         'release.revision_proposed',
         'release.auto_publish_succeeded',
         'release.auto_publish_skipped'
       )
       ORDER BY created_at DESC
       LIMIT 100`,
    );
    return rows.map((row) => ({
      eventId: String(row.event_id),
      eventType: String(row.event_type),
      entityType: String(row.entity_type ?? ""),
      entityId: String(row.entity_id ?? ""),
      payload: jsonObject(row.payload_json),
      createdAt: String(row.created_at),
    }));
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

function reviewLearningKey(componentId: string, ruleId: string): string {
  return `${componentId}\u0000${ruleId}`;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

const EVIDENCE_COVERAGE_COMPONENT_KINDS = new Set(["wiki_page"]);

function normalizeAnnotationValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}

function hashJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "") || "item";
}
