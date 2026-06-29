import { EventEmitter } from "node:events";

import { nanoid } from "nanoid";

import type { DatabaseHandle } from "../types";

export type KnowledgeEventType =
  | "build.completed"
  | "build.quality_fail"
  | "annotation.created"
  | "annotation.writeback_requested"
  | "annotation.writeback_rebuild_started"
  | "component.trust_changed"
  | "agent.feedback.received"
  | "agent.feedback.rebuild_proposed"
  | "agent.feedback.rebuild_started"
  | "release.revision_proposed"
  | "release.auto_publish_succeeded"
  | "release.auto_publish_skipped"
  | "release.published";

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
  await db.adapter.query(
    `INSERT INTO knowledge_events (event_id, event_type, entity_type, entity_id, payload_json, created_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [event.eventId, event.eventType, event.entityType, event.entityId, JSON.stringify(event.payload), event.createdAt],
  );
  bus.emit(event.eventType, event);
  return event;
}
