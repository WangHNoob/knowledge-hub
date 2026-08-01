import { EventEmitter } from "node:events";

import { nanoid } from "nanoid";

import type { DatabaseHandle } from "../types";

export type KnowledgeEventType =
  | "source.version_imported"
  | "build.completed"
  | "build.failed"
  | "build.quality_fail"
  | "annotation.created"
  | "annotation.review_resolved"
  | "source_correction.created"
  | "correction.submitted"
  | "correction.applied"
  | "source_correction.pending_review"
  | "source_correction.confirmed"
  | "source_correction.retired"
  | "annotation.writeback_requested"
  | "annotation.writeback_rebuild_started"
  | "component.trust_changed"
  | "agent.feedback.received"
  | "agent.feedback.rebuild_proposed"
  | "agent.feedback.rebuild_started"
  | "release.revision_proposed"
  | "release.auto_publish_succeeded"
  | "release.auto_publish_skipped"
  | "publish.skipped"
  | "flywheel.governed"
  | "release.published"
  | "lint.checked"
  | "knowledge_lint.remediations_recorded"
  | "knowledge_lint.health_checked"
  | "knowledge_lint.remediation_started"
  | "knowledge_lint.remediation_completed"
  | "knowledge_lint.remediation_failed"
  | "knowledge_lint.alias_remediated";

export interface KnowledgeEvent {
  eventId: string;
  eventType: KnowledgeEventType;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

const bus = new EventEmitter();
bus.setMaxListeners(0);

/** Delivery mode for subscribers. inline = emit in-process after insert (default). */
export type KnowledgeEventBusMode = "inline" | "outbox";

let eventBusMode: KnowledgeEventBusMode = "inline";

export function configureKnowledgeEventBus(mode: KnowledgeEventBusMode): void {
  eventBusMode = mode === "outbox" ? "outbox" : "inline";
}

export function getKnowledgeEventBusMode(): KnowledgeEventBusMode {
  return eventBusMode;
}

export function onKnowledgeEvent(type: KnowledgeEventType, listener: (event: KnowledgeEvent) => void): () => void {
  bus.on(type, listener);
  return () => bus.off(type, listener);
}

/** Deliver an already-persisted event to in-process subscribers (outbox worker). */
export function deliverOutboxEvent(event: KnowledgeEvent): void {
  bus.emit(event.eventType, event);
}

export async function emitKnowledgeEvent(
  db: DatabaseHandle,
  input: {
    eventType: KnowledgeEventType;
    entityType?: string;
    entityId?: string;
    payload?: Record<string, unknown>;
  },
): Promise<KnowledgeEvent> {
  const event: KnowledgeEvent = {
    eventId: `evt_${Date.now()}_${nanoid(6)}`,
    eventType: input.eventType,
    entityType: input.entityType ?? "",
    entityId: input.entityId ?? "",
    payload: input.payload ?? {},
    createdAt: new Date().toISOString(),
  };
  const projectId = typeof event.payload.projectId === "string" && event.payload.projectId
    ? event.payload.projectId
    : "default_project";
  await db.adapter.query(
    `INSERT INTO knowledge_events (event_id, project_id, event_type, entity_type, entity_id, payload_json, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [event.eventId, projectId, event.eventType, event.entityType, event.entityId, JSON.stringify(event.payload), event.createdAt],
  );
  if (eventBusMode === "outbox") {
    await db.adapter.query(
      `INSERT INTO knowledge_event_outbox
         (outbox_id, event_id, event_type, entity_type, entity_id, payload_json, created_at, delivered_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NULL)`,
      [
        `out_${nanoid(10)}`,
        event.eventId,
        event.eventType,
        event.entityType,
        event.entityId,
        JSON.stringify(event.payload),
        event.createdAt,
      ],
    );
  } else {
    bus.emit(event.eventType, event);
  }
  return event;
}
