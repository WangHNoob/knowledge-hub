import type { DatabaseHandle } from "../types";
import { DenseModelUnavailableError, loadFastembedEmbedder } from "./okf/denseIndexV2";
import { cosineSimilarity } from "./okf/hybridSearch";

/**
 * 语义反馈聚类（flywheel 02-P3，K3）：
 * 反馈聚类键从「query 字符串精确相等」升级为「embedding 余弦相似度 ≥ 阈值归并」。
 *
 * - 归并只在同 project + 同 feedback_type 内进行；
 * - 归并动作写 diagnostic_logs 审计，可追溯、可人工拆簇（拆簇 = 后续查询不再命中该簇）；
 * - embedding 模型不可用时回退「归一化 query 精确匹配」（与旧行为一致，无回归）。
 */

export const FEEDBACK_CLUSTER_SIMILARITY_THRESHOLD = 0.85;
export const FEEDBACK_CLUSTER_LOOKBACK_DAYS = 90;
export const FEEDBACK_CLUSTER_MAX_CANDIDATES = 50;

/** FNV-1a 32-bit（8 hex）——聚类键只需稳定，不承担安全职责。 */
export function hashClusterQuery(query: string): string {
  const normalized = normalizeClusterQuery(query);
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** 归一化：去工具前缀、折叠空白、小写。 */
export function normalizeClusterQuery(query: string): string {
  const stripped = query.replace(/^[a-z_]+:/u, "");
  return stripped.replace(/\s+/gu, " ").trim().toLowerCase();
}

interface ClusterCandidate {
  query: string;
  clusterKey: string;
  embedding: number[] | null;
}

/**
 * 解析一条反馈的聚类键：
 * 1. 同 project+type 最近 N 条反馈中，embedding 余弦 ≥ 阈值 → 复用其簇（或按其 query 哈希）并写审计；
 * 2. 否则返回独立簇键 `q::<归一化 query 哈希>`；
 * 3. 模型不可用 → 返回 `q::<归一化 query>`（精确匹配，与旧行为一致）。
 */
export async function resolveFeedbackClusterKey(
  db: DatabaseHandle,
  input: { projectId: string; feedbackType: string; query: string },
  opts: { embedder?: { embed(texts: string[]): Promise<number[][]> } } = {},
): Promise<string> {
  const { rows } = await db.adapter.query(
    `SELECT query, cluster_key
     FROM agent_events
     WHERE project_id = $1 AND feedback_type = $2
       AND created_at > NOW() - ($3 || ' days')::interval
     ORDER BY created_at DESC
     LIMIT $4`,
    [input.projectId, input.feedbackType, FEEDBACK_CLUSTER_LOOKBACK_DAYS, FEEDBACK_CLUSTER_MAX_CANDIDATES],
  );
  const candidates: ClusterCandidate[] = rows.map((row) => ({
    query: String(row.query ?? ""),
    clusterKey: String(row.cluster_key ?? ""),
    embedding: null,
  }));
  if (candidates.length === 0) return `q::${hashClusterQuery(input.query)}`;

  let embedder: { embed(texts: string[]): Promise<number[][]> };
  try {
    embedder = opts.embedder ?? await loadFastembedEmbedder();
  } catch (err) {
    if (err instanceof DenseModelUnavailableError) {
      // 模型不可用：精确匹配回退（与 02-P3 之前的聚合行为一致）
      return `q::${normalizeClusterQuery(input.query)}`;
    }
    throw err;
  }

  try {
    const [queryVec] = await embedder.embed([input.query]);
    if (!queryVec || queryVec.length === 0) return `q::${hashClusterQuery(input.query)}`;

    let best: ClusterCandidate | null = null;
    let bestScore = -1;
    const pendingEmbed: string[] = [];
    const byQuery = new Map<string, ClusterCandidate>();
    for (const candidate of candidates) {
      if (candidate.query.length === 0) continue;
      pendingEmbed.push(candidate.query);
      byQuery.set(candidate.query, candidate);
    }
    if (pendingEmbed.length > 0) {
      const rowsVectors = await embedder.embed(pendingEmbed);
      pendingEmbed.forEach((text, index) => {
        const candidate = byQuery.get(text);
        if (candidate && rowsVectors[index]) candidate.embedding = rowsVectors[index];
      });
    }
    for (const candidate of candidates) {
      if (!candidate.embedding) continue;
      const score = cosineSimilarity(queryVec, candidate.embedding);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    if (best && bestScore >= FEEDBACK_CLUSTER_SIMILARITY_THRESHOLD) {
      const mergedKey = best.clusterKey || `q::${hashClusterQuery(best.query)}`;
      await db.adapter.query(
        `INSERT INTO diagnostic_logs
          (log_id, trace_id, span_id, level, category, message, status, actor, entity_type, entity_id, context_json, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          "",
          "",
          "info",
          "feedback_cluster",
          `feedback cluster merged: ${input.feedbackType} query 归并到簇 ${mergedKey}（cosine=${bestScore.toFixed(3)} ≥ ${FEEDBACK_CLUSTER_SIMILARITY_THRESHOLD}）`,
          "completed",
          "system",
          "project",
          input.projectId,
          JSON.stringify({ projectId: input.projectId, feedbackType: input.feedbackType, query: input.query, mergedInto: best.query, score: bestScore, threshold: FEEDBACK_CLUSTER_SIMILARITY_THRESHOLD }),
          new Date().toISOString(),
        ],
      );
      return mergedKey;
    }
    return `q::${hashClusterQuery(input.query)}`;
  } catch (err) {
    if (err instanceof DenseModelUnavailableError) {
      return `q::${normalizeClusterQuery(input.query)}`;
    }
    throw err;
  }
}
