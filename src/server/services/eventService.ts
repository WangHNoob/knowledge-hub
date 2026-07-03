import { EventEmitter } from "node:events";

import { nanoid } from "nanoid";

import type { DatabaseHandle } from "../types";

export type KnowledgeEventType =
  | "build.completed"
  | "build.failed"
  | "build.quality_fail"
  | "annotation.created"
  | "annotation.review_resolved"
  | "source_correction.created"
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
  | "release.published"
  | "knowledge_lint.remediations_recorded"
  | "knowledge_lint.remediation_started"
  | "knowledge_lint.remediation_completed"
  | "knowledge_lint.remediation_failed";

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

export function onKnowledgeEvent(type: KnowledgeEventType, listener: (event: KnowledgeEvent) => void): () => void {
  bus.on(type, listener);
  return () => bus.off(type, listener);
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
  bus.emit(event.eventType, event);
  return event;
}
