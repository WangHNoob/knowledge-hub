import type { DiagnosticLogger } from "./diagnosticService";
import type { KnowledgeQueryService } from "./knowledgeQueryService";
import type { ProjectService } from "./projectService";

export interface HealthSweepDeps {
  projectService: ProjectService;
  queryService: KnowledgeQueryService;
  diagnostics?: DiagnosticLogger;
}

/**
 * 执行一次全项目知识健康巡检（可单独测试，不涉及定时器）。
 *
 * 对每个项目跑一次 `runScheduledHealthCheck` —— lint / trust / 过期审计。其中「知识过期」
 * （auditIsStale）是**时间相关**的：组件超过 maxAuditAgeDays 未复审即算过期，只有随时间
 * 周期性触发才能及时发现，事件驱动的自动化结构上无法覆盖。每次巡检结果落
 * knowledge_lint.health_checked 事件，进入平台自动化历史，可供策划审阅。
 *
 * 单项目失败不影响其它项目；返回每个项目的巡检状态摘要。
 */
export async function runHealthSweepOnce(deps: HealthSweepDeps): Promise<Array<{ projectId: string; status: string }>> {
  const projects = await deps.projectService.listProjects();
  const results: Array<{ projectId: string; status: string }> = [];
  for (const project of projects) {
    try {
      const outcome = await deps.queryService.runScheduledHealthCheck(project.projectId);
      results.push(outcome);
      await deps.diagnostics?.write({
        traceId: "",
        level: outcome.status === "needs_attention" ? "warn" : "info",
        category: "flywheel",
        message: "scheduled knowledge health sweep",
        status: "completed",
        actor: "health-sweep-scheduler",
        entityType: "project",
        entityId: project.projectId,
        context: { projectId: project.projectId, healthStatus: outcome.status },
      });
    } catch (error) {
      await deps.diagnostics?.write({
        traceId: "",
        level: "error",
        category: "flywheel",
        message: "scheduled knowledge health sweep failed for project",
        status: "failed",
        actor: "health-sweep-scheduler",
        entityType: "project",
        entityId: project.projectId,
        error,
        context: { projectId: project.projectId },
      });
    }
  }
  return results;
}

/**
 * 注册周期性知识健康巡检调度器。intervalMs <= 0 时不注册（返回 no-op unsubscribe）。
 * 定时器 unref，避免阻止进程退出；重叠保护确保上一轮未结束时不并发触发。
 * 由生产入口 index.ts 依据 config.healthSweepIntervalHours 显式开启，测试默认不启动定时器。
 */
export function registerHealthSweepScheduler(deps: HealthSweepDeps & { intervalMs: number }): () => void {
  if (!Number.isFinite(deps.intervalMs) || deps.intervalMs <= 0) return () => {};
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void runHealthSweepOnce(deps)
      .catch((error) => {
        void deps.diagnostics?.write({
          traceId: "",
          level: "error",
          category: "flywheel",
          message: "scheduled knowledge health sweep tick failed",
          status: "failed",
          actor: "health-sweep-scheduler",
          entityType: "project",
          entityId: "",
          error,
        });
      })
      .finally(() => {
        running = false;
      });
  }, deps.intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
