import { nanoid } from "nanoid";

import type { AttributionAudit, AttributionSegment, AttributionType, DatabaseHandle, KnowledgeTrace } from "../types";
import { emitKnowledgeEvent } from "./eventService";
import { createGapFillCandidateService } from "./gapFillCandidateService";

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
  projectId?: string;
}

export interface AttributionTypeStats {
  totalSegments: number;
  byType: Record<AttributionType, number>;
  creationRatio: number;
  ungroundedRatio: number;
  audits: number;
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
    const audit: AttributionAudit = {
      auditId,
      releaseId: input.releaseId,
      title: input.title,
      segments,
      createdBy: input.createdBy,
      createdAt,
    };
    const projectId = input.projectId || (await this.resolveProjectId(input.releaseId));
    await emitKnowledgeEvent(this.db, {
      eventType: "attribution.audit_received",
      entityType: "attribution_audit",
      entityId: auditId,
      payload: {
        projectId,
        releaseId: input.releaseId,
        auditId,
        ungroundedCount: segments.filter((segment) => segment.attributionType === "创作" || segment.attributionType === "无法判断").length,
      },
    });
    await this.writebackUngroundedSegments({
      projectId,
      releaseId: input.releaseId,
      auditId,
      segments,
      createdBy: input.createdBy,
    });
    return audit;
  }

  async listAudits(): Promise<AttributionAudit[]> {
    const { rows } = await this.adapter.query("SELECT * FROM attribution_audits ORDER BY created_at DESC");
    return rows.map(mapAudit);
  }

  async getStats(projectId = "default_project", sinceDays = 7): Promise<AttributionTypeStats> {
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
    const { rows } = await this.adapter.query(
      `SELECT a.segments_json
       FROM attribution_audits a
       INNER JOIN releases r ON r.release_id = a.release_id
       WHERE r.project_id = $1 AND a.created_at >= $2`,
      [projectId, since],
    );
    const byType: Record<AttributionType, number> = {
      引用: 0,
      推导: 0,
      无法判断: 0,
      创作: 0,
    };
    let totalSegments = 0;
    for (const row of rows) {
      const segments = jsonArray(row.segments_json) as Array<{ attributionType?: string }>;
      for (const segment of segments) {
        const type = String(segment.attributionType ?? "") as AttributionType;
        if (type in byType) byType[type] += 1;
        totalSegments += 1;
      }
    }
    const ungrounded = byType["创作"] + byType["无法判断"];
    return {
      totalSegments,
      byType,
      creationRatio: totalSegments === 0 ? 0 : byType["创作"] / totalSegments,
      ungroundedRatio: totalSegments === 0 ? 0 : ungrounded / totalSegments,
      audits: rows.length,
    };
  }

  /**
   * Turn ungrounded attribution segments into evidence-insufficient review tasks
   * (with component) or gap-fill candidates (without). Open blocking tasks lower trust.
   */
  private async writebackUngroundedSegments(input: {
    projectId: string;
    releaseId: string;
    auditId: string;
    segments: AttributionSegment[];
    createdBy: string;
  }): Promise<void> {
    const gaps = createGapFillCandidateService(this.db);
    for (const segment of input.segments) {
      const needsWriteback =
        segment.attributionType === "创作"
        || segment.attributionType === "无法判断"
        || (segment.attributionType === "推导" && (segment.trace.evidenceIds?.length ?? 0) === 0);
      if (!needsWriteback) continue;
      const componentIds = [...(segment.trace.componentIds ?? [])].map(String).filter(Boolean);
      if (componentIds.length === 0) {
        await gaps.upsertFromFeedback({
          projectId: input.projectId,
          releaseId: input.releaseId,
          query: `attribution:${input.auditId}:${segment.segmentId}`,
          feedbackType: "knowledge_gap",
          expected: segment.text.slice(0, 500),
          reason: `归因段落「${segment.attributionType}」缺少 component/evidence。`,
        });
        continue;
      }
      for (const componentId of componentIds) {
        await this.ensureEvidenceTask({
          projectId: input.projectId,
          releaseId: input.releaseId,
          auditId: input.auditId,
          componentId,
          segment,
          createdBy: input.createdBy,
        });
      }
    }
  }

  private async ensureEvidenceTask(input: {
    projectId: string;
    releaseId: string;
    auditId: string;
    componentId: string;
    segment: AttributionSegment;
    createdBy: string;
  }): Promise<void> {
    const { rows: componentRows } = await this.adapter.query(
      "SELECT package_id, title FROM asset_components WHERE component_id = $1",
      [input.componentId],
    );
    if (!componentRows.length) return;
    const packageId = String(componentRows[0].package_id);
    const title = String(componentRows[0].title ?? input.componentId);
    const { rows: existing } = await this.adapter.query(
      `SELECT task_id FROM review_tasks
       WHERE project_id = $1 AND component_id = $2 AND status = 'open'
         AND rule_id = 'attribution.ungrounded_segment'
       LIMIT 1`,
      [input.projectId, input.componentId],
    );
    if (existing.length) return;
    const taskId = `task_attr_${nanoid(8)}`;
    const now = new Date().toISOString();
    await this.adapter.query(
      `INSERT INTO review_tasks
        (task_id, project_id, package_id, component_id, severity, status, title, description, suggested_action, created_at,
         task_kind, rule_id, candidates, confidence, context_snapshot)
       VALUES ($1,$2,$3,$4,'blocking','open',$5,$6,$7,$8,'annotation','attribution.ungrounded_segment',$9,0.9,$10)`,
      [
        taskId,
        input.projectId,
        packageId,
        input.componentId,
        `归因无证据：${title}`,
        `归因审计 ${input.auditId} 段落「${input.segment.attributionType}」：${input.segment.text.slice(0, 400)}`,
        "补充 evidence_records / 源引用，或提交 source_correction（pending_review）；禁止无证据发布。",
        now,
        JSON.stringify([
          { id: "request_evidence", label: "补证据后复核", action: "annotate" },
          { id: "dismiss_attribution", label: "驳回该段为创作", action: "dismiss" },
        ]),
        JSON.stringify({
          auditId: input.auditId,
          releaseId: input.releaseId,
          segmentId: input.segment.segmentId,
          attributionType: input.segment.attributionType,
          createdBy: input.createdBy,
        }),
      ],
    );
  }

  private async resolveProjectId(releaseId: string): Promise<string> {
    const { rows } = await this.adapter.query("SELECT project_id FROM releases WHERE release_id = $1", [releaseId]);
    return rows.length ? String(rows[0].project_id) : "default_project";
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
