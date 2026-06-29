import type { DiagnosticLogger } from "./diagnosticService";
import { emitKnowledgeEvent, onKnowledgeEvent } from "./eventService";
import type { ReleaseService } from "./releaseService";
import type { DatabaseHandle } from "../types";

export function registerReleaseAutomation(options: {
  db: DatabaseHandle;
  releaseService: ReleaseService;
  diagnostics?: DiagnosticLogger;
  autoPublishRevisions?: boolean;
}): () => void {
  return onKnowledgeEvent("build.completed", (event) => {
    void (async () => {
      const packageId = stringValue(event.payload.packageId);
      const runId = stringValue(event.payload.runId) || event.entityId;
      const requestedBy = stringValue(event.payload.requestedBy) || "system";
      const only = stringValue(event.payload.only);
      if (!packageId) return;
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
      if (options.autoPublishRevisions && result.release) {
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
