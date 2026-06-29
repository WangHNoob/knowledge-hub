import type { DiagnosticLogger } from "./diagnosticService";
import { emitKnowledgeEvent, onKnowledgeEvent } from "./eventService";
import type { KbBuilderPipelineService } from "./kbBuilderService";
import type { DatabaseHandle } from "../types";

export function registerFeedbackAutomation(options: {
  db: DatabaseHandle;
  kbBuilderService: KbBuilderPipelineService;
  diagnostics?: DiagnosticLogger;
}): () => void {
  return onKnowledgeEvent("agent.feedback.rebuild_proposed", (event) => {
    void (async () => {
      const taskId = stringValue(event.payload.taskId);
      if (!taskId) return;
      const run = await options.kbBuilderService.startRebuildFromReviewTask(taskId, "system", event.eventId);
      await emitKnowledgeEvent(options.db, {
        eventType: "agent.feedback.rebuild_started",
        entityType: "build_run",
        entityId: run.runId,
        payload: {
          taskId,
          componentId: event.entityId,
          sourceEventId: event.eventId,
          releaseId: stringValue(event.payload.releaseId),
          runId: run.runId,
          only: typeof run.config.only === "string" ? run.config.only : "",
        },
      });
      await options.diagnostics?.write({
        traceId: event.eventId,
        level: "info",
        category: "kb_build",
        message: "auto started scoped rebuild from Agent feedback",
        status: "completed",
        actor: "system",
        entityType: "build_run",
        entityId: run.runId,
        runId: run.runId,
        context: { taskId, componentId: event.entityId, sourceEventId: event.eventId },
      });
    })().catch((error) => {
      void options.diagnostics?.write({
        traceId: event.eventId,
        level: "error",
        category: "kb_build",
        message: "auto scoped rebuild from Agent feedback failed",
        status: "failed",
        entityType: event.entityType,
        entityId: event.entityId,
        error,
        context: { eventId: event.eventId, payload: event.payload },
      });
    });
  });
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
