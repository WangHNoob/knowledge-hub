import type { OkfSearchIndex, OkfSearchResultItem } from "./searchIndex";
import type { OkfDenseIndex } from "./hybridSearch";
import { fuseSearchWithRrf, searchDenseIndex } from "./hybridSearch";
import type { FastembedEmbedder } from "./denseIndexV2";
import { searchDenseIndexV2Aware } from "./denseIndexV2";
import { resolveRerankMethod, rerankSearchResults, type RerankMethod, type Reranker } from "./rerank";

/**
 * 条件式混合检索（flywheel 02 §2.1 决策落地，2026-08-14 实测驱动）。
 *
 * 证据：原始 gold（词法可直中）v1 100% vs v2 85.9%——v2 语义重排会打乱词法结果；
 * 同义改写集（零词法重叠）v1 0% vs v2 25%（+精排 37.5%）——纯词法对语义查询无能为力。
 *
 * 结论设计：**词法强命中 → 走 v1 管线（lexical + hashing-trick RRF），保持不回退；
 * 词法弱命中 → v2 语义兜底（lexical + bge-small-zh RRF，OKF_RERANK=cross_encoder
 * 时再接精排）**。判定用词法 top-1 score（< LEXICAL_WEAK_TOP1_SCORE 视为弱）：
 * 实测改写集 top-1 分 max=8.66 < 9 ≤ gold 除 EV-073(1.73) 外全部 ≥ 9.36。
 */

/** 词法弱命中阈值（标定值：改写集上界 8.66 / gold 下界 9.36）。 */
export const LEXICAL_WEAK_TOP1_SCORE = 9;

/** 语义兜底最小中文字符数：语义索引面向中文知识库（bge-small-zh 中文优化），
 *  仅对含足够中文内容的查询启用兜底，避免英文/无意义查询被 v2 噪音页"伪命中"
 *  （实测垃圾查询与改写集 cosine 完全重叠，余弦护栏不可行；中文域护栏可保
 *   miss→gap_fill 自进化信号不被饿死）。 */
export const SEMANTIC_FALLBACK_MIN_HAN = 4;

/** 查询是否含足够中文内容（Han 字符数 ≥ SEMANTIC_FALLBACK_MIN_HAN）。 */
export function hasChineseContent(query: string, minHan = SEMANTIC_FALLBACK_MIN_HAN): boolean {
  const han = query.match(/\p{Script=Han}/gu) ?? [];
  return han.length >= minHan;
}

export type SemanticFallbackMode = "on" | "off";

/** 环境变量 OKF_SEMANTIC_FALLBACK 控制语义兜底（默认 on）。 */
export function resolveSemanticFallback(env: NodeJS.ProcessEnv = process.env): SemanticFallbackMode {
  const value = (env.OKF_SEMANTIC_FALLBACK ?? "on").trim().toLowerCase();
  return value === "off" ? "off" : "on";
}

/** 词法是否"弱"：无命中或 top-1 score 低于阈值。 */
export function isLexicalWeak(lexical: OkfSearchResultItem[], threshold = LEXICAL_WEAK_TOP1_SCORE): boolean {
  const top1 = lexical[0];
  return !top1 || top1.score < threshold;
}

export type ConditionalMode = "lexical_strong" | "semantic_fallback";

export interface ConditionalRetrievalResult {
  items: OkfSearchResultItem[];
  mode: ConditionalMode;
  reranked: boolean;
}

export interface ConditionalRetrievalOptions {
  query: string;
  lexical: OkfSearchResultItem[];
  denseV1: OkfDenseIndex | null;
  denseV2: OkfDenseIndex | null;
  pageById: Map<OkfSearchIndex["pages"][number]["componentId"], OkfSearchIndex["pages"][number]>;
  limit: number;
  rerank: RerankMethod;
  embedder?: FastembedEmbedder;
  reranker?: Reranker;
  texts?: Map<string, string>;
  weakThreshold?: number;
}

/**
 * 条件式混合检索：
 * - 词法强 / v2 不可用 / 查询非中文（无足够 Han 内容）→ lexical_strong：
 *   lexical + v1（hashing-trick）RRF（现状管线，零行为变化）；
 * - 词法弱且 v2 可用且含中文内容 → semantic_fallback：lexical + v2（bge-small-zh）
 *   RRF，可选 cross-encoder 精排。
 * v2 模型不可用时由调用方捕获 DenseModelUnavailableError 降级 lexical_strong。
 */
export async function retrieveConditionalHybrid(
  opts: ConditionalRetrievalOptions,
): Promise<ConditionalRetrievalResult> {
  const pool = Math.max(opts.limit * 2, 20);
  if (
    isLexicalWeak(opts.lexical, opts.weakThreshold)
    && hasChineseContent(opts.query)
    && opts.denseV2 && opts.denseV2.vectors.length > 0
  ) {
    // ── 语义兜底：lexical（弱） + v2 dense RRF；可选精排 ──
    const denseRanks = await searchDenseIndexV2Aware(opts.denseV2, opts.query, pool, opts.embedder);
    const fused = fuseSearchWithRrf(opts.lexical, denseRanks, opts.pageById, pool);
    if (opts.rerank === "cross_encoder") {
      const reranked = await rerankSearchResults(opts.query, fused, opts.limit, {
        texts: opts.texts,
        reranker: opts.reranker,
      });
      return { items: reranked.items, mode: "semantic_fallback", reranked: reranked.reranked };
    }
    return { items: fused.slice(0, opts.limit), mode: "semantic_fallback", reranked: false };
  }
  // ── 词法强命中（或 v2 不可用）：沿用 v1 管线，行为与现状一致 ──
  const denseRanks = opts.denseV1 ? searchDenseIndex(opts.denseV1, opts.query, pool) : [];
  const fused = denseRanks.length > 0
    ? fuseSearchWithRrf(opts.lexical, denseRanks, opts.pageById, pool)
    : opts.lexical.slice(0, pool);
  return { items: fused.slice(0, opts.limit), mode: "lexical_strong", reranked: false };
}
