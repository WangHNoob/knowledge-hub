import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { nanoid } from "nanoid";

import type {
  DatabaseHandle,
  DiagnosticLogCategory,
  DiagnosticLogLevel,
  DiagnosticLogRecord,
  DiagnosticLogStatus,
  DiagnosticSummary,
} from "../types";

const SENSITIVE_KEYS = new Set(["apikey", "api_key", "authorization", "password", "token", "jwttoken", "secret"]);
const LEVEL_ORDER: Record<DiagnosticLogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface DiagnosticLoggerOptions {
  level?: DiagnosticLogLevel;
  retentionDays?: number;
  logToFile?: boolean;
  logToDb?: boolean;
}

export interface DiagnosticLogInput {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  level?: DiagnosticLogLevel;
  category: DiagnosticLogCategory;
  message: string;
  status?: DiagnosticLogStatus;
  durationMs?: number | null;
  actor?: string;
  route?: string;
  method?: string;
  entityType?: string;
  entityId?: string;
  runId?: string;
  releaseId?: string;
  requestPayload?: unknown;
  context?: Record<string, unknown>;
  error?: unknown;
}

export interface SpanInput extends Omit<DiagnosticLogInput, "status" | "durationMs" | "error"> {}

export interface DiagnosticLogQuery {
  level?: string;
  category?: string;
  status?: string;
  traceId?: string;
  runId?: string;
  releaseId?: string;
  entityId?: string;
  q?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export class DiagnosticLogger {
  private readonly adapter;
  private readonly level: DiagnosticLogLevel;
  private readonly retentionDays: number;
  private readonly logToFile: boolean;
  private readonly logToDb: boolean;
  private readonly emitter = new EventEmitter();

  subscribe(listener: (record: DiagnosticLogRecord) => void): () => void {
    this.emitter.setMaxListeners(0);
    this.emitter.on("log", listener);
    return () => this.emitter.off("log", listener);
  }

  constructor(private readonly db: DatabaseHandle, private readonly dataDir: string, options: DiagnosticLoggerOptions = {}) {
    this.adapter = db.adapter;
    this.level = options.level ?? "info";
    this.retentionDays = options.retentionDays ?? 14;
    this.logToFile = options.logToFile ?? true;
    this.logToDb = options.logToDb ?? true;
    this.cleanupOldFiles();
  }

  traceId(): string {
    return `trc_${Date.now()}_${nanoid(8)}`;
  }

  spanId(): string {
    return `spn_${nanoid(10)}`;
  }

  startSpan(input: SpanInput): DiagnosticSpan {
    const traceId = input.traceId ?? this.traceId();
    const spanId = input.spanId ?? this.spanId();
    const started = Date.now();
    void this.write({ ...input, traceId, spanId, status: "started", durationMs: null });
    return new DiagnosticSpan(this, { ...input, traceId, spanId, started });
  }

  async event(input: DiagnosticLogInput): Promise<void> {
    await this.write({ ...input, status: input.status ?? "event", durationMs: input.durationMs ?? null });
  }

  async write(input: DiagnosticLogInput): Promise<void> {
    const level = input.level ?? (input.status === "failed" ? "error" : "info");
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const now = new Date().toISOString();
    const error = normalizeError(input.error);
    const record = {
      log_id: `log_${Date.now()}_${nanoid(8)}`,
      trace_id: input.traceId ?? this.traceId(),
      span_id: input.spanId ?? this.spanId(),
      parent_span_id: input.parentSpanId ?? "",
      level,
      category: input.category,
      message: input.message,
      status: input.status ?? "event",
      duration_ms: input.durationMs ?? null,
      actor: input.actor ?? "",
      route: input.route ?? "",
      method: input.method ?? "",
      entity_type: input.entityType ?? "",
      entity_id: input.entityId ?? "",
      run_id: input.runId ?? "",
      release_id: input.releaseId ?? "",
      request_payload_json: JSON.stringify(redact(input.requestPayload ?? {})),
      context_json: JSON.stringify(redact(input.context ?? {})),
      error_name: error.name,
      error_message: error.message,
      error_stack: error.stack,
      created_at: now,
    };

    if (this.logToFile) this.appendJsonl(record);
    if (!this.logToDb) {
      this.emitter.emit("log", mapLog(record));
      return;
    }
    try {
      await this.adapter.query(
        `INSERT INTO diagnostic_logs
          (log_id, trace_id, span_id, parent_span_id, level, category, message, status, duration_ms, actor, route, method,
           entity_type, entity_id, run_id, release_id, request_payload_json, context_json, error_name, error_message, error_stack, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [
          record.log_id, record.trace_id, record.span_id, record.parent_span_id, record.level, record.category,
          record.message, record.status, record.duration_ms, record.actor, record.route, record.method,
          record.entity_type, record.entity_id, record.run_id, record.release_id, record.request_payload_json,
          record.context_json, record.error_name, record.error_message, record.error_stack, record.created_at,
        ],
      );
    } catch (error) {
      if (!this.logToFile) this.appendJsonl({ ...record, db_write_error: error instanceof Error ? error.message : String(error) });
    }
    this.emitter.emit("log", mapLog(record));
  }

  async listLogs(query: DiagnosticLogQuery): Promise<DiagnosticLogRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    addFilter(clauses, params, "level", query.level);
    addFilter(clauses, params, "category", query.category);
    addFilter(clauses, params, "status", query.status);
    addFilter(clauses, params, "trace_id", query.traceId);
    addFilter(clauses, params, "run_id", query.runId);
    addFilter(clauses, params, "release_id", query.releaseId);
    addFilter(clauses, params, "entity_id", query.entityId);
    if (query.from) {
      params.push(query.from);
      clauses.push(`created_at >= $${params.length}`);
    }
    if (query.to) {
      params.push(query.to);
      clauses.push(`created_at <= $${params.length}`);
    }
    if (query.q) {
      params.push(`%${query.q}%`);
      clauses.push(`(message ILIKE $${params.length} OR error_message ILIKE $${params.length} OR context_json::text ILIKE $${params.length})`);
    }
    params.push(Math.max(1, Math.min(query.limit ?? 100, 500)));
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const { rows } = await this.adapter.query(
      `SELECT * FROM diagnostic_logs ${where} ORDER BY created_at DESC, log_id DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(mapLog);
  }

  async trace(traceId: string): Promise<DiagnosticLogRecord[]> {
    const { rows } = await this.adapter.query(
      "SELECT * FROM diagnostic_logs WHERE trace_id = $1 ORDER BY created_at ASC, log_id ASC",
      [traceId],
    );
    return rows.map(mapLog);
  }

  async summary(): Promise<DiagnosticSummary> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { rows } = await this.adapter.query(
      `SELECT
        SUM(CASE WHEN level = 'error' OR status = 'failed' THEN 1 ELSE 0 END)::int AS errors,
        SUM(CASE WHEN category = 'http' AND COALESCE(duration_ms, 0) >= 1000 THEN 1 ELSE 0 END)::int AS slow_requests,
        SUM(CASE WHEN category = 'kb_build' AND status = 'failed' THEN 1 ELSE 0 END)::int AS failed_builds,
        SUM(CASE WHEN category = 'mcp' AND status = 'failed' THEN 1 ELSE 0 END)::int AS mcp_errors,
        SUM(CASE WHEN category = 'llm' AND status = 'failed' THEN 1 ELSE 0 END)::int AS llm_errors
       FROM diagnostic_logs
       WHERE created_at >= $1`,
      [since],
    );
    const row = rows[0] ?? {};
    return {
      errors24h: Number(row.errors ?? 0),
      slowRequests24h: Number(row.slow_requests ?? 0),
      failedBuilds24h: Number(row.failed_builds ?? 0),
      mcpErrors24h: Number(row.mcp_errors ?? 0),
      llmErrors24h: Number(row.llm_errors ?? 0),
    };
  }

  private appendJsonl(record: Record<string, unknown>): void {
    const dir = join(this.dataDir, "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify(record)}\n`);
  }

  private cleanupOldFiles(): void {
    if (!this.logToFile || this.retentionDays <= 0) return;
    const dir = join(this.dataDir, "logs");
    if (!existsSync(dir)) return;
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    for (const file of readdirSync(dir)) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(file)) continue;
      const time = Date.parse(file.slice(0, 10));
      if (Number.isFinite(time) && time < cutoff) rmSync(join(dir, file), { force: true });
    }
  }
}

export class DiagnosticSpan {
  constructor(private readonly logger: DiagnosticLogger, private readonly input: SpanInput & { traceId: string; spanId: string; started: number }) {}

  get traceId(): string {
    return this.input.traceId;
  }

  get spanId(): string {
    return this.input.spanId;
  }

  async event(message: string, context: Record<string, unknown> = {}, level: DiagnosticLogLevel = "info"): Promise<void> {
    await this.logger.event({ ...this.input, message, context: { ...(this.input.context ?? {}), ...context }, level, status: "event" });
  }

  async complete(context: Record<string, unknown> = {}): Promise<void> {
    await this.logger.write({
      ...this.input,
      message: `${this.input.message} completed`,
      status: "completed",
      durationMs: Date.now() - this.input.started,
      context: { ...(this.input.context ?? {}), ...context },
    });
  }

  async fail(error: unknown, context: Record<string, unknown> = {}): Promise<void> {
    await this.logger.write({
      ...this.input,
      level: "error",
      message: `${this.input.message} failed`,
      status: "failed",
      durationMs: Date.now() - this.input.started,
      context: { ...(this.input.context ?? {}), ...context },
      error,
    });
  }
}

export function createDiagnosticLogger(db: DatabaseHandle, dataDir: string, options: DiagnosticLoggerOptions = {}): DiagnosticLogger {
  return new DiagnosticLogger(db, dataDir, options);
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) || key.toLowerCase().includes("apikey") ? "[REDACTED]" : redact(raw);
  }
  return out;
}

function normalizeError(error: unknown): { name: string; message: string; stack: string } {
  if (!error) return { name: "", message: "", stack: "" };
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack ?? "" };
  return { name: "Error", message: String(error), stack: "" };
}

function addFilter(clauses: string[], params: unknown[], column: string, value: string | undefined): void {
  if (!value) return;
  params.push(value);
  clauses.push(`${column} = $${params.length}`);
}

function mapLog(row: Record<string, unknown>): DiagnosticLogRecord {
  return {
    logId: String(row.log_id),
    traceId: String(row.trace_id),
    spanId: String(row.span_id),
    parentSpanId: String(row.parent_span_id ?? ""),
    level: row.level as DiagnosticLogLevel,
    category: row.category as DiagnosticLogCategory,
    message: String(row.message),
    status: row.status as DiagnosticLogStatus,
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    actor: String(row.actor ?? ""),
    route: String(row.route ?? ""),
    method: String(row.method ?? ""),
    entityType: String(row.entity_type ?? ""),
    entityId: String(row.entity_id ?? ""),
    runId: String(row.run_id ?? ""),
    releaseId: String(row.release_id ?? ""),
    requestPayload: jsonObject(row.request_payload_json),
    context: jsonObject(row.context_json),
    errorName: String(row.error_name ?? ""),
    errorMessage: String(row.error_message ?? ""),
    errorStack: String(row.error_stack ?? ""),
    createdAt: String(row.created_at),
  };
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string" && value.length > 0) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}
