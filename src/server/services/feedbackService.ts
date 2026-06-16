import { nanoid } from "nanoid";

import { mapComponent } from "../db/mappers";
import type { AssetComponent, DatabaseHandle, ReleaseRecord } from "../types";

export type FeedbackType = "miss" | "low_quality_hit" | "evidence_insufficient" | "relation_inference_failed";

export function createFeedbackService(db: DatabaseHandle): FeedbackService {
  return new FeedbackService(db);
}

/**
 * Classifies Agent MCP responses into feedback events and reroutes them as
 * review_task entries plus persisted agent_events. Extracted from
 * KnowledgeQueryService so the 06 模块 (Agent 反馈回流) has a single owner.
 */
export class FeedbackService {
  private readonly adapter;
  constructor(private readonly db: DatabaseHandle) {
    this.adapter = db.adapter;
  }

  async applyRules(input: {
    release: ReleaseRecord;
    toolName: string;
    payload: Record<string, unknown>;
    hitComponentIds: string[];
    qualityFlags: string[];
    status: "hit" | "miss" | "error";
  }): Promise<void> {
    const { release, toolName, payload, hitComponentIds, qualityFlags, status } = input;
    if (status === "error") return;
    if (status === "miss") {
      await this.recordFeedback({ release, toolName, payload, feedbackType: "miss", hitComponentIds: [], qualityFlags: [] });
      return;
    }
    if (qualityFlags.some((flag) => flag.startsWith("low_quality:"))) {
      await this.recordFeedback({ release, toolName, payload, feedbackType: "low_quality_hit", hitComponentIds, qualityFlags });
      return;
    }
    if (qualityFlags.some((flag) => flag.startsWith("evidence_missing:"))) {
      await this.recordFeedback({ release, toolName, payload, feedbackType: "evidence_insufficient", hitComponentIds, qualityFlags });
    }
  }

  private async recordFeedback(input: {
    release: ReleaseRecord;
    toolName: string;
    payload: Record<string, unknown>;
    feedbackType: FeedbackType;
    hitComponentIds: string[];
    qualityFlags: string[];
  }): Promise<void> {
    const { release, toolName, payload, feedbackType, hitComponentIds, qualityFlags } = input;
    const query = feedbackQueryKey(toolName, payload);
    const { rows: countRows } = await this.adapter.query(
      "SELECT COUNT(*)::int AS count FROM agent_events WHERE release_id = $1 AND feedback_type = $2 AND query = $3",
      [release.releaseId, feedbackType, query]
    );
    const repeatedCount = Number(countRows[0]?.count ?? 0) + 1;
    const severity = repeatedCount >= 3 ? "blocking" : "warning";
    const targetComponent = await this.targetComponent(release, hitComponentIds);
    if (!targetComponent) return;
    const title = feedbackTitle(feedbackType, severity, query);
    const taskId = `task_mcp_${slug(feedbackType)}_${nanoid(6)}`;
    const suggestedAction = feedbackSuggestedAction(feedbackType);

    await this.adapter.query(
      `INSERT INTO review_tasks (task_id, package_id, component_id, severity, status, title, description, suggested_action, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        taskId,
        targetComponent.packageId,
        targetComponent.componentId,
        severity,
        "open",
        title,
        `Knowledge MCP ${toolName} feedback: ${JSON.stringify(payload)}. Quality flags: ${qualityFlags.join(", ") || "none"}.`,
        suggestedAction,
        new Date().toISOString()
      ]
    );
    await this.adapter.query(
      `INSERT INTO agent_events
        (event_id, release_id, query, hit_component_ids, quality_flags, status, feedback_type, suggested_action, task_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        `evt_${Date.now()}_${nanoid(6)}`,
        release.releaseId,
        query,
        JSON.stringify(hitComponentIds),
        JSON.stringify(qualityFlags),
        feedbackType === "miss" ? "miss" : "hit",
        feedbackType,
        suggestedAction,
        taskId,
        new Date().toISOString()
      ]
    );
  }

  private async targetComponent(release: ReleaseRecord, hitComponentIds: string[]): Promise<AssetComponent | null> {
    if (hitComponentIds.length > 0) {
      const placeholders = hitComponentIds.map((_, i) => `$${i + 1}`).join(",");
      const { rows } = await this.adapter.query(
        `SELECT * FROM asset_components WHERE component_id IN (${placeholders})`,
        hitComponentIds
      );
      return rows.length ? mapComponent(rows[0]) : null;
    }
    if (release.packageIds.length === 0) return null;
    const placeholders = release.packageIds.map((_, i) => `$${i + 1}`).join(",");
    const { rows } = await this.adapter.query(
      `SELECT * FROM asset_components WHERE package_id IN (${placeholders}) ORDER BY group_name, title LIMIT 1`,
      release.packageIds
    );
    return rows.length ? mapComponent(rows[0]) : null;
  }
}

function feedbackQueryKey(toolName: string, payload: Record<string, unknown>): string {
  const value = payload.query ?? payload.q ?? payload.topic ?? payload.page ?? payload.table ?? payload.entityId ?? JSON.stringify(payload);
  return `${toolName}:${String(value).trim().toLowerCase()}`;
}

function feedbackTitle(feedbackType: FeedbackType, severity: string, query: string): string {
  if (feedbackType === "miss") return severity === "blocking" ? `错误本候选：MCP 查询连续无命中 ${query}` : `MCP 查询无命中 ${query}`;
  if (feedbackType === "low_quality_hit") return `MCP 低质量命中 ${query}`;
  if (feedbackType === "evidence_insufficient") return `MCP 证据不足命中 ${query}`;
  return `MCP 反馈 ${query}`;
}

function feedbackSuggestedAction(feedbackType: FeedbackType): string {
  if (feedbackType === "miss") return "补充 topic/page/table/index，使 Agent 查询能够命中当前发布知识。";
  if (feedbackType === "low_quality_hit") return "补齐 wiki spec、证据引用和质量门禁缺口后重新构建资产包。";
  if (feedbackType === "evidence_insufficient") return "补充来源引用和 evidence_records，确保回答可追溯。";
  return "检查知识图谱关系和查询意图映射。";
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "item";
}
