import type { DatabaseHandle } from "../types";
import type { DiagnosticLogger } from "./diagnosticService";
import { deliverOutboxEvent, type KnowledgeEvent } from "./eventService";

/**
 * Polls knowledge_event_outbox with SKIP LOCKED and delivers to the local EventEmitter.
 * Use when KH_EVENT_BUS_MODE=outbox so multi-instance processes do not rely on
 * process-local emit alone. Only one claiming worker processes each row.
 */
export function registerEventOutboxWorker(input: {
  db: DatabaseHandle;
  diagnostics?: DiagnosticLogger;
  intervalMs?: number;
  batchSize?: number;
}): () => void {
  const intervalMs = Math.max(250, input.intervalMs ?? 1000);
  const batchSize = Math.max(1, input.batchSize ?? 32);
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await drainOutbox(input.db, batchSize);
    } catch (error) {
      await input.diagnostics?.write({
        level: "warn",
        category: "system",
        message: "Event outbox drain failed",
        context: { error: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();
  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function drainOutbox(db: DatabaseHandle, batchSize: number): Promise<number> {
  await db.adapter.query("BEGIN");
  try {
    const { rows } = await db.adapter.query(
      `SELECT outbox_id, event_id, event_type, entity_type, entity_id, payload_json, created_at
       FROM knowledge_event_outbox
       WHERE delivered_at IS NULL
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $1`,
      [batchSize],
    );
    for (const row of rows) {
      const event: KnowledgeEvent = {
        eventId: String(row.event_id),
        eventType: String(row.event_type) as KnowledgeEvent["eventType"],
        entityType: String(row.entity_type ?? ""),
        entityId: String(row.entity_id ?? ""),
        payload: readPayload(row.payload_json),
        createdAt: String(row.created_at ?? new Date().toISOString()),
      };
      deliverOutboxEvent(event);
      await db.adapter.query(
        "UPDATE knowledge_event_outbox SET delivered_at = $2 WHERE outbox_id = $1",
        [String(row.outbox_id), new Date().toISOString()],
      );
    }
    await db.adapter.query("COMMIT");
    return rows.length;
  } catch (error) {
    await db.adapter.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function readPayload(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}
