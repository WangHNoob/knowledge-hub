import { nanoid } from "nanoid";

import { mapComponent } from "../db/mappers";
import type { AssetComponent, DatabaseHandle, ReleaseRecord } from "../types";

export type FeedbackType =
  | "miss"
  | "low_quality_hit"
  | "repeated_query"
  | "evidence_insufficient"
  | "relation_inference_failed"
  | "knowledge_gap"
  | "bad_hit"
  | "stale_knowledge";

export interface FeedbackRecordResult {
  recorded: boolean;
  taskId: string | null;
  feedbackType: FeedbackType;
  severity: "blocking" | "warning";
  query: string;
  targetComponentId: string | null;
  suggestedAction: string;
}

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
    if (qualityFlags.some((flag) => flag.startsWith("low_quality:") || flag.startsWith("low_trust:"))) {
      await this.recordFeedback({ release, toolName, payload, feedbackType: "low_quality_hit", hitComponentIds, qualityFlags });
      return;
    }
    if (qualityFlags.some((flag) => flag.startsWith("evidence_missing:"))) {
      await this.recordFeedback({ release, toolName, payload, feedbackType: "evidence_insufficient", hitComponentIds, qualityFlags });
    }
  }

  async recordExplicitFeedback(input: {
    release: ReleaseRecord;
    toolName: string;
    payload: Record<string, unknown>;
    feedbackType: FeedbackType;
    hitComponentIds: string[];
    qualityFlags?: string[];
  }): Promise<FeedbackRecordResult> {
    return this.recordFeedback({
      release: input.release,
      toolName: input.toolName,
      payload: input.payload,
      feedbackType: input.feedbackType,
      hitComponentIds: input.hitComponentIds,
      qualityFlags: input.qualityFlags ?? [],
    });
  }

  private async recordFeedback(input: {
    release: ReleaseRecord;
    toolName: string;
    payload: Record<string, unknown>;
    feedbackType: FeedbackType;
    hitComponentIds: string[];
    qualityFlags: string[];
  }): Promise<FeedbackRecordResult> {
    const { release, toolName, payload, feedbackType, hitComponentIds, qualityFlags } = input;
    const query = feedbackQueryKey(toolName, payload);
    const { rows: countRows } = await this.adapter.query(
      "SELECT COUNT(*)::int AS count FROM agent_events WHERE release_id = $1 AND feedback_type = $2 AND query = $3",
      [release.releaseId, feedbackType, query]
    );
    const repeatedCount = Number(countRows[0]?.count ?? 0) + 1;
    const effectiveFeedbackType: FeedbackType = feedbackType === "miss" && repeatedCount >= 3 ? "repeated_query" : feedbackType;
    const severity = repeatedCount >= 3 ? "blocking" : "warning";
    const targetComponent = await this.targetComponent(release, hitComponentIds);
    const suggestedAction = feedbackSuggestedAction(effectiveFeedbackType);
    if (!targetComponent) {
      return {
        recorded: false,
        taskId: null,
        feedbackType: effectiveFeedbackType,
        severity,
        query,
        targetComponentId: null,
        suggestedAction,
      };
    }
    const title = feedbackTitle(effectiveFeedbackType, severity, query);
    const taskId = `task_mcp_${slug(effectiveFeedbackType)}_${nanoid(6)}`;

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
        feedbackDescription(toolName, payload, qualityFlags),
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
        effectiveFeedbackType,
        suggestedAction,
        taskId,
        new Date().toISOString()
      ]
    );
    return {
      recorded: true,
      taskId,
      feedbackType: effectiveFeedbackType,
      severity,
      query,
      targetComponentId: targetComponent.componentId,
      suggestedAction,
    };
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
  if (feedbackType === "knowledge_gap") return severity === "blocking" ? `错误本候选：Agent 主动报告知识缺口 ${query}` : `Agent 主动报告知识缺口 ${query}`;
  if (feedbackType === "bad_hit") return `Agent 主动报告错命中 ${query}`;
  if (feedbackType === "stale_knowledge") return `Agent 主动报告知识过期或错误 ${query}`;
  if (feedbackType === "miss") return severity === "blocking" ? `错误本候选：MCP 查询连续无命中 ${query}` : `MCP 查询无命中 ${query}`;
  if (feedbackType === "repeated_query") return `错误本候选：MCP 查询重复失败 ${query}`;
  if (feedbackType === "low_quality_hit") return `MCP 低可信命中 ${query}`;
  if (feedbackType === "evidence_insufficient") return `MCP 证据不足命中 ${query}`;
  return `MCP 反馈 ${query}`;
}

function feedbackSuggestedAction(feedbackType: FeedbackType): string {
  if (feedbackType === "knowledge_gap") return "补充缺失 topic/page/table/graph 关系，重新构建发布后让 Agent 复测同一查询。";
  if (feedbackType === "bad_hit") return "检查检索排序、标题/别名/索引和命中组件内容；必要时修订知识正文或表依赖后重新发布。";
  if (feedbackType === "stale_knowledge") return "核对来源版本与最后可信审计，更新原始资料或知识资产后重新构建发布。";
  if (feedbackType === "miss") return "补充 topic/page/table/index，使 Agent 查询能够命中当前发布知识。";
  if (feedbackType === "repeated_query") return "同类查询已重复触发，修订 topic_index、Wiki 或图谱关系，并纳入错误本复盘。";
  if (feedbackType === "low_quality_hit") return "查看 Trust Score 明细，补证据、完整度、审计时效或一致性缺口后重新发布。";
  if (feedbackType === "evidence_insufficient") return "补充来源引用和 evidence_records，确保回答可追溯。";
  return "检查知识图谱关系和查询意图映射。";
}

function feedbackDescription(toolName: string, payload: Record<string, unknown>, qualityFlags: string[]): string {
  const note = typeof payload.note === "string" ? payload.note : "";
  const expected = typeof payload.expected === "string" ? payload.expected : "";
  const reason = typeof payload.reason === "string" ? payload.reason : "";
  return [
    `Knowledge MCP ${toolName} feedback: ${JSON.stringify(payload)}.`,
    `Quality flags: ${qualityFlags.join(", ") || "none"}.`,
    reason ? `Reason: ${reason}.` : "",
    expected ? `Expected: ${expected}.` : "",
    note ? `Note: ${note}.` : "",
  ].filter(Boolean).join(" ");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "item";
}
