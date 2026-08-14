import { readdirSync } from "node:fs";
import { join } from "node:path";

import type {
  AssetComponent,
  KnowledgeEnvelope,
  KnowledgeEnvelopeTrustScore,
  KnowledgeTrace,
  ReleaseRecord,
  TrustScore,
} from "../../types";
import type { AutoPublishCheck } from "../releaseService";
import { jsonArray, jsonObject } from "../../db/mappers";
import { scoreFromQuality, trustFromQuality } from "../trustScore";
import { tokenizeSearchText, type OkfSearchResultItem } from "../okf/searchIndex";
import type {
  CorrectionAnchorMatchMethod,
  CorrectionTarget,
  HealthComponentSummary,
  HealthCorrectionSummary,
  OkfCitation,
  OkfPage,
  PublishTarget,
  SearchMatchClassification,
  SourceCorrectionView,
  TableFieldMapping,
  TableMappedRow,
  TableSchema,
  TableSchemaEntry,
} from "./types";

const MCP_ENVELOPE_DETAIL_LIMIT = 20;
const GRAPH_TOOLS = new Set(["kb_get_entity", "kb_get_neighbors", "kb_list_entities", "kb_get_relations"]);
const TABLE_TOOLS = new Set(["kb_get_page_tables", "kb_list_tables", "kb_get_table_schema", "kb_query_table", "kb_get_table_raw", "kb_validate_table", "kb_check_table_value"]);
const REPORT_TOOLS = new Set(["kb_report_gap", "kb_report_bad_hit", "kb_report_stale"]);
export { MCP_ENVELOPE_DETAIL_LIMIT, GRAPH_TOOLS, TABLE_TOOLS, REPORT_TOOLS };

export function releaseEnvelope(release: ReleaseRecord) {
  return {
    releaseId: release.releaseId,
    version: release.version,
    publishedAt: release.publishedAt,
    manifestHash: release.manifestHash,
  };
}

export function slimTrustEnvelope(trust: KnowledgeEnvelope["trust"], limit = MCP_ENVELOPE_DETAIL_LIMIT): KnowledgeEnvelope["trust"] {
  const components = trust.components ?? [];
  return {
    ...trust,
    components: components.slice(0, limit).map((component) => ({
      ...component,
      trust: slimEnvelopeTrustScore(component.trust),
    })),
    componentsSummary: {
      count: components.length,
      sampleComponentIds: components.slice(0, limit).map((component) => component.componentId),
      truncated: components.length > limit,
    },
  };
}

export function slimEnvelopeTrustScore(trust: TrustScore | KnowledgeEnvelopeTrustScore | null): KnowledgeEnvelopeTrustScore | null {
  if (!trust) return null;
  return {
    version: trust.version,
    score: trust.score,
    status: trust.status,
    lastTrustedAuditAt: trust.lastTrustedAuditAt,
    evidenceRequired: trust.evidenceRequired,
  };
}

export function slimTraceArrays(trace: Omit<KnowledgeTrace, "releaseId">, limit = MCP_ENVELOPE_DETAIL_LIMIT): Omit<KnowledgeTrace, "releaseId"> {
  return {
    componentIds: trace.componentIds.slice(0, limit),
    artifactIds: trace.artifactIds.slice(0, limit),
    sourceVersionIds: trace.sourceVersionIds.slice(0, limit),
    evidenceIds: trace.evidenceIds.slice(0, limit),
    componentIdSummary: sampleArray(trace.componentIds, limit),
    artifactIdSummary: sampleArray(trace.artifactIds, limit),
    sourceVersionIdSummary: sampleArray(trace.sourceVersionIds, limit),
    evidenceIdSummary: sampleArray(trace.evidenceIds, limit),
  };
}

export function releaseSummary(release: ReleaseRecord, includeManifest: boolean, manifestLimit = 30): Record<string, unknown> {
  const manifest = release.manifest as Record<string, unknown>;
  const okf = jsonObject(manifest.okf);
  return {
    releaseId: release.releaseId,
    projectId: release.projectId,
    parentReleaseId: release.parentReleaseId,
    version: release.version,
    status: release.status,
    publishedAt: release.publishedAt,
    publishedBy: release.publishedBy,
    manifestHash: release.manifestHash,
    packageIds: release.packageIds,
    quality: release.qualityGate,
    okf: {
      bundleUri: okf.bundleUri ?? "",
      reportUri: okf.reportUri ?? "",
      reportMarkdownUri: okf.reportMarkdownUri ?? "",
      graphUri: okf.graphUri ?? "",
      tableSchemasUri: okf.tableSchemasUri ?? "",
      tableAliasesUri: okf.tableAliasesUri ?? "",
      evidenceUri: okf.evidenceUri ?? "",
      searchIndexUri: okf.searchIndexUri ?? "",
      logUri: okf.logUri ?? "",
      lintUri: okf.lintUri ?? "",
      okfVersion: okf.okfVersion ?? "",
      bundleHash: okf.bundleHash ?? "",
      summary: okf.summary ?? null,
      linkSummary: okf.linkSummary ?? null,
      citationSummary: okf.citationSummary ?? null,
      lintSummary: okf.lintSummary ?? null,
    },
    componentCount: jsonArray(manifest.componentIds).length,
    sourceVersionIds: releaseSourceVersionIds(release),
    manifest: includeManifest ? manifestPreview(manifest, manifestLimit) : undefined,
    manifestTruncated: includeManifest ? true : undefined,
    manifestAccess: includeManifest ? {
      mode: "preview",
      reason: "Full release manifests can exceed MCP response limits. Use okf.bundleUri and related OKF URIs to consume the frozen bundle files.",
      limit: boundedLimitArg(manifestLimit, 30, 200),
    } : undefined,
  };
}

export function manifestPreview(manifest: Record<string, unknown>, limit: number): Record<string, unknown> {
  const boundedLimit = boundedLimitArg(limit, 30, 200);
  const componentIds = jsonArray(manifest.componentIds);
  const packageIds = jsonArray(manifest.packageIds);
  const sourceVersionIds = jsonArray(manifest.sourceVersionIds);
  const components = arraySample(manifest.components, boundedLimit);
  return {
    releaseId: String(manifest.releaseId ?? ""),
    projectId: String(manifest.projectId ?? ""),
    version: String(manifest.version ?? ""),
    status: String(manifest.status ?? ""),
    publishedAt: manifest.publishedAt ?? null,
    manifestHash: String(manifest.manifestHash ?? ""),
    okf: jsonObject(manifest.okf),
    qualityGate: jsonObject(manifest.qualityGate),
    auditSummary: jsonObject(manifest.auditSummary),
    revision: slimRevision(jsonObject(manifest.revision), boundedLimit),
    autoPublish: slimAutoPublishPreview(jsonObject(manifest.autoPublish), boundedLimit),
    packageIds: sampleArray(packageIds, boundedLimit),
    sourceVersionIds: sampleArray(sourceVersionIds, boundedLimit),
    componentIds: sampleArray(componentIds, boundedLimit),
    components: {
      count: components.count,
      sample: components.sample.map((component) => slimManifestComponent(jsonObject(component))),
      truncated: components.truncated,
    },
  };
}

export function slimRevision(revision: Record<string, unknown>, limit: number): Record<string, unknown> {
  if (Object.keys(revision).length === 0) return {};
  const diff = jsonObject(revision.diff);
  const packageIds = jsonObject(diff.packageIds);
  const componentIds = jsonObject(diff.componentIds);
  const sourceVersionIds = jsonObject(diff.sourceVersionIds);
  return {
    parentReleaseId: revision.parentReleaseId ?? null,
    mode: String(revision.mode ?? ""),
    summary: jsonObject(revision.summary),
    diff: {
      packageIds: slimDiffBucket(packageIds, limit),
      componentIds: slimDiffBucket(componentIds, limit),
      sourceVersionIds: slimDiffBucket(sourceVersionIds, limit),
      changedComponents: sampleArray(jsonArray(diff.changedComponents), limit),
      unchangedComponents: sampleArray(jsonArray(diff.unchangedComponents), limit),
    },
  };
}

export function slimDiffBucket(bucket: Record<string, unknown>, limit: number): Record<string, unknown> {
  return {
    added: sampleArray(jsonArray(bucket.added), limit),
    removed: sampleArray(jsonArray(bucket.removed), limit),
    unchanged: sampleArray(jsonArray(bucket.unchanged), limit),
  };
}

export function slimAutoPublishPreview(autoPublish: Record<string, unknown>, limit: number): Record<string, unknown> {
  if (Object.keys(autoPublish).length === 0) return {};
  const trustDeclines = arraySample(autoPublish.trustDeclines, limit);
  const pendingSourceCorrections = arraySample(autoPublish.pendingSourceCorrections, limit);
  return {
    eligible: Boolean(autoPublish.eligible),
    mode: String(autoPublish.mode ?? ""),
    reasons: jsonArray(autoPublish.reasons),
    reasonDetails: Array.isArray(autoPublish.reasonDetails) ? autoPublish.reasonDetails : [],
    changedComponents: sampleArray(jsonArray(autoPublish.changedComponentIds), limit),
    blockingTasks: sampleArray(jsonArray(autoPublish.blockingTaskIds), limit),
    trustDeclines: {
      count: trustDeclines.count,
      sample: trustDeclines.sample,
      truncated: trustDeclines.truncated,
    },
    pendingSourceCorrections: {
      count: pendingSourceCorrections.count,
      sample: pendingSourceCorrections.sample,
      truncated: pendingSourceCorrections.truncated,
    },
    lintRemediation: jsonObject(autoPublish.lintRemediation),
  };
}

export function slimManifestComponent(component: Record<string, unknown>): Record<string, unknown> {
  return {
    componentId: String(component.componentId ?? ""),
    packageId: String(component.packageId ?? ""),
    artifactId: String(component.artifactId ?? ""),
    title: String(component.title ?? ""),
    kind: String(component.kind ?? ""),
    groupName: String(component.groupName ?? component.group_name ?? ""),
    trust: component.trust ?? null,
  };
}

export function publishTargetSummary(target: PublishTarget, limit = 20): Record<string, unknown> {
  return {
    runId: target.runId,
    packageId: target.packageId,
    only: target.only,
    componentCount: target.componentIds.length,
    componentIdSample: target.componentIds.slice(0, limit),
    componentIdsTruncated: target.componentIds.length > limit,
  };
}

export function slimAutoPublishCheck(check: AutoPublishCheck, limit = 20): Record<string, unknown> {
  return {
    eligible: check.eligible,
    mode: check.mode,
    reasons: check.reasons,
    reasonDetails: check.reasonDetails,
    changedComponents: sampleArray(check.changedComponentIds, limit),
    blockingTasks: sampleArray(check.blockingTaskIds, limit),
    trustDeclines: {
      count: check.trustDeclines.length,
      sample: check.trustDeclines.slice(0, limit),
      truncated: check.trustDeclines.length > limit,
    },
    pendingSourceCorrections: {
      count: check.pendingSourceCorrections.length,
      sample: check.pendingSourceCorrections.slice(0, limit),
      truncated: check.pendingSourceCorrections.length > limit,
    },
    lintRemediation: check.lintRemediation,
  };
}

export function slimPublishTarget(target: Record<string, unknown>): Record<string, unknown> {
  const componentIds = jsonArray(target.componentIds);
  if (componentIds.length === 0) return target;
  const rest = { ...target };
  delete rest.componentIds;
  return {
    ...rest,
    componentCount: Number(target.componentCount ?? componentIds.length),
    componentIdSample: jsonArray(target.componentIdSample).length ? jsonArray(target.componentIdSample) : componentIds.slice(0, 20),
    componentIdsTruncated: Boolean(target.componentIdsTruncated ?? componentIds.length > 20),
  };
}

export function sampleArray(values: string[], limit: number): { count: number; sample: string[]; truncated: boolean } {
  return {
    count: values.length,
    sample: values.slice(0, limit),
    truncated: values.length > limit,
  };
}

export function arraySample(value: unknown, limit: number): { count: number; sample: unknown[]; truncated: boolean } {
  const values = Array.isArray(value) ? value : [];
  return {
    count: values.length,
    sample: values.slice(0, limit),
    truncated: values.length > limit,
  };
}

export function emptyTrustSummary(release: ReleaseRecord | null): NonNullable<KnowledgeEnvelope["trust"]["summary"]> {
  return {
    level: "unknown",
    evidenceCount: 0,
    sourceRefs: [],
    lastReviewedAt: null,
    lastPublishedAt: release?.publishedAt ?? null,
    negativeFeedbackCount: 0,
    lintStatus: "unknown",
    correctionStatus: "none",
    ruleProfileHash: release ? ruleProfileHashFromRelease(release) : "",
  };
}

export function trustLevel(minScore: number | null): "high" | "medium" | "low" | "unknown" {
  if (minScore === null) return "unknown";
  if (minScore >= 0.8) return "high";
  if (minScore >= 0.6) return "medium";
  return "low";
}

export function lintStatusFromTrust(trustScores: Array<TrustScore | null>): "passed" | "warning" | "failed" | "unknown" {
  const known = trustScores.filter((score): score is TrustScore => Boolean(score));
  if (known.length === 0) return "unknown";
  if (known.some((score) => score.status === "blocked")) return "failed";
  if (known.some((score) => score.status === "needs_review" || score.status === "usable_with_risk")) return "warning";
  return "passed";
}

export function latestIso(values: string[]): string | null {
  const sorted = values.filter(Boolean).sort();
  return sorted.length ? sorted[sorted.length - 1] : null;
}

export function ruleProfileHashFromRelease(release: ReleaseRecord): string {
  const manifest = release.manifest as Record<string, unknown>;
  const qualityGate = release.qualityGate as Record<string, unknown>;
  return String(
    manifest.activeRuleProfileHash
      ?? manifest.legislationProfileHash
      ?? qualityGate.legislationProfileHash
      ?? "",
  );
}

export function envelopeContract(toolName: string, evidenceIds: string[]): KnowledgeEnvelope["contract"] {
  return {
    schemaVersion: "knowledge-envelope/v1",
    toolName,
    stableFields: ["contract", "release", "result", "qualityFlags", "trust", "trace"],
    capabilities: {
      trust: "included",
      evidence: evidenceIds.length > 0 ? "linked" : "none",
      graph: GRAPH_TOOLS.has(toolName) ? "available" : "not_applicable",
      tables: TABLE_TOOLS.has(toolName) ? "available" : "not_applicable",
      feedback: REPORT_TOOLS.has(toolName) ? "explicit_report" : "auto_recorded",
    },
  };
}

export function releaseSourceVersionIds(release: ReleaseRecord): string[] {
  const manifestSources = jsonArray((release.manifest as Record<string, unknown>).sourceVersionIds);
  const packageSources = Array.isArray((release.manifest as Record<string, unknown>).packages)
    ? ((release.manifest as Record<string, unknown>).packages as Array<Record<string, unknown>>).flatMap((pkg) => jsonArray(pkg.sourceVersionIds))
    : [];
  return uniqueSorted([...manifestSources, ...packageSources]);
}

export function flywheelGateReasons(input: {
  latestBuild: Record<string, unknown> | null;
  blockingTasks: number;
  pendingReviewTasks: number;
  pendingCorrections: number;
  lintSummary: { pending: number; failed: number; needsHuman: number };
}): string[] {
  const reasons: string[] = [];
  if (!input.latestBuild?.packageId) reasons.push("no_completed_build_package");
  if (input.blockingTasks > 0) reasons.push("blocking_tasks");
  if (input.pendingReviewTasks > 0) reasons.push("pending_review_tasks");
  if (input.pendingCorrections > 0) reasons.push("pending_corrections");
  if (input.lintSummary.pending > 0) reasons.push("lint_pending");
  if (input.lintSummary.failed > 0) reasons.push("lint_failed");
  if (input.lintSummary.needsHuman > 0) reasons.push("lint_needs_human");
  return reasons;
}

export function healthBlockingReasons(input: {
  blockingTasks: number;
  pendingCorrections: number;
  lintSummary: { pending: number; failed: number; needsHuman: number };
}): string[] {
  const reasons: string[] = [];
  if (input.blockingTasks > 0) reasons.push("blocking_tasks");
  if (input.pendingCorrections > 0) reasons.push("pending_corrections");
  if (input.lintSummary.failed > 0) reasons.push("lint_failed");
  if (input.lintSummary.needsHuman > 0) reasons.push("lint_needs_human");
  return reasons;
}

export function healthWarningReasons(input: {
  pendingReviewTasks: number;
  negativeFeedback: number;
  lowTrustCount: number;
  staleAuditCount: number;
  activeCorrections: number;
  lintSummary: { pending: number; failed: number; needsHuman: number };
  lowConsumptionCount?: number;
}): string[] {
  const reasons: string[] = [];
  if (input.pendingReviewTasks > 0) reasons.push("pending_review_tasks");
  if (input.negativeFeedback > 0) reasons.push("negative_feedback");
  if (input.lowTrustCount > 0) reasons.push("low_trust_components");
  if (input.staleAuditCount > 0) reasons.push("stale_audit_components");
  if (input.activeCorrections > 0) reasons.push("active_corrections_waiting_rebuild");
  if (input.lintSummary.pending > 0) reasons.push("lint_pending");
  // R5：低消费组件（近 30 天零检索/零点击/零引用且发布超 30 天）→ 疑似过期候选
  if ((input.lowConsumptionCount ?? 0) > 0) reasons.push("low_consumption_components");
  return reasons;
}

export function healthSummary(status: string, version: string, blockingCount: number, warningCount: number): string {
  if (status === "passed") return `发布 ${version} 当前可供 Agent 消费，未发现阻断项。`;
  if (status === "needs_attention") return `发布 ${version} 存在 ${blockingCount} 类阻断项，Agent 可查询但应谨慎采纳。`;
  return `发布 ${version} 可消费，但存在 ${warningCount} 类风险，建议 Agent 按推荐动作继续治理。`;
}

export function healthRecommendations(
  projectId: string,
  blockingReasons: string[],
  warningReasons: string[],
  samples: {
    pendingCorrections: HealthCorrectionSummary[];
    activeCorrections: HealthCorrectionSummary[];
    lowTrust: HealthComponentSummary[];
    staleAudit: HealthComponentSummary[];
    lowConsumption?: HealthComponentSummary[];
  } = { pendingCorrections: [], activeCorrections: [], lowTrust: [], staleAudit: [] },
): Array<{ action: string; tool: string; reason: string; payload?: Record<string, unknown> }> {
  const reasons = new Set([...blockingReasons, ...warningReasons]);
  const out: Array<{ action: string; tool: string; reason: string; payload?: Record<string, unknown> }> = [];
  const pending = samples.pendingCorrections[0];
  if (reasons.has("pending_corrections") && pending) {
    out.push({
      action: "govern_pending_correction",
      tool: "kb_govern_flywheel",
      reason: "存在待应用修正；使用一键治理让服务端按顺序激活修正、增量检查并尝试门禁发布。",
      payload: { projectId, correctionId: pending.correctionId },
    });
  }
  const active = samples.activeCorrections[0];
  if (reasons.has("active_corrections_waiting_rebuild") && active) {
    out.push({
      action: "govern_active_correction",
      tool: "kb_govern_flywheel",
      reason: "存在已激活修正；跳过重复应用，继续 scoped rebuild/check 与发布门禁判断。",
      payload: { projectId, correctionId: active.correctionId, apply: false, componentId: active.componentId || undefined },
    });
  }
  if (reasons.has("lint_pending")) {
    out.push({
      action: "run_pending_lint_remediations",
      tool: "kb_start_incremental_check",
      reason: "存在待自动治理的 Knowledge Lint 项；让服务端按治理队列启动 scoped rebuild。",
      payload: { projectId, runPendingLintRemediations: true },
    });
  }
  if (reasons.has("lint_failed") || reasons.has("lint_needs_human")) {
    out.push({ action: "inspect_exceptions", tool: "kb_get_flywheel_status", reason: "Knowledge Lint 治理项需要先处理，自动发布门禁不会绕过。", payload: { projectId } });
  }
  const weak = samples.lowTrust[0] ?? samples.staleAudit[0];
  if (reasons.has("low_trust_components") || reasons.has("stale_audit_components") || reasons.has("negative_feedback")) {
    out.push({
      action: "submit_correction_or_feedback",
      tool: "kb_govern_flywheel",
      reason: "低可信、审计过期或负反馈应由 Agent 提交修正并触发增量检查。",
      payload: { projectId, ...(weak ? { componentId: weak.componentId } : {}) },
    });
  }
  // R5：低消费组件 → kb_report_stale（stale_knowledge 反馈链），人工确认后可修订或移除
  if (reasons.has("low_consumption_components")) {
    const candidate = (samples.lowConsumption ?? [])[0];
    if (candidate) {
      out.push({
        action: "report_stale_candidate",
        tool: "kb_report_stale",
        reason: `组件 ${candidate.title} 近 30 天零消费且发布超 30 天，疑似过期；上报 stale_knowledge 反馈由知识运营确认。`,
        payload: { projectId, componentId: candidate.componentId, query: candidate.title, reason: "zero consumption in 30d window" },
      });
    }
  }
  if (out.length === 0) out.push({ action: "publish_if_ready", tool: "kb_publish_if_ready", reason: "未发现阻断项，可请求系统按门禁判断是否发布修订。", payload: { projectId } });
  return out;
}

export function healthComponent(component: { componentId: string; artifactId: string; title: string; kind: string; trust: TrustScore | KnowledgeEnvelopeTrustScore | null }): HealthComponentSummary {
  return {
    componentId: component.componentId,
    artifactId: component.artifactId,
    title: component.title,
    kind: component.kind,
    score: component.trust?.score ?? null,
    status: component.trust?.status ?? "unknown",
    lastTrustedAuditAt: component.trust?.lastTrustedAuditAt ?? null,
  };
}

export function healthCorrection(correction: SourceCorrectionView): HealthCorrectionSummary {
  return {
    correctionId: correction.correctionId,
    state: correction.state,
    componentId: correction.componentId ?? "",
    packageId: correction.packageId ?? "",
    sourcePath: correction.sourcePath,
    ruleId: correction.ruleId,
    factKey: correction.factKey,
    updatedAt: correction.updatedAt,
  };
}

export function auditIsStale(lastTrustedAuditAt: string | null, maxAuditAgeDays: number): boolean {
  if (!lastTrustedAuditAt) return true;
  const at = Date.parse(lastTrustedAuditAt);
  if (!Number.isFinite(at)) return true;
  return Date.now() - at > maxAuditAgeDays * 24 * 60 * 60 * 1000;
}

export function manifestComponentIds(release: ReleaseRecord): string[] {
  return uniqueSorted(jsonArray((release.manifest as Record<string, unknown>).componentIds));
}

export function stringArg(payload: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  throw new Error(`Missing required argument: ${keys[0]}`);
}

export function optionalString(payload: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

export function optionalNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(numeric) ? numeric : null;
}

export function numberArg(payload: Record<string, unknown>, fallback: number, ...keys: string[]): number {
  for (const key of keys) {
    const value = payload[key];
    const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
    if (Number.isFinite(numeric)) return numeric;
  }
  return fallback;
}

export function boundedScoreArg(payload: Record<string, unknown>, fallback: number, ...keys: string[]): number {
  const value = numberArg(payload, fallback, ...keys);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

export function booleanArg(payload: Record<string, unknown>, fallback: boolean, ...keys: string[]): boolean {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes"].includes(normalized)) return true;
      if (["false", "0", "no"].includes(normalized)) return false;
    }
  }
  return fallback;
}

export function boundedLimitArg(value: number, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.min(Math.floor(value), max));
}

export function objectArg(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function normalizeCorrectionValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { value };
}

export function normalizeSourcePath(value: string): string {
  return value.trim().replace(/\\/gu, "/").replace(/^processed\/parsed\//u, "");
}

export function sourceCorrectionFactKey(value: Record<string, unknown>): string | null {
  const direct = String(value.factKey ?? value.fact_key ?? value.field ?? value.key ?? "").trim();
  return direct || null;
}

/** Compare correction cores ignoring volatile metadata fields. */
export function normalizeCorrectionFingerprint(value: Record<string, unknown>): string {
  const skip = new Set(["confidence", "queryContext", "sourceContext", "issue", "actor", "createdAt"]);
  const cleaned: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (skip.has(key)) continue;
    cleaned[key] = raw;
  }
  return JSON.stringify(cleaned, Object.keys(cleaned).sort());
}

export function sourceCorrectionRecord(row: Record<string, unknown>): SourceCorrectionView {
  return {
    correctionId: String(row.correction_id ?? ""),
    projectId: String(row.project_id ?? "default_project"),
    bundleId: String(row.bundle_id ?? ""),
    sourcePath: String(row.source_path ?? ""),
    ruleId: String(row.rule_id ?? ""),
    pageType: String(row.page_type ?? ""),
    factKey: row.fact_key ? String(row.fact_key) : null,
    boundSourceHash: String(row.bound_source_hash ?? ""),
    state: String(row.state ?? ""),
    correctValue: jsonObject(row.correct_value),
    componentId: row.component_id ? String(row.component_id) : null,
    packageId: row.package_id ? String(row.package_id) : null,
    exampleId: String(row.example_id ?? ""),
    taskId: String(row.task_id ?? ""),
    createdBy: String(row.created_by ?? ""),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

export function componentSummary(component: AssetComponent): Record<string, unknown> {
  return {
    componentId: component.componentId,
    packageId: component.packageId,
    artifactId: component.artifactId,
    title: component.title,
    kind: component.kind,
    legacyPath: component.legacyPath,
    sourceRefs: component.sourceRefs,
  };
}

export function correctionTargetForComponent(component: AssetComponent, requestedSourcePath: string, matchMethod: CorrectionAnchorMatchMethod): CorrectionTarget {
  const componentSourcePath = normalizeSourcePath(
    component.sourceRefs.find((ref) => sourceRefLooksLikeSource(ref)) ??
    "",
  );
  const normalizedRequestedSourcePath = normalizeSourcePath(requestedSourcePath);
  const usableRequestedSourcePath = sourceRefLooksLikeSource(normalizedRequestedSourcePath) ? normalizedRequestedSourcePath : "";
  const sourcePath = usableRequestedSourcePath || componentSourcePath || `component:${component.componentId}`;
  const fallback = sourcePath.startsWith("component:");
  return {
    component,
    sourcePath,
    anchor: {
      componentId: component.componentId,
      sourcePath,
      matchMethod: fallback ? "component_fallback" : matchMethod,
      candidates: [],
      confidence: fallback ? "low" : matchMethod === "sourcePath_unique" ? "medium" : "high",
    },
  };
}

export function sourceRefLooksLikeSource(value: string): boolean {
  const normalized = normalizeSourcePath(value);
  return normalized.startsWith("gamedocs/") || normalized.startsWith("gamedata/");
}

export function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "") || "item";
}

export function searchCard(item: OkfSearchResultItem, index: number, evidenceCount: number, match: SearchMatchClassification): Record<string, unknown> {
  const unresolvedDependencies = unresolvedFromWhy(item.why);
  return {
    rank: index + 1,
    title: item.title,
    componentId: item.componentId,
    okfPath: item.okfPath,
    artifactId: item.artifactId,
    kind: item.kind,
    type: item.type,
    snippet: item.snippet,
    score: item.score,
    trust: item.trust,
    evidence: {
      count: evidenceCount,
      traceable: evidenceCount > 0,
      suggestedTool: "kb_get_evidence",
    },
    tableDependencies: item.tableDependencies,
    unresolvedDependencies,
    qualitySignals: {
      matchedFields: item.matchedFields,
      matchedTerms: item.matchedTerms.slice(0, 12),
      matchStatus: index === 0 ? match.status : "supporting_hit",
      missingCoreTerms: index === 0 ? match.missingCoreTerms : [],
      qualityFlags: index === 0 ? match.qualityFlags : [],
      why: item.why,
    },
    suggestedNextTools: pageSuggestedTools(item),
    nextStep: nextStepForSearchItem(item, evidenceCount, unresolvedDependencies),
  };
}

export function searchGuidance(query: string, items: OkfSearchResultItem[], evidenceCounts: Map<string, number>, match: SearchMatchClassification): Record<string, unknown> {
  const top = items[0];
  if (!top) {
    return {
      status: "miss",
      nextStep: `No published knowledge matched "${query}". Report a knowledge gap or import/build source material, then publish again.`,
      suggestedNextTools: ["kb_resolve_topic"],
    };
  }
  if (match.status !== "hit") {
    return {
      status: match.status,
      topComponentId: top.componentId,
      qualityFlags: match.qualityFlags,
      missingCoreTerms: match.missingCoreTerms,
      nextStep: `Only weak/partial matches were found for "${query}". Treat this as insufficient for final answers; call kb_report_gap if the missing topic matters, or refine the query.`,
      suggestedNextTools: ["kb_get_page", "kb_get_evidence", "kb_report_gap"],
    };
  }
  return {
    status: "hit",
    topComponentId: top.componentId,
    nextStep: nextStepForSearchItem(top, evidenceCounts.get(top.componentId) ?? 0, unresolvedFromWhy(top.why)),
    suggestedNextTools: pageSuggestedTools(top),
  };
}

export function unresolvedFromWhy(why: string[]): string[] {
  const prefix = "未解析为具体表：";
  const line = why.find((item) => item.startsWith(prefix));
  return line ? line.slice(prefix.length).split(/,\s*/u).map((item) => item.trim()).filter(Boolean) : [];
}

const GENERIC_SEARCH_TERMS = new Set([
  "系统", "流程", "结构", "活动", "玩法", "规则", "配置", "配置表", "表", "字段", "数据", "资料", "知识",
  "system", "flow", "process", "structure", "activity", "config", "table", "field", "data", "rule",
]);

export function classifySearchMatch(query: string, items: OkfSearchResultItem[]): SearchMatchClassification {
  const top = items[0];
  const coreTerms = tokenizeSearchText(query)
    .filter((term) => term.length >= 2)
    .filter((term) => !GENERIC_SEARCH_TERMS.has(term))
    .slice(0, 20);
  const matched = new Set((top?.matchedTerms ?? []).map(String));
  const matchedCoreTerms = uniqueSorted(coreTerms.filter((term) => matched.has(term)));
  const missingCoreTerms = uniqueSorted(coreTerms.filter((term) => !matched.has(term)));
  const missingCoreSignal = top?.why.some((line) => line.includes("缺少核心词")) ?? false;
  if (!top) {
    return { status: "near_miss", qualityFlags: [], coreTerms, matchedCoreTerms, missingCoreTerms };
  }
  if ((coreTerms.length > 0 && matchedCoreTerms.length === 0) || missingCoreSignal) {
    return {
      status: "near_miss",
      qualityFlags: ["weak_match", "missing_core_terms"],
      coreTerms,
      matchedCoreTerms,
      missingCoreTerms,
    };
  }
  if (coreTerms.length >= 4 && matchedCoreTerms.length / coreTerms.length < 0.35) {
    return {
      status: "low_confidence_hit",
      qualityFlags: ["weak_match"],
      coreTerms,
      matchedCoreTerms,
      missingCoreTerms,
    };
  }
  return { status: "hit", qualityFlags: [], coreTerms, matchedCoreTerms, missingCoreTerms: [] };
}

export function nextStepForSearchItem(item: OkfSearchResultItem, evidenceCount: number, unresolvedDependencies: string[]): string {
  if (unresolvedDependencies.length > 0) return "Call kb_get_page_tables to inspect resolved and unresolved table dependencies before using table data.";
  if (item.tableDependencies.length > 0) return "Call kb_get_page_tables, then kb_get_table_schema or kb_query_table for structured values.";
  if (evidenceCount === 0) return "Call kb_get_evidence; if no records return, treat the answer as lower-traceability and report a gap.";
  return "Call kb_get_page for full context, and kb_get_evidence when citing this knowledge.";
}

export function pageSuggestedTools(item: { matchedFields?: unknown; tableDependencies?: unknown }): string[] {
  const fields = Array.isArray(item.matchedFields) ? item.matchedFields.map(String) : [];
  const tools = ["kb_get_page", "kb_get_evidence", "kb_get_quality"];
  if (fields.includes("tables") || fields.includes("dataDependencies") || (Array.isArray(item.tableDependencies) && item.tableDependencies.length > 0)) {
    tools.push("kb_get_page_tables");
  }
  return tools;
}

export function nextStepForTarget(target: { type?: unknown; title?: unknown; id?: unknown }): string {
  const title = String(target.title ?? target.id ?? "");
  if (target.type === "table") return `Use kb_get_table_schema for ${title}, then kb_query_table if row data is needed.`;
  if (target.type === "entity") return `Use kb_get_entity for ${title}, then kb_get_neighbors to inspect related pages and tables.`;
  if (target.type === "page") return `Use kb_get_page for ${title}; call kb_get_page_tables when tableDependencies are present.`;
  return "Use kb_search with a more specific topic.";
}

export function inferTableFieldMapping(schema: TableSchema, grid: unknown[][]): {
  fieldMap: Record<string, TableFieldMapping>;
  rawKeys: string[];
  headerRowIndex: number;
  dataStartIndex: number;
  unmappedRawColumns: string[];
  diagnostics: string[];
} {
  const fields = schema.fields ?? [];
  const maxCols = grid.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), fields.length);
  const headerRowIndex = chooseHeaderRow(fields, grid);
  const labelRowIndex = chooseLabelRow(grid, headerRowIndex);
  const rawKeys = uniqueRawKeys(Array.from({ length: maxCols }, (_, columnIndex) => {
    const label = normalizeCellValue(grid[labelRowIndex]?.[columnIndex]);
    const header = normalizeCellValue(grid[headerRowIndex]?.[columnIndex]);
    return label || header || `column_${columnIndex + 1}`;
  }));
  const fieldMap: Record<string, TableFieldMapping> = {};
  const usedColumns = new Set<number>();
  const fieldByKey = new Map(fields.map((field) => [aliasKey(field), field] as const));
  const headerRow = grid[headerRowIndex] ?? [];

  for (let columnIndex = 0; columnIndex < maxCols; columnIndex += 1) {
    const headerValue = normalizeCellValue(headerRow[columnIndex]);
    const field = fieldByKey.get(aliasKey(headerValue));
    if (!field || fieldMap[field]) continue;
    fieldMap[field] = { rawKey: rawKeys[columnIndex], columnIndex, headerValue, matchMethod: "header" };
    usedColumns.add(columnIndex);
  }

  for (const [fieldIndex, field] of fields.entries()) {
    if (fieldMap[field]) continue;
    if (fieldIndex >= maxCols || usedColumns.has(fieldIndex)) continue;
    fieldMap[field] = {
      rawKey: rawKeys[fieldIndex],
      columnIndex: fieldIndex,
      headerValue: normalizeCellValue(headerRow[fieldIndex]),
      matchMethod: "schema_order",
    };
    usedColumns.add(fieldIndex);
  }

  const unmappedRawColumns = rawKeys.filter((rawKey, columnIndex) =>
    !usedColumns.has(columnIndex) && grid.some((row) => normalizeCellValue(row[columnIndex]) !== "")
  );
  const missingFields = fields.filter((field) => !(field in fieldMap));
  const diagnostics: string[] = [];
  if (fields.length === 0) diagnostics.push("schema has no fields");
  const orderedFallbackFields = Object.entries(fieldMap)
    .filter(([, mapping]) => mapping.matchMethod === "schema_order")
    .map(([field]) => field);
  if (orderedFallbackFields.length > 0) {
    diagnostics.push(`mapped by schema field order: ${orderedFallbackFields.join(", ")}`);
  }
  if (missingFields.length > 0) diagnostics.push(`unmapped schema fields: ${missingFields.join(", ")}`);
  if (unmappedRawColumns.length > 0) diagnostics.push(`unmapped raw columns: ${unmappedRawColumns.join(", ")}`);

  return {
    fieldMap,
    rawKeys,
    headerRowIndex,
    dataStartIndex: Math.min(grid.length, headerRowIndex + 1),
    unmappedRawColumns,
    diagnostics,
  };
}

export function chooseHeaderRow(fields: string[], grid: unknown[][]): number {
  if (grid.length === 0) return 0;
  const fieldKeys = new Set(fields.map(aliasKey));
  let best = { row: 0, score: -1 };
  const scanRows = Math.min(grid.length, 12);
  for (let rowIndex = 0; rowIndex < scanRows; rowIndex += 1) {
    const row = grid[rowIndex] ?? [];
    const nonEmpty = row.map(normalizeCellValue).filter(Boolean);
    if (nonEmpty.length === 0) continue;
    const directMatches = nonEmpty.filter((value) => fieldKeys.has(aliasKey(value))).length;
    const technicalNames = nonEmpty.filter((value) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)).length;
    const score = directMatches * 20 + technicalNames - Math.max(0, nonEmpty.length - fields.length);
    if (score > best.score) best = { row: rowIndex, score };
  }
  return best.row;
}

export function chooseLabelRow(grid: unknown[][], headerRowIndex: number): number {
  for (let rowIndex = 0; rowIndex < headerRowIndex; rowIndex += 1) {
    if ((grid[rowIndex] ?? []).some((value) => normalizeCellValue(value) !== "")) return rowIndex;
  }
  return headerRowIndex;
}

export function uniqueRawKeys(keys: string[]): string[] {
  const seen = new Map<string, number>();
  return keys.map((key, index) => {
    const normalized = key || `column_${index + 1}`;
    const count = seen.get(normalized) ?? 0;
    seen.set(normalized, count + 1);
    return count === 0 ? normalized : `${normalized}_${count + 1}`;
  });
}

export function rawRowFromGridRow(row: unknown[], rawKeys: string[]): Record<string, unknown> {
  return Object.fromEntries(rawKeys.map((rawKey, columnIndex) => [rawKey, row[columnIndex] ?? ""]));
}

export function normalizeCellValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

export function normalize(value: string): string {
  return value.toLowerCase().replace(/\\/gu, "/").replace(/\s+/gu, " ").trim();
}

export function aliasKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/[\s_\-()[\]（）【】{}《》:：,，.。/\\]+/gu, "");
}

export function same(a: string | undefined, b: string | undefined): boolean {
  return normalize(a ?? "") === normalize(b ?? "");
}

export function walkMarkdown(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out.sort();
}

export function parseOkfPage(okfPath: string, markdown: string): OkfPage | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(markdown);
  if (!match) return null;
  const frontmatter = match[1];
  const body = match[2];
  const componentId = yamlScalar(frontmatter, "componentId");
  const artifactId = yamlScalar(frontmatter, "artifactId") || okfPath.replace(/^\//u, "");
  return {
    okfPath,
    markdown,
    body,
    title: yamlScalar(frontmatter, "title") || okfPath.split("/").pop()?.replace(/\.md$/u, "") || okfPath,
    description: yamlScalar(frontmatter, "description"),
    type: yamlScalar(frontmatter, "type") || "knowledge_note",
    componentId,
    packageId: yamlScalar(frontmatter, "packageId"),
    artifactId,
    kind: okfKind(frontmatter, artifactId),
    trust: parseOkfTrust(frontmatter),
    citations: parseOkfCitations(body, componentId, okfPath),
  };
}

export function pageLookupKeys(page: OkfPage): string[] {
  const basename = page.okfPath.split("/").pop() ?? "";
  return uniqueOrdered([
    page.componentId,
    page.title,
    stripMarkdownExtension(page.title),
    page.description,
    firstMarkdownHeading(page.body),
    page.artifactId,
    stripMarkdownExtension(page.artifactId),
    page.artifactId.replace(/^wiki\//u, ""),
    stripMarkdownExtension(page.artifactId.replace(/^wiki\//u, "")),
    page.okfPath,
    page.okfPath.replace(/^\//u, ""),
    basename,
    stripMarkdownExtension(basename),
  ]).filter(Boolean);
}

export function stripMarkdownExtension(value: string): string {
  return value.replace(/\.md$/iu, "");
}

export function firstMarkdownHeading(markdown: string): string {
  return /^#\s+(.+?)\s*$/mu.exec(markdown)?.[1]?.trim() ?? "";
}

export function parseOkfTrust(frontmatter: string): TrustScore | null {
  const score = numberScalar(frontmatter, "score");
  const version = yamlScalar(frontmatter, "version");
  if (score === null || version !== "v2-lite") return null;
  return {
    version: "v2-lite",
    score,
    status: statusScalar(yamlScalar(frontmatter, "status")),
    breakdown: {
      evidence: numberScalar(frontmatter, "evidence") ?? 0,
      completeness: numberScalar(frontmatter, "completeness") ?? 0,
      auditFreshness: numberScalar(frontmatter, "auditFreshness") ?? 0,
      consistency: numberScalar(frontmatter, "consistency") ?? 0,
    },
    caps: [],
    reasons: [],
    lastTrustedAuditAt: yamlScalar(frontmatter, "lastTrustedAuditAt") || null,
    auditHalfLifeDays: 180,
    evidenceRequired: true,
  };
}

export function parseOkfCitations(body: string, componentId: string, okfPath: string): OkfCitation[] {
  const lines = body.split(/\r?\n/u);
  const headingIndex = lines.findIndex((line) => /^#\s+(Citations|引用|证据)\s*$/iu.test(line.trim()));
  if (headingIndex < 0) return [];
  const out: OkfCitation[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (/^#\s+\S/u.test(line)) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^\d+\.\s+(.+?)(?:\s+\((.+)\))?$/u.exec(trimmed);
    if (!match) continue;
    const meta = match[2] ?? "";
    const idMatch = /(^|;\s*)([^;()\s]+)(?=;|$)/u.exec(meta);
    const sourceMatch = /source\s+([^;()\s]+)/iu.exec(meta);
    const confidenceMatch = /confidence\s+([0-9.]+)/iu.exec(meta);
    out.push({
      evidenceId: idMatch?.[2] ?? `okf:${componentId}:${out.length + 1}`,
      componentId,
      sourceVersionId: sourceMatch?.[1] ?? "",
      quote: match[1].trim(),
      note: "OKF citation",
      confidence: confidenceMatch ? Number(confidenceMatch[1]) : null,
      okfPath,
    });
  }
  return out;
}

export function yamlScalar(frontmatter: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^(?:${escaped}|\\s+${escaped}):\\s*(.+?)\\s*$`, "mu").exec(frontmatter);
  if (!match) return "";
  const raw = match[1].trim();
  try {
    return String(JSON.parse(raw));
  } catch {
    return raw.replace(/^["']|["']$/gu, "");
  }
}

export function numberScalar(frontmatter: string, key: string): number | null {
  const value = yamlScalar(frontmatter, key);
  return value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
}

export function statusScalar(value: string): TrustScore["status"] {
  return value === "trusted" || value === "usable_with_risk" || value === "needs_review" || value === "blocked" ? value : "needs_review";
}

export function okfKind(frontmatter: string, artifactId: string): string {
  const tags = yamlScalar(frontmatter, "tags");
  for (const kind of ["wiki_page", "table_wiki_page"]) {
    if (tags.includes(kind)) return kind;
  }
  if (artifactId.startsWith("wiki/tables/")) return "table_wiki_page";
  return "wiki_page";
}

export function scoreText(haystack: string, query: string): number {
  return query.toLowerCase().split(/\s+/u).filter(Boolean).reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

export function snippet(markdown: string, query: string): string {
  const tokens = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const lines = markdown.split(/\r?\n/u);
  return lines.find((line) => tokens.some((token) => line.toLowerCase().includes(token)))?.slice(0, 240) ?? lines.find(Boolean)?.slice(0, 240) ?? "";
}

export function extractDependencyText(markdown: string): { text: string; hasDependencySection: boolean } {
  const sections = parseMarkdownSections(markdown);
  const dependencySections = sections.filter((section) => dependencyHeading(section.heading));
  return {
    text: dependencySections.map((section) => section.content).join("\n"),
    hasDependencySection: dependencySections.length > 0,
  };
}

export function parseMarkdownSections(markdown: string): Array<{ heading: string; content: string }> {
  const lines = markdown.split(/\r?\n/u);
  const out: Array<{ heading: string; content: string }> = [];
  let current: { heading: string; lines: string[] } | null = null;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) {
      if (current) out.push({ heading: current.heading, content: current.lines.join("\n").trim() });
      current = { heading: heading[2].trim(), lines: [] };
      continue;
    }
    current?.lines.push(line);
  }
  if (current) out.push({ heading: current.heading, content: current.lines.join("\n").trim() });
  return out;
}

export function dependencyHeading(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "data dependencies" || ["配置表依赖", "关联配置表", "数据依赖", "表依赖"].includes(normalized);
}

export function dependencyCandidates(text: string): string[] {
  const out = new Set<string>();
  for (const cleanedLine of dependencyLines(text)) {
    out.add(cleanedLine);
    for (const match of cleanedLine.matchAll(/[A-Za-z][A-Za-z0-9_/-]*/gu)) out.add(match[0]);
    for (const match of cleanedLine.matchAll(/[\p{Script=Han}]{2,}/gu)) out.add(match[0]);
    for (const match of cleanedLine.matchAll(/[（(]([A-Za-z][A-Za-z0-9_/-]*)[）)]/gu)) out.add(match[1]);
  }
  return uniqueSorted([...out]);
}

export function dependencyLines(text: string): string[] {
  if (!text.trim()) return [];
  const out: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    let cleanedLine = line.replace(/\|/gu, " ").trim();
    while (/^(?:[-*+]|\d+[.)、])\s+/u.test(cleanedLine)) {
      cleanedLine = cleanedLine.replace(/^(?:[-*+]|\d+[.)、])\s+/u, "").trim();
    }
    if (!cleanedLine || /^无[。.]?$/u.test(cleanedLine)) continue;
    if (/^\d+\s*[-~–—]\s*\d+.*[:：]/u.test(cleanedLine)) continue;
    out.push(cleanedLine);
  }
  return uniqueSorted(out);
}

export function resolveCandidateTables(candidate: string, schemasByName: Map<string, TableSchemaEntry>, aliases: Map<string, TableSchemaEntry[]>): TableSchemaEntry[] {
  const key = aliasKey(candidate);
  if (!key) return [];
  const exact = schemasByName.get(key);
  if (exact) return [exact];
  if (isGenericDependencyKey(key)) return [];
  const aliased = aliases.get(key);
  if (aliased?.length) return aliased;
  const containedSchemas = [...schemasByName.entries()]
    .filter(([tableKey]) => tableKey.length >= 4 && key.includes(tableKey))
    .map(([, entry]) => entry);
  if (containedSchemas.length) return uniqueTableEntries(containedSchemas);
  const containedAliases = [...aliases.entries()]
    .filter(([alias]) => actionableAliasKey(alias) && key.includes(alias))
    .flatMap(([, entries]) => entries);
  return uniqueTableEntries(containedAliases);
}

export function schemaEntriesForAliasTarget(value: string, schemasByName: Map<string, TableSchemaEntry>): TableSchemaEntry[] {
  const key = aliasKey(value);
  if (!key) return [];
  const exact = schemasByName.get(key);
  if (exact) return [exact];
  if (isGenericDependencyKey(key)) return [];
  if (!actionableAliasKey(key)) return [];
  const candidates = [...schemasByName.entries()]
    .filter(([tableKey]) => tableKey.includes(key))
    .map(([, entry]) => entry)
    .sort((a, b) => a.schema.table_name.length - b.schema.table_name.length || a.schema.table_name.localeCompare(b.schema.table_name));
  return uniqueTableEntries(candidates.slice(0, 12));
}

export function actionableAliasKey(value: string): boolean {
  return value.length >= 4 || /[\p{Script=Han}]{2,}/u.test(value);
}

export function isGenericDependencyKey(value: string): boolean {
  return ["config", "配置", "table", "表", "data", "数据", "配置表", "config表"].includes(value);
}

export function looksLikeDependencyToken(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /^无[。.]?$/u.test(trimmed)) return false;
  if (trimmed.length > 80) return false;
  return /[A-Za-z\p{Script=Han}]/u.test(trimmed);
}

export function dependencyHint(dependency: string): { dependency: string; kind: string; suggestedAction: string } {
  const key = aliasKey(dependency);
  if (key.includes("config") || key.includes("配置")) {
    return {
      dependency,
      kind: "generic_config",
      suggestedAction: "补充具体配置表名或维护别名映射后重新构建发布。",
    };
  }
  if (key.includes("fight") || key.includes("战斗")) {
    return {
      dependency,
      kind: "runtime_or_domain_data",
      suggestedAction: "确认这是运行时数据、图谱实体还是具体表；如需查表请补具体 schema 名。",
    };
  }
  if (key.includes("task") || key.includes("任务")) {
    return {
      dependency,
      kind: "generic_task",
      suggestedAction: "补充具体任务配置表名或维护任务类表别名。",
    };
  }
  if (/^[a-z][a-z0-9_/.-]*$/iu.test(dependency.trim())) {
    return {
      dependency,
      kind: "missing_schema_or_alias",
      suggestedAction: "该名称未解析到当前发布的表 schema；检查表是否进入 OKF bundle 或补充别名。",
    };
  }
  return {
    dependency,
    kind: "concept_dependency",
    suggestedAction: "作为概念依赖使用；需要 Agent 查表时应补充具体表名。",
  };
}

export function uniqueTableEntries(values: TableSchemaEntry[]): TableSchemaEntry[] {
  const seen = new Set<string>();
  const out: TableSchemaEntry[] = [];
  for (const value of values) {
    if (seen.has(value.schema.table_name)) continue;
    seen.add(value.schema.table_name);
    out.push(value);
  }
  return out.sort((a, b) => a.schema.table_name.localeCompare(b.schema.table_name));
}

export function extractSection(markdown: string, section: string): string | null {
  const lines = markdown.split(/\r?\n/u);
  const target = normalize(section);
  let start = -1;
  let level = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.+)$/u.exec(lines[index]);
    if (!match) continue;
    if (start >= 0 && match[1].length <= level) return lines.slice(start, index).join("\n").trim();
    if (start < 0 && normalize(match[2]) === target) {
      start = index + 1;
      level = match[1].length;
    }
  }
  return start >= 0 ? lines.slice(start).join("\n").trim() : null;
}

export function numberFromQuality(quality: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = quality[key];
    if (typeof value === "number") return value;
    if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

export function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

export function uniqueOrdered(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
