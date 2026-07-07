import type { DiagnosticLogger } from "./diagnosticService";
import { onKnowledgeEvent } from "./eventService";
import type { FlywheelService } from "./flywheelService";
import type { DatabaseHandle } from "../types";

/**
 * 阶段7：上传即流转自动化。
 *
 * 监听 `source.version_imported`（策划在平台上传新资料、导入为新版本时广播），
 * 自动触发 flywheelService.sync —— 增量优先构建，构建完成后由既有的 releaseAutomation
 * / lintRemediationAutomation 链继续 lint 治理与自动发布。这样「上传 → 构建 → lint → 发布」
 * 全程无需人工点按，平台侧只保留上传与审阅。
 *
 * 防抖 / 防空转：仅当相对上一版本确有变更（changedFileCount > 0）才构建；相同内容重导
 * （幂等 no-op）直接跳过，避免无意义的构建与发布。
 *
 * 与其它 register*Automation 一致：只做编排触发，不绕过既有确定性服务；返回 unsubscribe。
 */
export function registerSourceIngestAutomation(options: {
  db: DatabaseHandle;
  flywheelService: FlywheelService;
  diagnostics?: DiagnosticLogger;
  /** 项目级开关：默认 true。返回 false 时跳过该项目的自动构建（保留手动 sync）。 */
  autoBuildEnabled?: boolean | ((projectId: string) => boolean | Promise<boolean>);
}): () => void {
  return onKnowledgeEvent("source.version_imported", (event) => {
    void (async () => {
      const projectId = stringValue(event.payload.projectId) || "default_project";
      const versionId = stringValue(event.payload.versionId) || event.entityId;
      const changedFileCount = numberValue(event.payload.changedFileCount);
      const actor = stringValue(event.payload.actor) || "system";

      if (changedFileCount <= 0) {
        await options.diagnostics?.write({
          traceId: "",
          level: "info",
          category: "flywheel",
          message: "source ingest automation skipped: no changes",
          status: "completed",
          actor,
          entityType: "source_version",
          entityId: versionId,
          context: { projectId, versionId, reason: "no_changes" },
        });
        return;
      }

      if (!(await shouldAutoBuild(options.autoBuildEnabled, projectId))) {
        await options.diagnostics?.write({
          traceId: "",
          level: "info",
          category: "flywheel",
          message: "source ingest automation disabled for project",
          status: "completed",
          actor,
          entityType: "source_version",
          entityId: versionId,
          context: { projectId, versionId, reason: "auto_build_disabled" },
        });
        return;
      }

      const result = await options.flywheelService.sync({
        projectId,
        requestedBy: actor === "system" ? "system" : `ingest:${actor}`,
        mode: "incremental",
      });
      await options.diagnostics?.write({
        traceId: "",
        level: result.status === "failed" ? "warn" : "info",
        category: "flywheel",
        message: "source ingest automation triggered build-and-publish",
        status: result.status === "failed" ? "failed" : "completed",
        actor,
        entityType: "source_version",
        entityId: versionId,
        context: {
          projectId,
          versionId,
          changedFileCount,
          syncId: result.syncId,
          syncStatus: result.status,
          buildRunIds: result.buildRunIds,
          mode: result.mode,
        },
      });
    })().catch((error) => {
      void options.diagnostics?.write({
        traceId: "",
        level: "error",
        category: "flywheel",
        message: "source ingest automation failed",
        status: "failed",
        entityType: event.entityType,
        entityId: event.entityId,
        error,
        context: { eventId: event.eventId, payload: event.payload },
      });
    });
  });
}

async function shouldAutoBuild(
  policy: boolean | ((projectId: string) => boolean | Promise<boolean>) | undefined,
  projectId: string,
): Promise<boolean> {
  if (policy === undefined) return true;
  return typeof policy === "function" ? Boolean(await policy(projectId)) : Boolean(policy);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
