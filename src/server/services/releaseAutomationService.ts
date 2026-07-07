import type { DiagnosticLogger } from "./diagnosticService";
import { emitKnowledgeEvent, onKnowledgeEvent } from "./eventService";
import { AutoPublishEligibilityError, type ReleaseService } from "./releaseService";
import type { DatabaseHandle } from "../types";

export function registerReleaseAutomation(options: {
  db: DatabaseHandle;
  releaseService: ReleaseService;
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

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
