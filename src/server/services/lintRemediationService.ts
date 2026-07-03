import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { nanoid } from "nanoid";

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

/**
 * 阶段4 治理队列服务。把一次发布的 Knowledge Lint 报告落成可追踪的治理任务：
 * - governance.autoEligible=true → status "pending"，进入自动治理链路。
 * - actionType monitor → status "completed"（仅观察，无需动作）。
 * - 其余（rebuild / manual_review）→ status "needs_human"，被例外中心收纳。
 *
 * 本服务只做队列记录与状态流转；真正的重建/回写仍由既有确定性链路执行，
 * 不直接修改不可变 OKF 发布包。
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
            auto_eligible, status, title, diagnosis, remediation, target_component_id, target_okf_path, created_at, finished_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (release_id, issue_id) DO UPDATE SET
            action_type = EXCLUDED.action_type,
            confidence = EXCLUDED.confidence,
            auto_eligible = EXCLUDED.auto_eligible,
            status = CASE WHEN knowledge_lint_remediations.status IN ('completed','failed') THEN knowledge_lint_remediations.status ELSE EXCLUDED.status END,
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
    return this.recordFromReport({ projectId: input.projectId, releaseId: input.releaseId, report });
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
    // autoGoverned：自动链路处理过的（pending/running/completed 且 autoEligible，或已 completed 的非 monitor）。
    empty.autoGoverned = items.filter((item) => item.autoEligible).length;
    return empty;
  }

  private async latestReleaseId(projectId: string): Promise<string | null> {
    const { rows } = await this.adapter.query(
      "SELECT release_id FROM knowledge_lint_remediations WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1",
      [projectId],
    );
    return rows.length ? String(rows[0].release_id) : null;
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
    error: String(row.error ?? ""),
    createdAt: String(row.created_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
  };
}
