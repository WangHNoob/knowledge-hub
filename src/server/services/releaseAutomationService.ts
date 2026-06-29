import type { DiagnosticLogger } from "./diagnosticService";
import { onKnowledgeEvent } from "./eventService";
import type { ReleaseService } from "./releaseService";

export function registerReleaseAutomation(options: {
  releaseService: ReleaseService;
  diagnostics?: DiagnosticLogger;
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
      if (!result.created) return;
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

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
