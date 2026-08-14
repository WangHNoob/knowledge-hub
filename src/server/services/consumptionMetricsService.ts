import type { DatabaseHandle } from "../types";
import { jsonArray } from "../db/mappers";
import { emitKnowledgeEvent } from "./eventService";
import type { ConsumptionStats } from "./trustScore";

/**
 * 消费侧指标（flywheel 02-P4 K7 / 02 收尾 R5）：
 * 归因引用率 / 检索曝光 / 命中后点击 / 负反馈，按组件聚合。
 * releaseService 发布期重算 trust 与健康巡检（低消费 → stale 候选）共用，
 * 避免两处重复 SQL。
 */

const CONSUMPTION_WINDOW_DAYS = 30;

/** 组件消费统计（窗口 = 近 CONSUMPTION_WINDOW_DAYS 天）。 */
export async function getConsumptionStatsByComponent(
  db: DatabaseHandle,
  projectId: string,
  componentIds: string[],
): Promise<Map<string, ConsumptionStats>> {
  const out = new Map<string, ConsumptionStats>();
  if (componentIds.length === 0) return out;

  const [auditRows, feedbackRows, attributionRows] = await Promise.all([
    db.adapter.query(
      `SELECT component_id, tool_name, count
       FROM (
         SELECT hit.component_id, a.tool_name, COUNT(*)::int AS count
         FROM mcp_audit a
         CROSS JOIN LATERAL jsonb_array_elements_text(a.hit_component_ids) AS hit(component_id)
         WHERE a.project_id = $1
           AND a.created_at > NOW() - ($2 || ' days')::interval
           AND a.tool_name IN ('kb_search','kb_get_page','kb_get_entity')
         GROUP BY hit.component_id, a.tool_name
       ) t`,
      [projectId, CONSUMPTION_WINDOW_DAYS],
    ),
    db.adapter.query(
      `SELECT hit.component_id, COUNT(*)::int AS count
       FROM agent_events a
       CROSS JOIN LATERAL jsonb_array_elements_text(a.hit_component_ids) AS hit(component_id)
       WHERE a.project_id = $1
         AND a.feedback_type <> 'hit'
         AND a.created_at > NOW() - ($2 || ' days')::interval
       GROUP BY hit.component_id`,
      [projectId, CONSUMPTION_WINDOW_DAYS],
    ),
    db.adapter.query(
      `SELECT segments_json FROM attribution_audits
       WHERE created_at > NOW() - ($1 || ' days')::interval`,
      [CONSUMPTION_WINDOW_DAYS],
    ),
  ]);

  for (const row of auditRows.rows) {
    const componentId = String(row.component_id);
    const stats = out.get(componentId) ?? { attributionCount: 0, searchCount: 0, clickCount: 0, negativeFeedbackCount: 0 };
    const tool = String(row.tool_name ?? "");
    const count = Number(row.count ?? 0);
    if (tool === "kb_search") stats.searchCount += count;
    else if (tool === "kb_get_page" || tool === "kb_get_entity") stats.clickCount += count;
    out.set(componentId, stats);
  }
  for (const row of feedbackRows.rows) {
    const componentId = String(row.component_id);
    const stats = out.get(componentId) ?? { attributionCount: 0, searchCount: 0, clickCount: 0, negativeFeedbackCount: 0 };
    stats.negativeFeedbackCount += Number(row.count ?? 0);
    out.set(componentId, stats);
  }
  const wanted = new Set(componentIds);
  for (const row of attributionRows.rows) {
    const segments = jsonArray(row.segments_json) as Array<{ trace?: { componentIds?: unknown } }>;
    for (const segment of segments) {
      const ids = Array.isArray(segment?.trace?.componentIds) ? (segment.trace.componentIds as unknown[]).map(String) : [];
      for (const id of ids) {
        if (!wanted.has(id)) continue;
        const stats = out.get(id) ?? { attributionCount: 0, searchCount: 0, clickCount: 0, negativeFeedbackCount: 0 };
        stats.attributionCount += 1;
        out.set(id, stats);
      }
    }
  }
  return out;
}

/** 零消费判定：近窗口内既无检索曝光、无点击、也无归因引用（负反馈不计数）。 */
export function isZeroConsumption(stats: ConsumptionStats | undefined): boolean {
  if (!stats) return true;
  return stats.searchCount === 0 && stats.clickCount === 0 && stats.attributionCount === 0;
}

/**
 * R5 自动化信号（flywheel 02 收尾）：对当前发布中「近窗口零消费且发布超
 * minAgeDays」的组件落 stale_knowledge 反馈（去重：同组件已有 open 的
 * agent_feedback.stale_candidate 任务则跳过）。
 * 返回新增标记的组件数。
 */
export async function flagLowConsumptionStale(
  db: DatabaseHandle,
  projectId: string,
  opts: { minAgeDays?: number; actor?: string } = {},
): Promise<{ flagged: number; sample: Array<{ componentId: string; title: string }> }> {
  const minAgeDays = opts.minAgeDays ?? 30;
  const actor = opts.actor ?? "health-sweep-scheduler";
  const { rows: releaseRows } = await db.adapter.query(
    `SELECT r.release_id, r.published_at, r.created_at, r.manifest_json
       FROM release_channels c
       JOIN releases r ON r.release_id = c.current_release_id
      WHERE c.project_id = $1`,
    [projectId],
  );
  const releaseRow = releaseRows[0];
  if (!releaseRow) return { flagged: 0, sample: [] };
  const publishedAt = new Date(String(releaseRow.published_at ?? releaseRow.created_at)).getTime();
  if (!Number.isFinite(publishedAt) || Date.now() - publishedAt <= minAgeDays * 86_400_000) {
    return { flagged: 0, sample: [] };
  }

  const manifest = (() => {
    const raw = releaseRow.manifest_json;
    if (raw && typeof raw === "object") return raw as Record<string, unknown>;
    try {
      return raw && typeof raw === "string" ? JSON.parse(raw) as Record<string, unknown> : {};
    } catch {
      return {};
    }
  })();
  const componentIds = Array.isArray(manifest.componentIds)
    ? (manifest.componentIds as unknown[]).map(String).filter(Boolean)
    : [];
  if (componentIds.length === 0) return { flagged: 0, sample: [] };

  const consumption = await getConsumptionStatsByComponent(db, projectId, componentIds);
  const { rows: componentRows } = await db.adapter.query(
    `SELECT component_id, title, package_id FROM asset_components WHERE component_id = ANY($1)`,
    [componentIds],
  );
  const metaById = new Map(componentRows.map((row) => [String(row.component_id), row] as const));
  const candidates = componentIds.filter((id) => isZeroConsumption(consumption.get(id)));

  const flagged: Array<{ componentId: string; title: string }> = [];
  const now = new Date().toISOString();
  for (const componentId of candidates) {
    const { rows: existing } = await db.adapter.query(
      `SELECT task_id FROM review_tasks
        WHERE project_id = $1 AND component_id = $2
          AND rule_id = 'agent_feedback.stale_candidate' AND status = 'open'
        LIMIT 1`,
      [projectId, componentId],
    );
    if (existing.length > 0) continue;
    const meta = metaById.get(componentId);
    const title = String(meta?.title ?? componentId);
    const taskId = `task_stale_${componentId.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40)}_${Date.now().toString(36)}`;
    await db.adapter.query(
      `INSERT INTO review_tasks
        (task_id, project_id, package_id, component_id, severity, status, title, description, suggested_action, created_at, task_kind, rule_id, candidates, confidence, context_snapshot)
       VALUES ($1,$2,$3,$4,'warning','open',$5,$6,$7,$8,'annotation','agent_feedback.stale_candidate','[]',0.6,$9)
       ON CONFLICT (task_id) DO NOTHING`,
      [
        taskId,
        projectId,
        String(meta?.package_id ?? ""),
        componentId,
        `疑似过期：${title} 近 30 天零消费`,
        `组件 ${title}（${componentId}）发布已超 30 天且近 30 天无检索命中/无点击/无归因引用，按消费侧 R5 信号标记为 stale 候选。请确认是否修订或下架。`,
        "确认后修订内容并重建发布，或下架该组件；确认仍在用则补充引用/检索路径。",
        now,
        JSON.stringify({ releaseId: String(releaseRow.release_id ?? ""), windowDays: 30, source: "low_consumption" }),
      ],
    );
    await db.adapter.query(
      `INSERT INTO agent_events
        (event_id, project_id, release_id, query, hit_component_ids, quality_flags, status, feedback_type, suggested_action, task_id, cluster_key, created_at)
       VALUES ($1,$2,$3,$4,$5,'["stale_low_consumption"]','hit','stale_knowledge',$6,$7,'', $8)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        `evt_stale_${Date.now()}_${componentId.slice(0, 12)}`,
        projectId,
        String(releaseRow.release_id ?? ""),
        title,
        JSON.stringify([componentId]),
        "确认内容是否仍有效，修订或下架。",
        taskId,
        now,
      ],
    );
    await emitKnowledgeEvent(db, {
      eventType: "knowledge_lint.stale_candidate",
      entityType: "component",
      entityId: componentId,
      payload: {
        projectId,
        componentId,
        title,
        taskId,
        releaseId: String(releaseRow.release_id ?? ""),
        reason: "zero_consumption_30d",
        actor,
      },
    });
    flagged.push({ componentId, title });
  }
  return { flagged: flagged.length, sample: flagged.slice(0, 10) };
}
