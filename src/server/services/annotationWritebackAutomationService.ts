import type { DiagnosticLogger } from "./diagnosticService";
import { emitKnowledgeEvent, onKnowledgeEvent } from "./eventService";
import type { KbBuilderPipelineService } from "./kbBuilderService";
import type { DatabaseHandle } from "../types";

export function registerAnnotationWritebackAutomation(options: {
  db: DatabaseHandle;
  kbBuilderService: KbBuilderPipelineService;
  diagnostics?: DiagnosticLogger;
}): () => void {
  return onKnowledgeEvent("annotation.writeback_requested", (event) => {
    void (async () => {
      const componentId = stringValue(event.payload.componentId);
      const taskId = event.entityType === "review_task" ? event.entityId : stringValue(event.payload.taskId);
      if (!componentId || !taskId) return;
      const run = await options.kbBuilderService.startScopedRebuildForComponent({
        componentId,
        requestedBy: stringValue(event.payload.requestedBy) || "system",
        traceId: event.eventId,
        rebuildTaskId: taskId,
        sourcePath: stringValue(event.payload.sourcePath),
      });
      await emitKnowledgeEvent(options.db, {
        eventType: "annotation.writeback_rebuild_started",
        entityType: "build_run",
        entityId: run.runId,
        payload: {
          taskId,
          componentId,
          sourceEventId: event.eventId,
          exampleId: stringValue(event.payload.exampleId),
          runId: run.runId,
          only: typeof run.config.only === "string" ? run.config.only : "",
        },
      });
      await options.diagnostics?.write({
        traceId: event.eventId,
        level: "info",
        category: "kb_build",
        message: "auto started scoped rebuild from annotation writeback",
        status: "completed",
        actor: stringValue(event.payload.requestedBy) || "system",
        entityType: "build_run",
        entityId: run.runId,
        runId: run.runId,
        context: { taskId, componentId, sourceEventId: event.eventId },
      });
    })().catch((error) => {
      void options.diagnostics?.write({
        traceId: event.eventId,
        level: "error",
        category: "kb_build",
        message: "auto scoped rebuild from annotation writeback failed",
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
