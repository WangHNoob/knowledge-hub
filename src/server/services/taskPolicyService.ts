// src/server/services/taskPolicyService.ts
// 预设规则驱动的任务自动收敛：不依赖人工、不依赖 LLM，纯规则消解低价值任务，
// 让「需要人的东西」收敛到真正需要判断的阻塞级问题上。

import type { DatabaseHandle } from "../types";
import { createGapFillCandidateService } from "./gapFillCandidateService";

export function createTaskPolicyService(db: DatabaseHandle): TaskPolicyService {
  return new TaskPolicyService(db);
}

export class TaskPolicyService {
  private readonly adapter;

  constructor(private readonly db: DatabaseHandle) {
    this.adapter = db.adapter;
  }

  /**
   * 对某项目执行一轮任务策略：
   * 1. info 级 open 任务 → 自动 dismiss（info 是建议性发现，不产生发布阻塞，无需人工）。
   * 2. gap_fill_candidates 达阈值且无源 → 自动 dismiss（受控收敛）。
   * 返回被自动收敛的任务/候选数量。
   */
  async applyOpenTaskPolicies(projectId = "default_project"): Promise<{ dismissedTasks: number; dismissedGapFill: number }> {
    const dismissedTasks = await this.dismissOpenInfoTasks(projectId);
    const dismissedGapFill = await createGapFillCandidateService(this.db).applyAutoDismissPolicies(projectId);
    return { dismissedTasks, dismissedGapFill };
  }

  private async dismissOpenInfoTasks(projectId: string): Promise<number> {
    const now = new Date().toISOString();
    const { rows } = await this.adapter.query(
      `UPDATE review_tasks
         SET status = 'dismissed', resolved_by = 'system:task-policy', resolved_at = $2,
             resolution_note = '预设规则：info 级任务自动收敛，无需人工处理'
       WHERE project_id = $1 AND status = 'open' AND severity = 'info'
       RETURNING task_id`,
      [projectId, now],
    );
    return rows.length;
  }
}
