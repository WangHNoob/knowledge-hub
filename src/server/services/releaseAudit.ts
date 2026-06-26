import type { DatabaseAdapter } from "../db-adapter";
import type { AssetComponent, AssetPackage, ReleaseRecord, TrustScore } from "../types";
import { trustFromQuality } from "./trustScore";
import type { ConformanceReport } from "./okf/types";

export interface ReleaseAuditSummary {
  version: 1;
  generatedAt: string;
  release: {
    releaseId: string;
    version: string;
    publishedAt: string;
    publishedBy: string;
  };
  sources: {
    sourceVersionIds: string[];
    packageCount: number;
    componentCount: number;
    packages: Array<{ packageId: string; name: string; status: string; sourceVersionIds: string[] }>;
  };
  build: {
    runCount: number;
    completed: number;
    failed: number;
    running: number;
    cachedStages: number;
    runs: Array<{
      runId: string;
      sourceVersionId: string;
      status: string;
      stages: string[];
      completedStages: string[];
      startedAt: string;
      finishedAt: string | null;
      durationMs: number | null;
    }>;
  };
  assets: {
    byGroup: Record<string, number>;
    byKind: Record<string, number>;
  };
  evidence: {
    requiredComponents: number;
    coveredComponents: number;
    missingComponents: number;
    evidenceRecords: number;
    coverageRate: number;
  };
  trust: {
    averageScore: number | null;
    minScore: number | null;
    statusCounts: Record<string, number>;
    lowTrustComponents: Array<{
      componentId: string;
      title: string;
      artifactId: string;
      kind: string;
      score: number | null;
      status: string;
      reasons: string[];
    }>;
  };
  review: {
    open: number;
    blocking: number;
    warning: number;
    info: number;
    resolvedSincePreviousRelease: number;
    topOpenTasks: Array<{
      taskId: string;
      componentId: string;
      severity: string;
      title: string;
      suggestedAction: string;
    }>;
  };
  agentFeedback: {
    windowStart: string | null;
    windowEnd: string;
    mcpCalls: number;
    mcpMisses: number;
    mcpErrors: number;
    feedbackEvents: number;
    feedbackByType: Record<string, number>;
    topQueries: Array<{ query: string; count: number }>;
  };
  qualityGate: Record<string, unknown>;
  legislationProfileHash: string;
  okf?: {
    summary: ConformanceReport["summary"];
    linkSummary: ConformanceReport["linkSummary"];
    citationSummary: ConformanceReport["citationSummary"];
    conceptCount: number;
    reportUri: string;
    reportMarkdownUri: string;
  };
}

const EVIDENCE_REQUIRED_KINDS = new Set(["wiki_page"]);

export async function buildReleaseAuditSummary(input: {
  adapter: DatabaseAdapter;
  release: ReleaseRecord;
  packages: AssetPackage[];
  components: AssetComponent[];
  publishedAt: string;
  publishedBy: string;
  qualityGate: Record<string, unknown>;
  legislationProfileHash: string;
}): Promise<ReleaseAuditSummary> {
  const packageIds = input.packages.map((pkg) => pkg.packageId);
  const componentIds = input.components.map((component) => component.componentId);
  const previousPublishedAt = await latestPublishedAtBefore(input.adapter, input.publishedAt, input.release.releaseId);
  const [build, evidence, review, agentFeedback] = await Promise.all([
    buildSummary(input.adapter, input.packages),
    evidenceSummary(input.adapter, input.components),
    reviewSummary(input.adapter, packageIds, previousPublishedAt),
    agentFeedbackSummary(input.adapter, previousPublishedAt, input.publishedAt),
  ]);
  const trust = trustSummary(input.components);

  return {
    version: 1,
    generatedAt: input.publishedAt,
    release: {
      releaseId: input.release.releaseId,
      version: input.release.version,
      publishedAt: input.publishedAt,
      publishedBy: input.publishedBy,
    },
    sources: {
      sourceVersionIds: uniqueSorted(input.packages.flatMap((pkg) => pkg.sourceVersionIds)),
      packageCount: input.packages.length,
      componentCount: componentIds.length,
      packages: input.packages.map((pkg) => ({
        packageId: pkg.packageId,
        name: pkg.name,
        status: pkg.status,
        sourceVersionIds: pkg.sourceVersionIds,
      })),
    },
    build,
    assets: {
      byGroup: countBy(input.components, (component) => component.group),
      byKind: countBy(input.components, (component) => component.kind),
    },
    evidence,
    trust,
    review,
    agentFeedback,
    qualityGate: input.qualityGate,
    legislationProfileHash: input.legislationProfileHash,
  };
}

export function withOkfAuditSummary(
  audit: ReleaseAuditSummary,
  report: ConformanceReport,
  uris: { reportUri: string; reportMarkdownUri: string },
): ReleaseAuditSummary {
  return {
    ...audit,
    okf: {
      summary: report.summary,
      linkSummary: report.linkSummary,
      citationSummary: report.citationSummary,
      conceptCount: report.conceptCount,
      reportUri: uris.reportUri,
      reportMarkdownUri: uris.reportMarkdownUri,
    },
  };
}

export function renderReleaseAuditLog(audit: ReleaseAuditSummary): string {
  const lines = [
    "# Release Audit Log",
    "",
    "## Release",
    "",
    `- releaseId: ${audit.release.releaseId}`,
    `- version: ${audit.release.version}`,
    `- publishedAt: ${audit.release.publishedAt}`,
    `- publishedBy: ${audit.release.publishedBy}`,
    `- legislationProfileHash: ${audit.legislationProfileHash || "none"}`,
    "",
    "## Source Snapshot",
    "",
    `- packages: ${audit.sources.packageCount}`,
    `- components: ${audit.sources.componentCount}`,
    `- sourceVersions: ${audit.sources.sourceVersionIds.join(", ") || "none"}`,
    "",
    ...audit.sources.packages.map((pkg) => `- ${pkg.name} (${pkg.packageId}, ${pkg.status}) -> ${pkg.sourceVersionIds.join(", ") || "no source version"}`),
    "",
    "## Build Pipeline",
    "",
    `- runs: ${audit.build.runCount}`,
    `- completed: ${audit.build.completed}`,
    `- failed: ${audit.build.failed}`,
    `- running: ${audit.build.running}`,
    `- cachedStages: ${audit.build.cachedStages}`,
    "",
    ...audit.build.runs.map((run) => `- ${run.runId}: ${run.status}, completed ${run.completedStages.length}/${run.stages.length} stages, duration ${run.durationMs ?? "unknown"}ms`),
    "",
    "## Assets",
    "",
    ...renderCountMap("group", audit.assets.byGroup),
    "",
    ...renderCountMap("kind", audit.assets.byKind),
    "",
    "## Evidence",
    "",
    `- requiredComponents: ${audit.evidence.requiredComponents}`,
    `- coveredComponents: ${audit.evidence.coveredComponents}`,
    `- missingComponents: ${audit.evidence.missingComponents}`,
    `- evidenceRecords: ${audit.evidence.evidenceRecords}`,
    `- coverageRate: ${Math.round(audit.evidence.coverageRate * 100)}%`,
    "",
    "## Trust Score",
    "",
    `- averageScore: ${audit.trust.averageScore ?? "none"}`,
    `- minScore: ${audit.trust.minScore ?? "none"}`,
    ...renderCountMap("status", audit.trust.statusCounts),
    "",
    ...audit.trust.lowTrustComponents.map((component) => `- ${component.title} (${component.componentId}): ${component.score ?? "none"} / ${component.status}; ${component.reasons.slice(0, 2).join("; ") || "no reason"}`),
    "",
    "## Review",
    "",
    `- open: ${audit.review.open}`,
    `- blocking: ${audit.review.blocking}`,
    `- warning: ${audit.review.warning}`,
    `- info: ${audit.review.info}`,
    `- resolvedSincePreviousRelease: ${audit.review.resolvedSincePreviousRelease}`,
    "",
    ...audit.review.topOpenTasks.map((task) => `- [${task.severity}] ${task.title} (${task.taskId}) -> ${task.suggestedAction || "review manually"}`),
    "",
    "## Agent Feedback",
    "",
    `- windowStart: ${audit.agentFeedback.windowStart ?? "first release"}`,
    `- windowEnd: ${audit.agentFeedback.windowEnd}`,
    `- mcpCalls: ${audit.agentFeedback.mcpCalls}`,
    `- mcpMisses: ${audit.agentFeedback.mcpMisses}`,
    `- mcpErrors: ${audit.agentFeedback.mcpErrors}`,
    `- feedbackEvents: ${audit.agentFeedback.feedbackEvents}`,
    ...renderCountMap("feedback", audit.agentFeedback.feedbackByType),
    "",
    ...audit.agentFeedback.topQueries.map((query) => `- ${query.query}: ${query.count}`),
    "",
    "## OKF",
    "",
    audit.okf
      ? `- blocking: ${audit.okf.summary.blocking}`
      : "- blocking: pending",
    audit.okf
      ? `- warning: ${audit.okf.summary.warning}`
      : "- warning: pending",
    audit.okf
      ? `- citations: ${audit.okf.citationSummary.present}/${audit.okf.citationSummary.required}`
      : "- citations: pending",
    audit.okf
      ? `- links: ${audit.okf.linkSummary.resolved} resolved, ${audit.okf.linkSummary.unresolved} unresolved`
      : "- links: pending",
    audit.okf
      ? `- report: ${audit.okf.reportUri}`
      : "- report: pending",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

async function latestPublishedAtBefore(adapter: DatabaseAdapter, publishedAt: string, releaseId: string): Promise<string | null> {
  const { rows } = await adapter.query(
    `SELECT published_at
     FROM releases
     WHERE status = 'published'
       AND release_id <> $1
       AND published_at IS NOT NULL
       AND published_at < $2
     ORDER BY published_at DESC
     LIMIT 1`,
    [releaseId, publishedAt],
  );
  return rows[0]?.published_at ? timestampString(rows[0].published_at) : null;
}

async function buildSummary(adapter: DatabaseAdapter, packages: AssetPackage[]): Promise<ReleaseAuditSummary["build"]> {
  const runIds = uniqueSorted(packages.map((pkg) => pkg.createdByRunId));
  if (runIds.length === 0) {
    return { runCount: 0, completed: 0, failed: 0, running: 0, cachedStages: 0, runs: [] };
  }
  const placeholders = runIds.map((_, index) => `$${index + 1}`).join(",");
  const { rows } = await adapter.query(
    `SELECT run_id, source_version_id, status, stages, completed_stages, started_at, finished_at
     FROM knowledge_build_runs
     WHERE run_id IN (${placeholders})
     ORDER BY started_at DESC`,
    runIds,
  );
  const runs = rows.map((row) => {
    const stages = jsonArray(row.stages);
    const completedStages = jsonArray(row.completed_stages);
    const startedAt = timestampString(row.started_at);
    const finishedAt = row.finished_at ? timestampString(row.finished_at) : null;
    return {
      runId: String(row.run_id ?? ""),
      sourceVersionId: String(row.source_version_id ?? ""),
      status: String(row.status ?? ""),
      stages,
      completedStages,
      startedAt,
      finishedAt,
      durationMs: finishedAt && startedAt ? Math.max(new Date(finishedAt).getTime() - new Date(startedAt).getTime(), 0) : null,
    };
  });
  return {
    runCount: runs.length,
    completed: runs.filter((run) => run.status === "completed").length,
    failed: runs.filter((run) => run.status === "failed").length,
    running: runs.filter((run) => run.status === "running").length,
    cachedStages: runs.reduce((sum, run) => sum + Math.max(run.stages.length - run.completedStages.length, 0), 0),
    runs,
  };
}

async function evidenceSummary(adapter: DatabaseAdapter, components: AssetComponent[]): Promise<ReleaseAuditSummary["evidence"]> {
  const requiredComponentIds = components.filter((component) => EVIDENCE_REQUIRED_KINDS.has(component.kind)).map((component) => component.componentId);
  if (requiredComponentIds.length === 0) {
    return { requiredComponents: 0, coveredComponents: 0, missingComponents: 0, evidenceRecords: 0, coverageRate: 1 };
  }
  const placeholders = requiredComponentIds.map((_, index) => `$${index + 1}`).join(",");
  const { rows } = await adapter.query(
    `SELECT component_id, COUNT(*)::int AS records
     FROM evidence_records
     WHERE component_id IN (${placeholders})
     GROUP BY component_id`,
    requiredComponentIds,
  );
  const covered = rows.filter((row) => Number(row.records ?? 0) > 0).length;
  const records = rows.reduce((sum, row) => sum + Number(row.records ?? 0), 0);
  return {
    requiredComponents: requiredComponentIds.length,
    coveredComponents: covered,
    missingComponents: Math.max(requiredComponentIds.length - covered, 0),
    evidenceRecords: records,
    coverageRate: covered / requiredComponentIds.length,
  };
}

async function reviewSummary(adapter: DatabaseAdapter, packageIds: string[], previousPublishedAt: string | null): Promise<ReleaseAuditSummary["review"]> {
  if (packageIds.length === 0) {
    return { open: 0, blocking: 0, warning: 0, info: 0, resolvedSincePreviousRelease: 0, topOpenTasks: [] };
  }
  const placeholders = packageIds.map((_, index) => `$${index + 1}`).join(",");
  const { rows } = await adapter.query(
    `SELECT task_id, component_id, severity, status, title, suggested_action, resolved_at
     FROM review_tasks
     WHERE package_id IN (${placeholders})
     ORDER BY CASE severity WHEN 'blocking' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at
     LIMIT 200`,
    packageIds,
  );
  const openRows = rows.filter((row) => String(row.status) === "open");
  const resolvedSincePreviousRelease = rows.filter((row) =>
    String(row.status) !== "open"
    && row.resolved_at
    && (!previousPublishedAt || new Date(timestampString(row.resolved_at)).getTime() >= new Date(previousPublishedAt).getTime())
  ).length;
  return {
    open: openRows.length,
    blocking: openRows.filter((row) => String(row.severity) === "blocking").length,
    warning: openRows.filter((row) => String(row.severity) === "warning").length,
    info: openRows.filter((row) => String(row.severity) === "info").length,
    resolvedSincePreviousRelease,
    topOpenTasks: openRows.slice(0, 8).map((row) => ({
      taskId: String(row.task_id ?? ""),
      componentId: String(row.component_id ?? ""),
      severity: String(row.severity ?? ""),
      title: String(row.title ?? ""),
      suggestedAction: String(row.suggested_action ?? ""),
    })),
  };
}

async function agentFeedbackSummary(adapter: DatabaseAdapter, previousPublishedAt: string | null, publishedAt: string): Promise<ReleaseAuditSummary["agentFeedback"]> {
  const params: unknown[] = [publishedAt];
  const windowClause = previousPublishedAt ? `created_at >= $2 AND created_at <= $1` : `created_at <= $1`;
  if (previousPublishedAt) params.push(previousPublishedAt);
  const [mcp, feedback, queries] = await Promise.all([
    adapter.query(`SELECT status, COUNT(*)::int AS count FROM mcp_audit WHERE ${windowClause} GROUP BY status`, params),
    adapter.query(`SELECT feedback_type, COUNT(*)::int AS count FROM agent_events WHERE ${windowClause} GROUP BY feedback_type`, params),
    adapter.query(
      `SELECT query, COUNT(*)::int AS count
       FROM agent_events
       WHERE ${windowClause} AND query <> ''
       GROUP BY query
       ORDER BY count DESC, query
       LIMIT 5`,
      params,
    ),
  ]);
  const mcpStatus = Object.fromEntries(mcp.rows.map((row) => [String(row.status ?? ""), Number(row.count ?? 0)]));
  const feedbackByType = Object.fromEntries(feedback.rows.map((row) => [String(row.feedback_type ?? ""), Number(row.count ?? 0)]));
  return {
    windowStart: previousPublishedAt,
    windowEnd: publishedAt,
    mcpCalls: Object.values(mcpStatus).reduce((sum, count) => sum + count, 0),
    mcpMisses: mcpStatus.miss ?? 0,
    mcpErrors: mcpStatus.error ?? 0,
    feedbackEvents: Object.values(feedbackByType).reduce((sum, count) => sum + count, 0),
    feedbackByType,
    topQueries: queries.rows.map((row) => ({ query: String(row.query ?? ""), count: Number(row.count ?? 0) })),
  };
}

function trustSummary(components: AssetComponent[]): ReleaseAuditSummary["trust"] {
  const items = components
    .map((component) => ({ component, trust: trustFromQuality(component.quality) }))
    .filter((item): item is { component: AssetComponent; trust: TrustScore } => Boolean(item.trust));
  const scores = items.map((item) => item.trust.score).filter((score) => Number.isFinite(score));
  return {
    averageScore: scores.length ? round2(scores.reduce((sum, score) => sum + score, 0) / scores.length) : null,
    minScore: scores.length ? Math.min(...scores) : null,
    statusCounts: countBy(items, (item) => item.trust.status),
    lowTrustComponents: items
      .sort((a, b) => a.trust.score - b.trust.score || a.component.title.localeCompare(b.component.title))
      .slice(0, 8)
      .map(({ component, trust }) => ({
        componentId: component.componentId,
        title: component.title,
        artifactId: component.artifactId,
        kind: component.kind,
        score: trust.score,
        status: trust.status,
        reasons: trust.reasons,
      })),
  };
}

function renderCountMap(label: string, counts: Record<string, number>): string[] {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return [`- ${label}: none`];
  return entries.map(([key, value]) => `- ${label}.${key}: ${value}`);
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    const value = key(item) || "unknown";
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function jsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function timestampString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return value ? String(value) : "";
}
