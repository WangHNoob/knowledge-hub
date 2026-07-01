import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { nanoid } from "nanoid";

import type { AssetComponent, AssetPackage, DatabaseHandle, KnowledgeRuleConfig, ReleaseRecord, ReviewTask } from "../types";
import { mapComponent, mapPackage, mapRelease, mapReviewTask } from "../db/mappers";
import type { DiagnosticLogger } from "./diagnosticService";
import { createLegislationService } from "./legislationService";
import { createOkfExportService, type OkfExportManifest } from "./okf/exportService";
import { buildReleaseAuditSummary, type ReleaseAuditSummary } from "./releaseAudit";
import { computeTrustScore, scoreFromQuality } from "./trustScore";
import { emitKnowledgeEvent } from "./eventService";

const RELEASE_AUTO_EVIDENCE_KINDS = new Set(["wiki_page"]);
const RELEASE_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

interface ReleaseDiff {
  packageIds: DiffBucket;
  componentIds: DiffBucket;
  sourceVersionIds: DiffBucket;
  changedComponents: string[];
  unchangedComponents: string[];
}

interface DiffBucket {
  added: string[];
  removed: string[];
  unchanged: string[];
}

interface ReleaseRevision {
  parentReleaseId: string | null;
  mode: "initial" | "revision";
  diff: ReleaseDiff;
  summary: {
    packagesAdded: number;
    packagesRemoved: number;
    componentsAdded: number;
    componentsRemoved: number;
    componentsChanged: number;
    componentsUnchanged: number;
    sourceVersionsAdded: number;
    sourceVersionsRemoved: number;
  };
}

interface PublishOptions {
  autoMode?: boolean;
}

interface AutoPublishCheck {
  eligible: boolean;
  mode: "manual" | "auto";
  reasons: string[];
  changedComponentIds: string[];
  blockingTaskIds: string[];
  trustDeclines: Array<{ componentId: string; previousScore: number | null; nextScore: number | null }>;
  pendingSourceCorrections: PendingSourceCorrection[];
}

interface PendingSourceCorrection {
  correctionId: string;
  bundleId: string;
  sourcePath: string;
  ruleId: string;
  pageType: string;
  factKey: string;
  boundSourceHash: string;
  state: "pending_review";
  updatedAt: string;
}

export interface CreateReleaseDraftInput {
  version: string;
  packageIds: string[];
  requestedBy: string;
  parentReleaseId?: string | null;
  note?: string;
}

export interface ProposedReleaseRevision {
  release: ReleaseRecord | null;
  created: boolean;
  reason: "created" | "no_current_release" | "duplicate_draft" | "unknown_package" | "not_scoped_build";
}

export function createReleaseService(db: DatabaseHandle, dataDirOrDiagnostics?: string | DiagnosticLogger, diagnostics?: DiagnosticLogger) {
  return typeof dataDirOrDiagnostics === "string"
    ? new ReleaseService(db, dataDirOrDiagnostics, diagnostics)
    : new ReleaseService(db, process.cwd(), dataDirOrDiagnostics);
}

export class ReleaseService {
  private readonly adapter;

  constructor(private readonly db: DatabaseHandle, private readonly dataDir: string, private readonly diagnostics?: DiagnosticLogger) {
    this.adapter = db.adapter;
  }

  async createDraft(input: CreateReleaseDraftInput): Promise<ReleaseRecord> {
    const span = this.diagnostics?.startSpan({
      category: "release",
      message: "create release draft",
      actor: input.requestedBy,
      entityType: "release",
      context: { version: input.version, packageIds: input.packageIds }
    });
    const packageIds = uniqueSorted(input.packageIds);
    try {
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
      const parentReleaseId = input.parentReleaseId !== undefined ? input.parentReleaseId : (await this.getCurrent())?.releaseId ?? null;
      if (parentReleaseId && !(await this.getRelease(parentReleaseId))) {
        throw new Error(`Unknown parent release: ${parentReleaseId}`);
      }

      await this.adapter.query(
        `INSERT INTO releases
          (release_id, parent_release_id, version, status, package_ids, manifest_hash, manifest_json, created_by, created_at, published_by, published_at, quality_gate)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          releaseId,
          parentReleaseId,
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
      if (input.note?.trim()) await this.updateRelease(releaseId, { note: input.note.trim() });
      const finalRelease = await this.getRelease(releaseId);
      await span?.complete({ releaseId });
      return finalRelease ?? release;
    } catch (error) {
      await span?.fail(error);
      throw error;
    }
  }

  async publish(releaseId: string, publishedBy: string, options: PublishOptions = {}): Promise<ReleaseRecord> {
    const span = this.diagnostics?.startSpan({
      category: "release",
      message: "publish release",
      actor: publishedBy,
      entityType: "release",
      entityId: releaseId,
      releaseId
    });
    try {
      const release = await this.getRelease(releaseId);
      if (!release) throw new Error(`Unknown release: ${releaseId}`);
      if (release.status === "published") throw new Error(`Release ${releaseId} is already published.`);

      const packages = await this.loadPackages(release.packageIds);
      const components = await this.loadComponents(release.packageIds);
      // 设计护栏：scoped/局部重建（带 only 过滤）产出的包只含被过滤的子集，
      // 缺失父包里未受影响的文档 wiki。这类残缺包只能作为父发布的**修订**发布
      // （OKF 导出会继承父 bundle 并只 patch 变更组件），不能作为独立全量发布，
      // 否则会用残缺快照覆盖完整的已发布版本（kb_search 将查不到文档页）。
      const scoped = await this.scopedPackages(packages);
      if (scoped.length > 0 && !release.parentReleaseId) {
        throw new Error(
          `无法独立发布局部重建产生的残缺包（${scoped.map((s) => `${s.packageId} only=${s.only}`).join("; ")}）：`
          + `它缺少父包中未受影响的文档 wiki 页面。请改为发布一次全量构建的包，`
          + `或将其作为某个完整父发布的修订发布（设置 parentReleaseId 以继承父 bundle）。`,
        );
      }
      if (!options.autoMode) {
        const blockers = await this.findOpenBlockingTasks(release.packageIds);
        if (blockers.length > 0) {
          throw new Error(`Cannot publish release with open blocking tasks: ${blockers.map((task) => task.task_id).join(", ")}`);
        }
      }
      const activeRuleProfile = await createLegislationService(this.db).getActiveProfile();
      const publishedAt = new Date().toISOString();
      await this.ensurePublishEvidence(packages, components, publishedAt);
      const trustedComponents = await this.componentsWithTrustScores(components, publishedAt);
      const qualityGate = summarizePackages(packages, trustedComponents, activeRuleProfile.hash);
      const parentRelease = release.parentReleaseId ? await this.getRelease(release.parentReleaseId) : null;
      const revisionDiff = buildReleaseDiff(parentRelease, packages, trustedComponents);
      const revision = buildReleaseRevision(release, revisionDiff);
      const pendingSourceCorrections = await this.loadPendingSourceCorrections(packages);
      const autoPublish = await this.buildAutoPublishCheck(release, parentRelease, revision, trustedComponents, Boolean(options.autoMode), pendingSourceCorrections);
      if (options.autoMode && !autoPublish.eligible) {
        throw new Error(`Auto publish is not eligible: ${autoPublish.reasons.join(", ")}`);
      }
      const auditSummary = await buildReleaseAuditSummary({
        adapter: this.adapter,
        release,
        packages,
        components: trustedComponents,
        publishedAt,
        publishedBy,
        qualityGate,
        legislationProfileHash: activeRuleProfile.hash,
      });
      const okfExport = await createOkfExportService(this.db, this.dataDir).exportRelease({
        release,
        parentRelease,
        packages,
        components: trustedComponents,
        publishedAt,
        activeRuleProfileHash: activeRuleProfile.hash,
        auditSummary,
        revision: revision as unknown as Record<string, unknown>,
      });
      const manifest = buildManifest({
        release,
        packages,
        components: trustedComponents,
        qualityGate,
        publishedAt,
        publishedBy,
        activeRuleProfileHash: activeRuleProfile.hash,
        activeRuleProfileConfig: activeRuleProfile.config,
        okf: okfExport.manifest,
        auditSummary: okfExport.manifest.auditSummary,
        revision,
        autoPublish,
        pendingSourceCorrections,
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
        await this.updateComponentQualities(trustedComponents);
        await this.pointChannelToRelease(releaseId, publishedBy);
        await this.adapter.query("COMMIT");
      } catch (error) {
        await this.adapter.query("ROLLBACK");
        throw error;
      }

      const published = await this.getRelease(releaseId);
      if (!published) throw new Error(`Unknown release after publish: ${releaseId}`);
      await span?.complete({ manifestHash: published.manifestHash, packageIds: published.packageIds });
      return published;
    } catch (error) {
      await span?.fail(error);
      throw error;
    }
  }

  async rollback(releaseId: string, requestedBy: string): Promise<ReleaseRecord> {
    const span = this.diagnostics?.startSpan({
      category: "release",
      message: "rollback release",
      actor: requestedBy,
      entityType: "release",
      entityId: releaseId,
      releaseId
    });
    try {
      const release = await this.getRelease(releaseId);
      if (!release) throw new Error(`Unknown release: ${releaseId}`);
      if (release.status !== "published") throw new Error("Can only rollback to a published release.");
      await this.pointChannelToRelease(releaseId, requestedBy);
      await span?.complete({ version: release.version });
      return release;
    } catch (error) {
      await span?.fail(error);
      throw error;
    }
  }

  async deleteRelease(releaseId: string, requestedBy: string): Promise<ReleaseRecord> {
    const span = this.diagnostics?.startSpan({
      category: "release",
      message: "delete release",
      actor: requestedBy,
      entityType: "release",
      entityId: releaseId,
      releaseId
    });
    try {
      if (!RELEASE_ID_PATTERN.test(releaseId)) throw new Error("Invalid release id.");
      const release = await this.getRelease(releaseId);
      if (!release) throw new Error(`Unknown release: ${releaseId}`);
      const current = await this.getCurrent();
      if (current?.releaseId === releaseId) throw new Error("Cannot delete the current Agent release. Roll back to another release first.");

      await this.adapter.query("BEGIN");
      try {
        await this.adapter.query("DELETE FROM releases WHERE release_id = $1", [releaseId]);
        await this.adapter.query("COMMIT");
      } catch (error) {
        await this.adapter.query("ROLLBACK");
        throw error;
      }

      const releaseDir = this.releaseDir(releaseId);
      if (existsSync(releaseDir)) rmSync(releaseDir, { recursive: true, force: true });
      await span?.complete({ releaseId, version: release.version });
      return release;
    } catch (error) {
      await span?.fail(error);
      throw error;
    }
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

  private async findDraftRevision(parentReleaseId: string, packageId: string): Promise<ReleaseRecord | null> {
    const { rows } = await this.adapter.query(
      `SELECT *
       FROM releases
       WHERE status = 'draft'
         AND parent_release_id = $1
         AND package_ids @> $2::jsonb
       ORDER BY created_at DESC
       LIMIT 1`,
      [parentReleaseId, JSON.stringify([packageId])],
    );
    return rows.length ? mapRelease(rows[0]) : null;
  }

  async updateRelease(releaseId: string, patch: { version?: string; note?: string }): Promise<ReleaseRecord | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.version !== undefined) { sets.push(`version = $${params.length + 1}`); params.push(patch.version.trim()); }
    if (patch.note !== undefined) { sets.push(`note = $${params.length + 1}`); params.push(patch.note); }
    if (sets.length === 0) return null;
    params.push(releaseId);
    const { rows } = await this.adapter.query(
      `UPDATE releases SET ${sets.join(", ")} WHERE release_id = $${params.length} RETURNING *`,
      params
    );
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

  private releaseDir(releaseId: string): string {
    const root = join(this.dataDir, "releases");
    const dir = join(root, releaseId);
    const rel = relative(resolve(root), resolve(dir));
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Refusing to delete release directory outside storage root: ${releaseId}`);
    }
    return dir;
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

  async proposeRevisionDraftFromBuild(input: {
    packageId: string;
    runId: string;
    requestedBy: string;
    only?: string | null;
  }): Promise<ProposedReleaseRevision> {
    if (!input.only) return { release: null, created: false, reason: "not_scoped_build" };
    await this.adapter.query("BEGIN");
    try {
      await this.adapter.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`release_revision:${input.runId}`]);
      const pkg = (await this.loadPackages([input.packageId]))[0];
      if (!pkg) {
        await this.adapter.query("COMMIT");
        return { release: null, created: false, reason: "unknown_package" };
      }
      const current = await this.getCurrent();
      if (!current) {
        await this.adapter.query("COMMIT");
        return { release: null, created: false, reason: "no_current_release" };
      }
      const duplicate = await this.findDraftRevision(current.releaseId, input.packageId);
      if (duplicate) {
        await this.adapter.query("COMMIT");
        return { release: duplicate, created: false, reason: "duplicate_draft" };
      }

      const release = await this.createDraft({
        version: `${current.version}.rev.${compactDate(new Date())}`,
        packageIds: [input.packageId],
        parentReleaseId: current.releaseId,
        requestedBy: input.requestedBy || "system",
        note: `自动草案：scoped build ${input.runId}${input.only ? ` (${input.only})` : ""}`,
      });
      await emitKnowledgeEvent(this.db, {
        eventType: "release.revision_proposed",
        entityType: "release",
        entityId: release.releaseId,
        payload: {
          releaseId: release.releaseId,
          parentReleaseId: current.releaseId,
          packageId: input.packageId,
          runId: input.runId,
          only: input.only ?? "",
        },
      });
      await this.adapter.query("COMMIT");
      return { release, created: true, reason: "created" };
    } catch (error) {
      await this.adapter.query("ROLLBACK");
      throw error;
    }
  }

  private async findOpenBlockingTasksForComponents(componentIds: string[]): Promise<Record<string, unknown>[]> {
    if (componentIds.length === 0) return [];
    const placeholders = componentIds.map((_, index) => `$${index + 1}`).join(",");
    const { rows } = await this.adapter.query(
      `SELECT task_id, package_id, component_id, title
       FROM review_tasks
       WHERE component_id IN (${placeholders}) AND severity = 'blocking' AND status = 'open'
       ORDER BY created_at, task_id`,
      componentIds,
    );
    return rows;
  }

  private async buildAutoPublishCheck(
    release: ReleaseRecord,
    parentRelease: ReleaseRecord | null,
    revision: ReleaseRevision,
    components: AssetComponent[],
    autoMode: boolean,
    pendingSourceCorrections: PendingSourceCorrection[],
  ): Promise<AutoPublishCheck> {
    const changedComponentIds = uniqueSorted([...revision.diff.componentIds.added, ...revision.diff.changedComponents]);
    const reasons: string[] = [];
    if (!parentRelease || !release.parentReleaseId) reasons.push("missing_parent_release");
    if (revision.diff.componentIds.removed.length > 0) reasons.push("removed_components_present");
    if (changedComponentIds.length === 0) reasons.push("no_component_changes");

    const blockingTasks = await this.findOpenBlockingTasksForComponents(changedComponentIds);
    if (blockingTasks.length > 0) reasons.push("changed_components_have_blocking_tasks");

    const trustDeclines = trustDeclinesAgainstParent(parentRelease, components, changedComponentIds);
    if (trustDeclines.length > 0) reasons.push("trust_score_declined_or_missing");
    if (pendingSourceCorrections.length > 0) reasons.push("has_pending_review_corrections");

    return {
      eligible: reasons.length === 0,
      mode: autoMode ? "auto" : "manual",
      reasons,
      changedComponentIds,
      blockingTaskIds: blockingTasks.map((task) => String(task.task_id)),
      trustDeclines,
      pendingSourceCorrections,
    };
  }

  private async loadPendingSourceCorrections(packages: AssetPackage[]): Promise<PendingSourceCorrection[]> {
    const versionIds = uniqueSorted(packages.flatMap((pkg) => pkg.sourceVersionIds));
    if (versionIds.length === 0) return [];
    const placeholders = versionIds.map((_, index) => `$${index + 1}`).join(",");
    const { rows } = await this.adapter.query(
      `SELECT DISTINCT
         c.correction_id, c.bundle_id, c.source_path, c.rule_id, c.page_type, c.fact_key,
         c.bound_source_hash, c.state, c.updated_at
       FROM source_corrections c
       JOIN source_bundle_versions v ON v.bundle_id = c.bundle_id
       JOIN source_files sf ON sf.version_id = v.version_id AND sf.logical_path = c.source_path
       WHERE c.state = 'pending_review'
         AND sf.version_id IN (${placeholders})
       ORDER BY c.updated_at DESC, c.correction_id`,
      versionIds,
    );
    return rows.map((row) => ({
      correctionId: String(row.correction_id ?? ""),
      bundleId: String(row.bundle_id ?? ""),
      sourcePath: String(row.source_path ?? ""),
      ruleId: String(row.rule_id ?? ""),
      pageType: String(row.page_type ?? ""),
      factKey: String(row.fact_key ?? ""),
      boundSourceHash: String(row.bound_source_hash ?? ""),
      state: "pending_review" as const,
      updatedAt: String(row.updated_at ?? ""),
    }));
  }

  // 找出 packageIds 中由 scoped 构建（带 only 过滤）产生的残缺包：
  // 通过其 createdByRunId 的 build run config.only 判定。
  private async scopedPackages(packages: AssetPackage[]): Promise<Array<{ packageId: string; only: string }>> {
    const runIds = uniqueSorted(packages.map((pkg) => pkg.createdByRunId).filter(Boolean));
    if (runIds.length === 0) return [];
    const placeholders = runIds.map((_, index) => `$${index + 1}`).join(",");
    const { rows } = await this.adapter.query(
      `SELECT run_id, config_json->>'only' AS only_filter FROM knowledge_build_runs WHERE run_id IN (${placeholders})`,
      runIds,
    );
    const onlyByRun = new Map(rows.map((row) => [String(row.run_id), String(row.only_filter ?? "").trim()] as const));
    return packages
      .map((pkg) => ({ packageId: pkg.packageId, only: onlyByRun.get(pkg.createdByRunId) ?? "" }))
      .filter((entry) => entry.only.length > 0);
  }

  private async loadPackages(packageIds: string[]): Promise<AssetPackage[]> {    if (packageIds.length === 0) return [];
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

  private async ensurePublishEvidence(packages: AssetPackage[], components: AssetComponent[], now: string): Promise<void> {
    const targets = components.filter((component) => RELEASE_AUTO_EVIDENCE_KINDS.has(component.kind));
    if (targets.length === 0) return;
    const targetIds = targets.map((component) => component.componentId);
    const placeholders = targetIds.map((_, index) => `$${index + 1}`).join(",");
    const { rows } = await this.adapter.query(
      `SELECT component_id FROM evidence_records WHERE component_id IN (${placeholders})`,
      targetIds,
    );
    const covered = new Set(rows.map((row) => String(row.component_id)));
    const sourceVersionByPackage = new Map(packages.map((pkg) => [pkg.packageId, pkg.sourceVersionIds[0] ?? ""] as const));

    for (const component of targets) {
      if (covered.has(component.componentId)) continue;
      const refs = component.sourceRefs.length > 0 ? component.sourceRefs : ["source bundle"];
      for (const sourceRef of refs.slice(0, 3)) {
        const digest = createHash("sha1").update(`${component.componentId}:${sourceRef}`).digest("hex").slice(0, 10);
        await this.adapter.query(
          `INSERT INTO evidence_records
             (evidence_id, package_id, component_id, source_version_id, quote, note, confidence, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (evidence_id) DO NOTHING`,
          [
            `ev_pub_${slug(component.componentId)}_${digest}`,
            component.packageId,
            component.componentId,
            sourceVersionByPackage.get(component.packageId) ?? "",
            `Published from source reference: ${sourceRef}`,
            `Auto-linked during release publish for ${component.artifactId}.`,
            0.7,
            now,
          ],
        );
      }
    }
  }

  private async componentsWithTrustScores(components: AssetComponent[], publishedAt: string): Promise<AssetComponent[]> {
    const componentIds = components.map((component) => component.componentId);
    const [evidenceByComponent, reviewTasksByComponent] = await Promise.all([
      this.evidenceRowsByComponent(componentIds),
      this.openReviewTasksByComponent(componentIds),
    ]);
    return components.map((component) => {
      const quality: Record<string, unknown> = { ...component.quality };
      quality.trust = computeTrustScore({
        component: { ...component, quality },
        evidenceRows: evidenceByComponent.get(component.componentId) ?? [],
        reviewTasks: reviewTasksByComponent.get(component.componentId) ?? [],
        now: publishedAt,
        lastTrustedAuditAt: publishedAt,
      });
      return { ...component, quality };
    });
  }

  private async evidenceRowsByComponent(componentIds: string[]): Promise<Map<string, Array<{ sourceVersionId: string; quote: string; confidence: number }>>> {
    if (componentIds.length === 0) return new Map();
    const placeholders = componentIds.map((_, index) => `$${index + 1}`).join(",");
    const { rows } = await this.adapter.query(
      `SELECT component_id, source_version_id, quote, confidence
       FROM evidence_records
       WHERE component_id IN (${placeholders})`,
      componentIds,
    );
    const out = new Map<string, Array<{ sourceVersionId: string; quote: string; confidence: number }>>();
    for (const row of rows) {
      const componentId = String(row.component_id);
      out.set(componentId, [...(out.get(componentId) ?? []), {
        sourceVersionId: String(row.source_version_id ?? ""),
        quote: String(row.quote ?? ""),
        confidence: Number(row.confidence ?? 0),
      }]);
    }
    return out;
  }

  private async openReviewTasksByComponent(componentIds: string[]): Promise<Map<string, ReviewTask[]>> {
    if (componentIds.length === 0) return new Map();
    const placeholders = componentIds.map((_, index) => `$${index + 1}`).join(",");
    const { rows } = await this.adapter.query(
      `SELECT *
       FROM review_tasks
       WHERE component_id IN (${placeholders}) AND status = 'open'`,
      componentIds,
    );
    const out = new Map<string, ReviewTask[]>();
    for (const row of rows) {
      const task = mapReviewTask(row);
      out.set(task.componentId, [...(out.get(task.componentId) ?? []), task]);
    }
    return out;
  }

  private async updateComponentQualities(components: AssetComponent[]): Promise<void> {
    for (const component of components) {
      await this.adapter.query(
        "UPDATE asset_components SET quality = $2 WHERE component_id = $1",
        [component.componentId, JSON.stringify(component.quality)],
      );
    }
  }
}

function buildManifest(input: {
  release: ReleaseRecord;
  packages: AssetPackage[];
  components: AssetComponent[];
  qualityGate: Record<string, unknown>;
  publishedAt: string;
  publishedBy: string;
  activeRuleProfileHash: string;
  activeRuleProfileConfig: KnowledgeRuleConfig;
  okf: OkfExportManifest;
  auditSummary: ReleaseAuditSummary;
  revision: ReleaseRevision;
  autoPublish: AutoPublishCheck;
  pendingSourceCorrections: PendingSourceCorrection[];
}) {
  const componentIds = input.components.map((component) => component.componentId).sort();
  const sourceVersionIds = uniqueSorted(input.packages.flatMap((pkg) => pkg.sourceVersionIds));
  return {
    releaseId: input.release.releaseId,
    parentReleaseId: input.release.parentReleaseId,
    version: input.release.version,
    revision: input.revision,
    autoPublish: input.autoPublish,
    sourceCorrections: {
      pendingReview: input.pendingSourceCorrections,
    },
    packageIds: input.packages.map((pkg) => pkg.packageId).sort(),
    componentIds,
    sourceVersionIds,
    legislationProfile: {
      activeHash: input.activeRuleProfileHash,
      governanceRules: input.activeRuleProfileConfig.governanceRules,
      packageProfiles: uniqueObjects(input.packages.map((pkg) => profileFromQuality(pkg.qualitySummary)).filter(Boolean)),
    },
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
    okf: input.okf,
    auditSummary: input.auditSummary,
    qualityGate: input.qualityGate,
    publishedAt: input.publishedAt,
    publishedBy: input.publishedBy,
  };
}

function buildReleaseDiff(parent: ReleaseRecord | null, packages: AssetPackage[], components: AssetComponent[]): ReleaseDiff {
  // 组件身份必须用 artifactId（= legacyPath，跨构建稳定），不能用 componentId：
  // componentId 形如 cmp_<packageId>_<path>_<hash>，每次构建都换新 packageId，
  // 用它做 diff 会把"同一逻辑页面"判成"父删一个 + 本次增一个"，导致 added/removed
  // 恒等于全集、changed 恒为空——自动发布永远卡 removed_components_present。
  // 这里按 artifactId 求增删改，但 diff 的各 bucket 仍输出**本次构建的 componentId**
  // （removed 没有对应的本次组件，输出父 componentId），以兼容下游按 componentId 的
  // blocking 任务 / 可信度查询与前端展示。
  const parentManifest = parent?.manifest ?? {};
  const parentPackageIds = stringArray(parentManifest.packageIds);
  const nextPackageIds = packages.map((pkg) => pkg.packageId);
  const parentSourceVersionIds = stringArray(parentManifest.sourceVersionIds);
  const nextSourceVersionIds = uniqueSorted(packages.flatMap((pkg) => pkg.sourceVersionIds));

  const parentByArtifact = parentComponentIndex(parentManifest.components);
  const nextByArtifact = new Map(components.map((component) => [component.artifactId, component] as const));

  const parentArtifactIds = [...parentByArtifact.keys()];
  const nextArtifactIds = [...nextByArtifact.keys()];
  const sharedArtifactIds = parentArtifactIds.filter((artifactId) => nextByArtifact.has(artifactId));

  // 各 bucket 用 componentId 表达：added/unchanged/changed → 本次 componentId；removed → 父 componentId。
  const addedIds = nextArtifactIds
    .filter((artifactId) => !parentByArtifact.has(artifactId))
    .map((artifactId) => nextByArtifact.get(artifactId)!.componentId).sort();
  const removedIds = parentArtifactIds
    .filter((artifactId) => !nextByArtifact.has(artifactId))
    .map((artifactId) => parentByArtifact.get(artifactId)!.componentId).sort();
  const changedComponents = sharedArtifactIds
    .filter((artifactId) => parentByArtifact.get(artifactId)!.fingerprint !== contentFingerprint(nextByArtifact.get(artifactId)!))
    .map((artifactId) => nextByArtifact.get(artifactId)!.componentId).sort();
  const changedSet = new Set(changedComponents);
  const unchangedSharedIds = sharedArtifactIds
    .map((artifactId) => nextByArtifact.get(artifactId)!.componentId).sort();
  const unchangedComponents = unchangedSharedIds.filter((componentId) => !changedSet.has(componentId));

  return {
    packageIds: diffBucket(parentPackageIds, nextPackageIds),
    componentIds: { added: addedIds, removed: removedIds, unchanged: unchangedSharedIds },
    sourceVersionIds: diffBucket(parentSourceVersionIds, nextSourceVersionIds),
    changedComponents,
    unchangedComponents,
  };
}

// 把父发布 manifest.components 建成 artifactId → { componentId, 内容指纹 } 索引。
function parentComponentIndex(value: unknown): Map<string, { componentId: string; fingerprint: string }> {
  const index = new Map<string, { componentId: string; fingerprint: string }>();
  if (!Array.isArray(value)) return index;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const component = item as Record<string, unknown>;
    const artifactId = typeof component.artifactId === "string" ? component.artifactId : "";
    const componentId = typeof component.componentId === "string" ? component.componentId : "";
    if (!artifactId || !componentId) continue;
    index.set(artifactId, { componentId, fingerprint: contentFingerprint(component) });
  }
  return index;
}

// 内容指纹：刻意**排除 packageId**（每次构建都变），只看跨构建稳定的内容字段，
// 这样"同一页面内容没变"在两次构建间能判为 unchanged 而非 changed。
function contentFingerprint(component: AssetComponent | Record<string, unknown>): string {
  return stableStringify({
    artifactId: (component as Record<string, unknown>).artifactId,
    group: (component as Record<string, unknown>).group,
    kind: (component as Record<string, unknown>).kind,
    title: (component as Record<string, unknown>).title,
    storageUri: (component as Record<string, unknown>).storageUri,
    sourceRefs: stringArray((component as Record<string, unknown>).sourceRefs),
    quality: stableQualityValue((component as Record<string, unknown>).quality),
  });
}

function buildReleaseRevision(release: ReleaseRecord, diff: ReleaseDiff): ReleaseRevision {
  return {
    parentReleaseId: release.parentReleaseId,
    mode: release.parentReleaseId ? "revision" : "initial",
    diff,
    summary: {
      packagesAdded: diff.packageIds.added.length,
      packagesRemoved: diff.packageIds.removed.length,
      componentsAdded: diff.componentIds.added.length,
      componentsRemoved: diff.componentIds.removed.length,
      componentsChanged: diff.changedComponents.length,
      componentsUnchanged: diff.unchangedComponents.length,
      sourceVersionsAdded: diff.sourceVersionIds.added.length,
      sourceVersionsRemoved: diff.sourceVersionIds.removed.length,
    },
  };
}

function trustDeclinesAgainstParent(
  parentRelease: ReleaseRecord | null,
  components: AssetComponent[],
  changedComponentIds: string[],
): Array<{ componentId: string; previousScore: number | null; nextScore: number | null }> {
  const componentById = new Map(components.map((component) => [component.componentId, component] as const));
  const nextById = new Map(components.map((component) => [component.componentId, scoreFromQuality(component.quality)] as const));
  // 父分数按 artifactId 索引（componentId 跨构建不稳定，无法直接对应）。
  const previousByArtifact = parentComponentTrustScores(parentRelease);
  const declines: Array<{ componentId: string; previousScore: number | null; nextScore: number | null }> = [];
  for (const componentId of changedComponentIds) {
    const artifactId = componentById.get(componentId)?.artifactId ?? "";
    const nextScore = nextById.get(componentId) ?? null;
    const hasPrevious = Boolean(artifactId) && previousByArtifact.has(artifactId);
    const previousScore = artifactId ? previousByArtifact.get(artifactId) ?? null : null;
    if (nextScore === null) declines.push({ componentId, previousScore, nextScore });
    else if (!hasPrevious) continue; // 全新组件（父发布无此 artifact），无基线可比，不算下降
    else if (previousScore === null) declines.push({ componentId, previousScore, nextScore });
    else if (nextScore + 0.0001 < previousScore) declines.push({ componentId, previousScore, nextScore });
  }
  return declines;
}

// 父发布各组件的可信度分数，按 artifactId（稳定）索引。
function parentComponentTrustScores(parentRelease: ReleaseRecord | null): Map<string, number | null> {
  if (!parentRelease) return new Map();
  const components = Array.isArray(parentRelease.manifest.components) ? parentRelease.manifest.components : [];
  const entries = components.flatMap((item) => {
    const component = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const artifactId = typeof component.artifactId === "string" ? component.artifactId : "";
    const quality = component.quality && typeof component.quality === "object" && !Array.isArray(component.quality)
      ? component.quality as Record<string, unknown>
      : {};
    return artifactId ? [[artifactId, scoreFromQuality(quality)] as const] : [];
  });
  return new Map(entries);
}

function diffBucket(previous: string[], next: string[]): DiffBucket {
  const previousSet = new Set(previous);
  const nextSet = new Set(next);
  return {
    added: next.filter((id) => !previousSet.has(id)).sort(),
    removed: previous.filter((id) => !nextSet.has(id)).sort(),
    unchanged: next.filter((id) => previousSet.has(id)).sort(),
  };
}

function stableQualityValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableQualityValue);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "lastTrustedAuditAt") continue;
    out[key] = stableQualityValue(child);
  }
  return out;
}

function summarizePackages(packages: AssetPackage[], components: AssetComponent[] = [], activeRuleProfileHash = ""): Record<string, unknown> {
  const scores = packages
    .map((pkg) => numberFromQuality(pkg.qualitySummary, ["overallScore", "score", "confidence"]))
    .filter((score): score is number => Number.isFinite(score));
  const componentScores = components
    .map((component) => scoreFromQuality(component.quality))
    .filter((score): score is number => Number.isFinite(score));
  const allScores = [...scores, ...componentScores];
  const blockingCount = packages.reduce((sum, pkg) => sum + Number(pkg.qualitySummary.blockingCount ?? 0), 0);
  const warningCount = packages.reduce((sum, pkg) => sum + Number(pkg.qualitySummary.warningCount ?? 0), 0);
  const staleRuleProfileCount = activeRuleProfileHash
    ? packages.filter((pkg) => {
      const profile = profileFromQuality(pkg.qualitySummary);
      return profile?.hash && profile.hash !== activeRuleProfileHash;
    }).length
    : 0;

  return {
    packageCount: packages.length,
    componentCount: components.length,
    sourceVersionIds: uniqueSorted(packages.flatMap((pkg) => pkg.sourceVersionIds)),
    averageScore: allScores.length === 0 ? null : round2(allScores.reduce((sum, score) => sum + score, 0) / allScores.length),
    blockingCount,
    warningCount,
    staleRuleProfileCount,
    legislationProfileHash: activeRuleProfileHash || null,
  };
}

function profileFromQuality(quality: Record<string, unknown>): { profileId?: string; hash?: string } | null {
  const value = quality.legislationProfile;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const profile = value as Record<string, unknown>;
  return { profileId: typeof profile.profileId === "string" ? profile.profileId : undefined, hash: typeof profile.hash === "string" ? profile.hash : undefined };
}

function uniqueObjects(values: Array<{ profileId?: string; hash?: string } | null>): Array<{ profileId?: string; hash?: string }> {
  const seen = new Set<string>();
  const out: Array<{ profileId?: string; hash?: string }> = [];
  for (const value of values) {
    if (!value) continue;
    const key = `${value.profileId ?? ""}:${value.hash ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function hashManifest(manifest: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(stableStringify(manifest)).digest("hex")}`;
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function compactDate(date: Date): string {
  return date.toISOString().replace(/\D/gu, "").slice(0, 14);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "item";
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
