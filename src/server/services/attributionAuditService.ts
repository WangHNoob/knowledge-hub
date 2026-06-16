import { nanoid } from "nanoid";

import type { AttributionAudit, AttributionSegment, AttributionType, DatabaseHandle, KnowledgeTrace } from "../types";

export function createAttributionAuditService(db: DatabaseHandle): AttributionAuditService {
  return new AttributionAuditService(db);
}

export interface CreateAttributionAuditInput {
  releaseId: string;
  title: string;
  createdBy: string;
  segments: Array<{
    text: string;
    trace?: Partial<KnowledgeTrace>;
    derivedFrom?: string[];
  }>;
}

export class AttributionAuditService {
  private readonly adapter;

  constructor(private readonly db: DatabaseHandle) {
    this.adapter = db.adapter;
  }

  async createAudit(input: CreateAttributionAuditInput): Promise<AttributionAudit> {
    const auditId = `aud_${Date.now()}_${nanoid(6)}`;
    const createdAt = new Date().toISOString();
    const segments = input.segments.map((segment, index) => classifySegment(segment, index));
    await this.adapter.query(
      `INSERT INTO attribution_audits (audit_id, release_id, title, segments_json, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [auditId, input.releaseId, input.title, JSON.stringify(segments), input.createdBy, createdAt],
    );
    return { auditId, releaseId: input.releaseId, title: input.title, segments, createdBy: input.createdBy, createdAt };
  }

  async listAudits(): Promise<AttributionAudit[]> {
    const { rows } = await this.adapter.query("SELECT * FROM attribution_audits ORDER BY created_at DESC");
    return rows.map(mapAudit);
  }
}

function classifySegment(
  segment: { text: string; trace?: Partial<KnowledgeTrace>; derivedFrom?: string[] },
  index: number,
): AttributionSegment {
  const trace = normalizeTrace(segment.trace);
  const derivedFrom = [...(segment.derivedFrom ?? [])].map(String);
  const attributionType = attributionTypeFor(trace, derivedFrom);
  return {
    segmentId: `seg_${index + 1}`,
    text: segment.text,
    attributionType,
    trace,
    derivedFrom,
    risk: riskFor(attributionType),
  };
}

function attributionTypeFor(trace: Partial<KnowledgeTrace>, derivedFrom: string[]): AttributionType {
  if ((trace.evidenceIds?.length ?? 0) > 0 && (trace.componentIds?.length ?? 0) > 0) return "引用";
  if (derivedFrom.length > 0 || (trace.componentIds?.length ?? 0) > 0) return "推导";
  if ((trace.sourceVersionIds?.length ?? 0) > 0) return "无法判断";
  return "创作";
}

function riskFor(type: AttributionType): string {
  if (type === "引用") return "";
  if (type === "推导") return "需要确认推导依据是否足够支撑结论。";
  if (type === "无法判断") return "存在来源信息，但无法确认可支撑该段内容。";
  return "没有知识库依据，不能伪装成事实源。";
}

function normalizeTrace(trace: Partial<KnowledgeTrace> | undefined): Partial<KnowledgeTrace> {
  return {
    releaseId: trace?.releaseId,
    componentIds: [...(trace?.componentIds ?? [])].map(String),
    artifactIds: [...(trace?.artifactIds ?? [])].map(String),
    sourceVersionIds: [...(trace?.sourceVersionIds ?? [])].map(String),
    evidenceIds: [...(trace?.evidenceIds ?? [])].map(String),
  };
}

function mapAudit(row: Record<string, unknown>): AttributionAudit {
  return {
    auditId: String(row.audit_id),
    releaseId: String(row.release_id ?? ""),
    title: String(row.title ?? ""),
    segments: jsonArray(row.segments_json) as AttributionSegment[],
    createdBy: String(row.created_by ?? ""),
    createdAt: String(row.created_at),
  };
}

function jsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  }
  return [];
}
