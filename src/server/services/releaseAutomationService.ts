import type { DiagnosticLogger } from "./diagnosticService";
import { emitKnowledgeEvent, onKnowledgeEvent } from "./eventService";
import { AutoPublishEligibilityError, type ReleaseService } from "./releaseService";
import type { GovernanceProfileService } from "./governanceProfileService";
import type { DatabaseHandle } from "../types";

export function registerReleaseAutomation(options: {
  db: DatabaseHandle;
  releaseService: ReleaseService;
  governanceProfileService?: GovernanceProfileService;
  /** 发布后检索 eval 回归时自动回滚到父发布（默认开启）。 */
  autoRollbackOnRegression?: boolean;
  diagnostics?: DiagnosticLogger;
  autoPublishRevisions?: boolean | ((projectId: string) => boolean | Promise<boolean>);
}): () => void {
  return onKnowledgeEvent("build.completed", (event) => {
    void (async () => {
      const packageId = stringValue(event.payload.packageId);
      const runId = stringValue(event.payload.runId) || event.entityId;
      const requestedBy = stringValue(event.payload.requestedBy) || "system";
      const projectId = stringValue(event.payload.projectId) || "default_project";
      const only = stringValue(event.payload.only);
      const publishOnComplete = Boolean(event.payload.publishOnComplete);
      const releaseVersion = stringValue(event.payload.releaseVersion);
      if (!packageId) return;
      if (publishOnComplete) {
        await publishCompletedBuild({
          db: options.db,
          releaseService: options.releaseService,
          autoRollbackOnRegression: options.autoRollbackOnRegression,
          diagnostics: options.diagnostics,
          packageId,
          runId,
          requestedBy,
          projectId,
          only,
          releaseVersion,
          sourceEventId: event.eventId,
        });
        return;
      }
      const result = await options.releaseService.proposeRevisionDraftFromBuild({
        packageId,
        runId,
        requestedBy,
        only,
      });
      if (result.created) {
        await options.diagnostics?.write({
          traceId: "",
          level: "info",
          category: "release",
          message: "auto proposed release revision draft",
          status: "completed",
          actor: requestedBy,
          entityType: "release",
          entityId: result.release?.releaseId ?? "",
          releaseId: result.release?.releaseId ?? "",
          runId,
          context: { packageId, only },
        });
      }
      if (result.release && await shouldAutoPublishRevisions(options.autoPublishRevisions, projectId)) {
        await tryAutoPublishRevision({
          db: options.db,
          releaseService: options.releaseService,
          autoRollbackOnRegression: options.autoRollbackOnRegression,
          diagnostics: options.diagnostics,
          releaseId: result.release.releaseId,
          requestedBy,
          runId,
          packageId,
          sourceEventId: event.eventId,
        });
      }
    })().catch((error) => {
      void options.diagnostics?.write({
        traceId: "",
        level: "error",
        category: "release",
        message: "auto release revision proposal failed",
        status: "failed",
        entityType: event.entityType,
        entityId: event.entityId,
        runId: stringValue(event.payload.runId) || event.entityId,
        error,
        context: { eventId: event.eventId, payload: event.payload },
      });
    });
  });
}

async function shouldAutoPublishRevisions(
  policy: boolean | ((projectId: string) => boolean | Promise<boolean>) | undefined,
  projectId: string,
): Promise<boolean> {
  return typeof policy === "function" ? Boolean(await policy(projectId)) : Boolean(policy);
}

async function publishCompletedBuild(options: {
  db: DatabaseHandle;
  releaseService: ReleaseService;
  autoRollbackOnRegression?: boolean;
  diagnostics?: DiagnosticLogger;
  packageId: string;
  runId: string;
  requestedBy: string;
  projectId: string;
  only: string;
  releaseVersion: string;
  sourceEventId: string;
}): Promise<void> {
  let releaseId = "";
  try {
    const revision = options.only
      ? await options.releaseService.proposeRevisionDraftFromBuild({
        packageId: options.packageId,
        runId: options.runId,
        requestedBy: options.requestedBy,
        only: options.only,
      })
      : { release: await options.releaseService.createDraft({
        version: options.releaseVersion || `auto-${options.runId}`,
        packageIds: [options.packageId],
        projectId: options.projectId,
        requestedBy: options.requestedBy || "system",
        note: `一键构建并发布：${options.runId}`,
      }), created: true };
    if (!revision.release) throw new Error("无法创建发布草案：当前构建不是完整发布，也没有可继承的 current release。");
    releaseId = revision.release.releaseId;
    const published = await options.releaseService.publish(releaseId, options.requestedBy || "system", { autoMode: Boolean(revision.release.parentReleaseId) });
    await emitKnowledgeEvent(options.db, {
      eventType: "release.auto_publish_succeeded",
      entityType: "release",
      entityId: published.releaseId,
      payload: {
        releaseId: published.releaseId,
        runId: options.runId,
        packageId: options.packageId,
        sourceEventId: options.sourceEventId,
        mode: "build_and_publish",
      },
    });
    await verifyAndMaybeRollback({
      db: options.db,
      releaseService: options.releaseService,
      autoRollbackOnRegression: options.autoRollbackOnRegression,
      diagnostics: options.diagnostics,
      published,
      requestedBy: options.requestedBy || "system",
      runId: options.runId,
      packageId: options.packageId,
      sourceEventId: options.sourceEventId,
      mode: "build_and_publish",
    });
    await options.diagnostics?.write({
      traceId: "",
      level: "info",
      category: "release",
      message: "one-click build published release",
      status: "completed",
      actor: options.requestedBy,
      entityType: "release",
      entityId: published.releaseId,
      releaseId: published.releaseId,
      runId: options.runId,
      context: { packageId: options.packageId, sourceEventId: options.sourceEventId },
    });
  } catch (error) {
    const check = error instanceof AutoPublishEligibilityError ? error.check : null;
    await emitKnowledgeEvent(options.db, {
      eventType: "release.auto_publish_skipped",
      entityType: "release",
      entityId: releaseId || options.runId,
      payload: {
        releaseId,
        runId: options.runId,
        packageId: options.packageId,
        sourceEventId: options.sourceEventId,
        mode: "build_and_publish",
        reason: error instanceof Error ? error.message : String(error),
        reasons: check?.reasons ?? [],
        reasonDetails: check?.reasonDetails ?? [],
        autoPublishCheck: check,
      },
    });
    await options.diagnostics?.write({
      traceId: "",
      level: "warn",
      category: "release",
      message: "one-click build publish skipped",
      status: "completed",
      actor: options.requestedBy,
      entityType: "build_run",
      entityId: options.runId,
      releaseId,
      runId: options.runId,
      context: {
        packageId: options.packageId,
        sourceEventId: options.sourceEventId,
        reason: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

async function tryAutoPublishRevision(options: {
  db: DatabaseHandle;
  releaseService: ReleaseService;
  autoRollbackOnRegression?: boolean;
  diagnostics?: DiagnosticLogger;
  releaseId: string;
  requestedBy: string;
  runId: string;
  packageId: string;
  sourceEventId: string;
}): Promise<void> {
  try {
    const published = await options.releaseService.publish(options.releaseId, options.requestedBy || "system", { autoMode: true });
    await emitKnowledgeEvent(options.db, {
      eventType: "release.auto_publish_succeeded",
      entityType: "release",
      entityId: published.releaseId,
      payload: {
        releaseId: published.releaseId,
        runId: options.runId,
        packageId: options.packageId,
        sourceEventId: options.sourceEventId,
      },
    });
    await verifyAndMaybeRollback({
      db: options.db,
      releaseService: options.releaseService,
      autoRollbackOnRegression: options.autoRollbackOnRegression,
      diagnostics: options.diagnostics,
      published,
      requestedBy: options.requestedBy || "system",
      runId: options.runId,
      packageId: options.packageId,
      sourceEventId: options.sourceEventId,
      mode: "revision",
    });
    await options.diagnostics?.write({
      traceId: "",
      level: "info",
      category: "release",
      message: "auto published release revision",
      status: "completed",
      actor: options.requestedBy,
      entityType: "release",
      entityId: published.releaseId,
      releaseId: published.releaseId,
      runId: options.runId,
      context: { packageId: options.packageId, sourceEventId: options.sourceEventId },
    });
  } catch (error) {
    const check = error instanceof AutoPublishEligibilityError ? error.check : null;
    await emitKnowledgeEvent(options.db, {
      eventType: "release.auto_publish_skipped",
      entityType: "release",
      entityId: options.releaseId,
      payload: {
        releaseId: options.releaseId,
        runId: options.runId,
        packageId: options.packageId,
        sourceEventId: options.sourceEventId,
        reason: error instanceof Error ? error.message : String(error),
        reasons: check?.reasons ?? [],
        reasonDetails: check?.reasonDetails ?? [],
        autoPublishCheck: check,
      },
    });
    await options.diagnostics?.write({
      traceId: "",
      level: "warn",
      category: "release",
      message: "auto publish release revision skipped",
      status: "completed",
      actor: options.requestedBy,
      entityType: "release",
      entityId: options.releaseId,
      releaseId: options.releaseId,
      runId: options.runId,
      context: {
        packageId: options.packageId,
        sourceEventId: options.sourceEventId,
        reason: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

/**
 * 发布后闭环保险：对刚发布到 channel 的版本跑一次检索 eval（此时检索的就是新内容）。
 * hit@k 低于门槛 → 自动回滚到父发布并记录事件，保证「发出去的版本必须是更好的版本」。
 * eval 未启用 / 无黄金集 / 无 parent 时不动作。可独立单测（导出）。
 */
export async function verifyAndMaybeRollback(options: {
  db: DatabaseHandle;
  releaseService: ReleaseService;
  /** 显式关闭发布后自动回滚（默认开启）。 */
  autoRollbackOnRegression?: boolean;
  diagnostics?: DiagnosticLogger;
  published: import("../types").ReleaseRecord;
  requestedBy: string;
  runId: string;
  packageId: string;
  sourceEventId: string;
  mode: "revision" | "build_and_publish";
}): Promise<boolean> {
  const { published } = options;
  if (options.autoRollbackOnRegression === false) return false;
  const summary = await options.releaseService.runRetrievalEval(published.projectId);
  if (!summary) return false; // eval 未启用或无黄金集 → 跳过验证
  if (summary.hitAtK + 1e-9 >= summary.minHitAtK) return false; // 通过
  if (!published.parentReleaseId) {
    await options.diagnostics?.write({
      traceId: "",
      level: "warn",
      category: "release",
      message: "post-publish retrieval eval regressed but no parent release to rollback to",
      status: "completed",
      actor: "system:auto-verify",
      entityType: "release",
      entityId: published.releaseId,
      releaseId: published.releaseId,
      runId: options.runId,
      context: { hitAtK: summary.hitAtK, minHitAtK: summary.minHitAtK },
    });
    return false;
  }
  await options.releaseService.rollback(published.parentReleaseId, "system:auto-verify");
  await emitKnowledgeEvent(options.db, {
    eventType: "release.auto_rolled_back",
    entityType: "release",
    entityId: published.releaseId,
    payload: {
      releaseId: published.releaseId,
      rolledBackTo: published.parentReleaseId,
      runId: options.runId,
      packageId: options.packageId,
      sourceEventId: options.sourceEventId,
      mode: options.mode,
      reason: "retrieval_eval_regression",
      hitAtK: summary.hitAtK,
      minHitAtK: summary.minHitAtK,
    },
  });
  await options.diagnostics?.write({
    traceId: "",
    level: "warn",
    category: "release",
    message: "auto rolled back release after retrieval eval regression",
    status: "completed",
    actor: "system:auto-verify",
    entityType: "release",
    entityId: published.releaseId,
    releaseId: published.parentReleaseId,
    runId: options.runId,
    context: {
      rolledBackFrom: published.releaseId,
      hitAtK: summary.hitAtK,
      minHitAtK: summary.minHitAtK,
    },
  });
  return true;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
