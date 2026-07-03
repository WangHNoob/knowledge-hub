import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { nanoid } from "nanoid";

import { emitKnowledgeEvent, onKnowledgeEvent } from "./eventService";
import type { KbBuilderPipelineService } from "./kbBuilderService";
import type { KnowledgeLintReport } from "./okf/lintService";
import type {
  DatabaseHandle,
  KnowledgeLintRemediation,
  LintRemediationStatus,
  LintRemediationSummary,
} from "../types";

export function createLintRemediationService(db: DatabaseHandle): LintRemediationService {
  return new LintRemediationService(db);
}

export function registerLintRemediationAutomation(options: {
  db: DatabaseHandle;
  lintRemediationService: LintRemediationService;
  kbBuilderService: Pick<KbBuilderPipelineService, "startScopedRebuildForComponent">;
  requestedBy?: string;
}): () => void {
  const offRecorded = onKnowledgeEvent("knowledge_lint.remediations_recorded", (event) => {
    void options.lintRemediationService.executePending({
      projectId: String(event.payload.projectId ?? "default_project"),
      releaseId: String(event.payload.releaseId ?? ""),
      requestedBy: options.requestedBy ?? "system",
      kbBuilderService: options.kbBuilderService,
    });
  });
  const offBuildCompleted = onKnowledgeEvent("build.completed", (event) => {
    void options.lintRemediationService.markCompletedByRunId(String(event.payload.runId ?? event.entityId ?? ""));
  });
  const offBuildFailed = onKnowledgeEvent("build.failed", (event) => {
    void options.lintRemediationService.markFailedByRunId(
      String(event.payload.runId ?? event.entityId ?? ""),
      String(event.payload.error ?? "构建失败"),
    );
  });
  return () => {
    offRecorded();
    offBuildCompleted();
    offBuildFailed();
  };
}

/**
 * 阶段4 治理队列服务。把一次发布的 Knowledge Lint 报告落成可追踪的治理任务：
 * - governance.autoEligible=true → status "pending"，进入自动治理链路。
 * - actionType monitor → status "completed"（仅观察，无需动作）。
 * - 其余（rebuild / manual_review）→ status "needs_human"，被例外中心收纳。
 *
 * 本服务记录队列并调度既有 scoped rebuild；不会直接修改不可变 OKF 发布包。
 */
export class LintRemediationService {
  private readonly adapter;

  constructor(private readonly db: DatabaseHandle) {
    this.adapter = db.adapter;
  }

  async recordFromReport(input: { projectId: string; releaseId: string; report: KnowledgeLintReport }): Promise<KnowledgeLintRemediation[]> {
    const now = new Date().toISOString();
    const out: KnowledgeLintRemediation[] = [];
    for (const issue of input.report.issues) {
      const governance = issue.governance;
      if (!governance) continue;
      const status = deriveStatus(governance.autoEligible, governance.actionType);
      const finishedAt = status === "completed" ? now : null;
      const remediationId = `lrm_${nanoid(10)}`;
      const { rows } = await this.adapter.query(
        `INSERT INTO knowledge_lint_remediations
           (remediation_id, project_id, release_id, issue_id, domain, severity, action_type, confidence,
            auto_eligible, status, title, diagnosis, remediation, target_component_id, target_okf_path, run_id, created_at, finished_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (release_id, issue_id) DO UPDATE SET
            action_type = EXCLUDED.action_type,
            confidence = EXCLUDED.confidence,
            auto_eligible = EXCLUDED.auto_eligible,
            status = CASE WHEN knowledge_lint_remediations.status IN ('completed','failed','running') THEN knowledge_lint_remediations.status ELSE EXCLUDED.status END,
            diagnosis = EXCLUDED.diagnosis,
            remediation = EXCLUDED.remediation
         RETURNING *`,
        [
          remediationId,
          input.projectId,
          input.releaseId,
          issue.id,
          issue.domain,
          issue.severity,
          governance.actionType,
          governance.confidence,
          governance.autoEligible,
          status,
          issue.title,
          governance.diagnosis,
          governance.remediation,
          issue.componentId ?? "",
          issue.okfPath ?? "",
          "",
          now,
          finishedAt,
        ],
      );
      out.push(mapRemediation(rows[0]));
    }
    return out;
  }

  /**
   * 从发布目录读取 knowledge_lint.json 并记录治理队列。发布流程内同步调用，
   * 避免通过事件总线异步执行（DB 适配器的事务客户端不可重入，异步写入会与
   * 请求路径的 BEGIN/COMMIT 竞争）。报告缺失时安全返回空。
   */
  async recordFromReleaseDir(input: { projectId: string; releaseId: string; dataDir: string }): Promise<KnowledgeLintRemediation[]> {
    const report = loadLintReport(input.dataDir, input.releaseId);
    if (!report) return [];
    const recorded = await this.recordFromReport({ projectId: input.projectId, releaseId: input.releaseId, report });
    if (recorded.length > 0) {
      await emitKnowledgeEvent(this.db, {
        eventType: "knowledge_lint.remediations_recorded",
        entityType: "release",
        entityId: input.releaseId,
        payload: {
          projectId: input.projectId,
          releaseId: input.releaseId,
          total: recorded.length,
          pending: recorded.filter((item) => item.status === "pending").length,
          needsHuman: recorded.filter((item) => item.status === "needs_human").length,
        },
      });
    }
    return recorded;
  }

  async executePending(input: {
    projectId: string;
    releaseId?: string;
    requestedBy: string;
    kbBuilderService: Pick<KbBuilderPipelineService, "startScopedRebuildForComponent">;
    limit?: number;
  }): Promise<KnowledgeLintRemediation[]> {
    const pending = (await this.listRemediations({ projectId: input.projectId, releaseId: input.releaseId, status: "pending" }))
      .slice(0, input.limit ?? 10);
    const out: KnowledgeLintRemediation[] = [];
    for (const item of pending) {
      if (!item.targetComponentId) {
        out.push(await this.markNeedsHuman(item.remediationId, "自动治理缺少目标组件，无法安全触发 scoped rebuild。"));
        continue;
      }
      try {
        await this.markRunning(item.remediationId, "");
        const run = await input.kbBuilderService.startScopedRebuildForComponent({
          componentId: item.targetComponentId,
          requestedBy: input.requestedBy,
          sourcePath: item.targetOkfPath,
        });
        const running = await this.markRunning(item.remediationId, run.runId);
        await emitKnowledgeEvent(this.db, {
          eventType: "knowledge_lint.remediation_started",
          entityType: "lint_remediation",
          entityId: item.remediationId,
          payload: {
            projectId: item.projectId,
            releaseId: item.releaseId,
            remediationId: item.remediationId,
            issueId: item.issueId,
            componentId: item.targetComponentId,
            runId: run.runId,
          },
        });
        out.push(running);
      } catch (error) {
        out.push(await this.markFailed(item.remediationId, error instanceof Error ? error.message : String(error)));
      }
    }
    return out;
  }

  async markCompletedByRunId(runId: string): Promise<KnowledgeLintRemediation[]> {
    if (!runId) return [];
    const now = new Date().toISOString();
    const { rows } = await this.adapter.query(
      `UPDATE knowledge_lint_remediations
       SET status = 'completed', finished_at = $2, error = ''
       WHERE run_id = $1 AND status = 'running'
       RETURNING *`,
      [runId, now],
    );
    const completed = rows.map(mapRemediation);
    for (const item of completed) {
      await emitKnowledgeEvent(this.db, {
        eventType: "knowledge_lint.remediation_completed",
        entityType: "lint_remediation",
        entityId: item.remediationId,
        payload: {
          projectId: item.projectId,
          releaseId: item.releaseId,
          remediationId: item.remediationId,
          issueId: item.issueId,
          runId,
        },
      });
    }
    return completed;
  }

  async markFailedByRunId(runId: string, error: string): Promise<KnowledgeLintRemediation[]> {
    if (!runId) return [];
    const now = new Date().toISOString();
    const { rows } = await this.adapter.query(
      `UPDATE knowledge_lint_remediations
       SET status = 'failed', error = $2, finished_at = $3
       WHERE run_id = $1 AND status = 'running'
       RETURNING *`,
      [runId, error, now],
    );
    const failed = rows.map(mapRemediation);
    for (const item of failed) {
      await emitKnowledgeEvent(this.db, {
        eventType: "knowledge_lint.remediation_failed",
        entityType: "lint_remediation",
        entityId: item.remediationId,
        payload: {
          projectId: item.projectId,
          releaseId: item.releaseId,
          remediationId: item.remediationId,
          issueId: item.issueId,
          runId,
          error,
        },
      });
    }
    return failed;
  }

  async listRemediations(filter: { projectId?: string; releaseId?: string; status?: LintRemediationStatus } = {}): Promise<KnowledgeLintRemediation[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    where.push(`project_id = $${params.length + 1}`);
    params.push(filter.projectId ?? "default_project");
    if (filter.releaseId) { where.push(`release_id = $${params.length + 1}`); params.push(filter.releaseId); }
    if (filter.status) { where.push(`status = $${params.length + 1}`); params.push(filter.status); }
    const { rows } = await this.adapter.query(
      `SELECT * FROM knowledge_lint_remediations WHERE ${where.join(" AND ")} ORDER BY created_at DESC`,
      params,
    );
    return rows.map(mapRemediation);
  }

  /** 针对某个发布（默认最新有治理记录的发布）汇总队列状态。 */
  async summary(projectId = "default_project", releaseId?: string): Promise<LintRemediationSummary> {
    const targetReleaseId = releaseId ?? (await this.latestReleaseId(projectId));
    const empty: LintRemediationSummary = {
      releaseId: targetReleaseId ?? "",
      total: 0,
      autoGoverned: 0,
      needsHuman: 0,
      failed: 0,
      pending: 0,
      byStatus: { pending: 0, running: 0, completed: 0, failed: 0, needs_human: 0 },
    };
    if (!targetReleaseId) return empty;
    const items = await this.listRemediations({ projectId, releaseId: targetReleaseId });
    for (const item of items) {
      empty.total += 1;
      empty.byStatus[item.status] += 1;
    }
    empty.pending = empty.byStatus.pending + empty.byStatus.running;
    empty.needsHuman = empty.byStatus.needs_human;
    empty.failed = empty.byStatus.failed;
    // autoGoverned 只统计已经完成的自动治理，pending/running 仍属于待处理队列。
    empty.autoGoverned = items.filter((item) => item.autoEligible && item.status === "completed").length;
    return empty;
  }

  private async latestReleaseId(projectId: string): Promise<string | null> {
    const { rows } = await this.adapter.query(
      "SELECT release_id FROM knowledge_lint_remediations WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1",
      [projectId],
    );
    return rows.length ? String(rows[0].release_id) : null;
  }

  private async markRunning(remediationId: string, runId: string): Promise<KnowledgeLintRemediation> {
    const { rows } = await this.adapter.query(
      `UPDATE knowledge_lint_remediations
       SET status = 'running',
           run_id = COALESCE(NULLIF($2, ''), run_id),
           error = ''
       WHERE remediation_id = $1
       RETURNING *`,
      [remediationId, runId],
    );
    return mapRemediation(rows[0]);
  }

  private async markFailed(remediationId: string, error: string): Promise<KnowledgeLintRemediation> {
    const now = new Date().toISOString();
    const { rows } = await this.adapter.query(
      `UPDATE knowledge_lint_remediations
       SET status = 'failed', error = $2, finished_at = $3
       WHERE remediation_id = $1
       RETURNING *`,
      [remediationId, error, now],
    );
    const item = mapRemediation(rows[0]);
    await emitKnowledgeEvent(this.db, {
      eventType: "knowledge_lint.remediation_failed",
      entityType: "lint_remediation",
      entityId: item.remediationId,
      payload: { projectId: item.projectId, releaseId: item.releaseId, remediationId: item.remediationId, error },
    });
    return item;
  }

  private async markNeedsHuman(remediationId: string, reason: string): Promise<KnowledgeLintRemediation> {
    const { rows } = await this.adapter.query(
      `UPDATE knowledge_lint_remediations
       SET status = 'needs_human', error = $2
       WHERE remediation_id = $1
       RETURNING *`,
      [remediationId, reason],
    );
    return mapRemediation(rows[0]);
  }
}

function loadLintReport(dataDir: string, releaseId: string): KnowledgeLintReport | null {
  const path = join(dataDir, "releases", releaseId, "knowledge_lint.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as KnowledgeLintReport;
  } catch {
    return null;
  }
}

function deriveStatus(autoEligible: boolean, actionType: KnowledgeLintRemediation["actionType"]): LintRemediationStatus {
  if (autoEligible) return "pending";
  if (actionType === "monitor") return "completed";
  return "needs_human";
}

function mapRemediation(row: Record<string, unknown>): KnowledgeLintRemediation {
  return {
    remediationId: String(row.remediation_id),
    projectId: String(row.project_id ?? "default_project"),
    releaseId: String(row.release_id),
    issueId: String(row.issue_id),
    domain: String(row.domain) as KnowledgeLintRemediation["domain"],
    severity: String(row.severity) as KnowledgeLintRemediation["severity"],
    actionType: String(row.action_type) as KnowledgeLintRemediation["actionType"],
    confidence: Number(row.confidence ?? 0),
    autoEligible: Boolean(row.auto_eligible),
    status: String(row.status) as LintRemediationStatus,
    title: String(row.title ?? ""),
    diagnosis: String(row.diagnosis ?? ""),
    remediation: String(row.remediation ?? ""),
    targetComponentId: String(row.target_component_id ?? ""),
    targetOkfPath: String(row.target_okf_path ?? ""),
    runId: String(row.run_id ?? ""),
    error: String(row.error ?? ""),
    createdAt: String(row.created_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
  };
}
