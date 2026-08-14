import type { OkfSearchResultItem } from "./searchIndex";

/**
 * 检索精排（Phase B，方案 02 §2.1）：RRF top-N → 轻量 cross-encoder 重排 → top-k。
 *
 * 默认关闭（OKF_RERANK=off）：精排有模型推理开销（CPU 上每 query 数百 ms），
 * 只有在评测证明收益后才在运行时开启（OKF_RERANK=cross_encoder）。
 * 模型不可用/未配置时静默跳过精排（返回原序），绝不阻断检索主链路——
 * 与 dense v2 的降级策略一致（flywheel 02-P2）。
 */

export type RerankMethod = "cross_encoder" | "off";

/** 环境变量 OKF_RERANK 决定精排方法；非法值回退 off。 */
export function resolveRerankMethod(env: NodeJS.ProcessEnv = process.env): RerankMethod {
  const value = (env.OKF_RERANK ?? "off").trim().toLowerCase();
  return value === "cross_encoder" ? "cross_encoder" : "off";
}

export class RerankModelUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `cross-encoder 精排模型不可用：${cause instanceof Error ? cause.message : String(cause)}`
        + "（可安装 @xenova/transformers 并确保模型可下载，或保持 OKF_RERANK=off 跳过精排）",
    );
    this.name = "RerankModelUnavailableError";
  }
}

export interface RerankPair {
  componentId: string;
  text: string;
}

/** 精排器：对 (query, 文档) 对打分，返回与 pairs 同序的分数（越高越相关）。 */
export interface Reranker {
  score(query: string, pairs: RerankPair[]): Promise<number[]>;
}

let rerankerSingleton: Reranker | null | undefined;

/** 惰性加载 cross-encoder 精排器（进程内单例；失败缓存为不可用）。 */
export async function loadCrossEncoderReranker(): Promise<Reranker> {
  if (rerankerSingleton) return rerankerSingleton;
  try {
    // @xenova/transformers 为可选依赖：动态 import 走 string 形式，
    // 未安装时在运行时抛 MODULE_NOT_FOUND，由 RerankModelUnavailableError 包装。
    const mod: unknown = await import("@xenova/transformers" as string);
    const { AutoTokenizer, AutoModelForSequenceClassification } = mod as {
      AutoTokenizer?: { from_pretrained?: unknown };
      AutoModelForSequenceClassification?: { from_pretrained?: unknown };
    };
    if (
      typeof AutoTokenizer?.from_pretrained !== "function"
      || typeof AutoModelForSequenceClassification?.from_pretrained !== "function"
    ) {
      throw new Error("@xenova/transformers AutoTokenizer/AutoModelForSequenceClassification.from_pretrained unavailable");
    }
    // 模型仓库镜像（与 dense v2 共用 OKF_HF_ENDPOINT，如 https://hf-mirror.com）
    const remoteHost = process.env.OKF_HF_ENDPOINT;
    if (remoteHost) {
      const envMod = (mod as { env?: { remoteHost?: string } }).env;
      if (envMod) envMod.remoteHost = remoteHost;
    }
    const tokenizer = await (AutoTokenizer.from_pretrained as (model: string) => Promise<unknown>)("Xenova/bge-reranker-base");
    const model = await (AutoModelForSequenceClassification.from_pretrained as (
      model: string,
      opts?: Record<string, unknown>,
    ) => Promise<unknown>)("Xenova/bge-reranker-base", { quantized: true });
    const score = async (query: string, pairs: RerankPair[]): Promise<number[]> => {
      if (pairs.length === 0) return [];
      const queries = pairs.map(() => query);
      const docs = pairs.map((pair) => pair.text);
      const inputs = await (tokenizer as (texts: string[], opts?: Record<string, unknown>) => Promise<unknown>)(queries, {
        text_pair: docs,
        padding: true,
        truncation: true,
      });
      const outputs = await (model as (inputs: unknown) => Promise<{ logits?: { tolist: () => number[][] } }>)(inputs);
      const logits = outputs.logits?.tolist() ?? [];
      return logits.map((row) => row[0] ?? 0);
    };
    rerankerSingleton = { score };
    return rerankerSingleton;
  } catch (err) {
    rerankerSingleton = null;
    throw new RerankModelUnavailableError(err);
  }
}

export interface RerankSearchOptions {
  /** 注入精排器（测试用）；缺省时惰性加载真实 cross-encoder。 */
  reranker?: Reranker;
  /** componentId → 精排用文本（建议 pageEmbeddingText）；缺省回退 title + snippet。 */
  texts?: Map<string, string>;
}

export interface RerankSearchResult {
  items: OkfSearchResultItem[];
  /** true = 本次确实发生了精排重排；false = 跳过（池太小/模型不可用）。 */
  reranked: boolean;
}

/**
 * 对候选结果做 cross-encoder 精排并截断到 limit。
 * 模型不可用时降级为原序返回（console.warn 留痕），绝不抛错阻断检索。
 */
export async function rerankSearchResults(
  query: string,
  items: OkfSearchResultItem[],
  limit: number,
  opts: RerankSearchOptions = {},
): Promise<RerankSearchResult> {
  if (items.length <= 1 || limit <= 0 || limit >= items.length) {
    return { items, reranked: false };
  }
  let reranker: Reranker;
  try {
    reranker = opts.reranker ?? await loadCrossEncoderReranker();
  } catch (err) {
    if (err instanceof RerankModelUnavailableError) {
      console.warn(`[rerank] 精排模型不可用，本次跳过精排：${err.message}`);
      return { items, reranked: false };
    }
    throw err;
  }
  const pairs: RerankPair[] = items.map((item) => ({
    componentId: item.componentId,
    text: opts.texts?.get(item.componentId) ?? `${item.title}\n${item.snippet ?? ""}`,
  }));
  let scores: number[];
  try {
    scores = await reranker.score(query, pairs);
  } catch (err) {
    if (err instanceof RerankModelUnavailableError) {
      console.warn(`[rerank] 精排打分失败（模型不可用），本次跳过精排：${err.message}`);
      return { items, reranked: false };
    }
    throw err;
  }
  const ranked = items
    .map((item, index) => ({ item, score: scores[index] ?? 0 }))
    .sort((a, b) => b.score - a.score || a.item.componentId.localeCompare(b.item.componentId));
  return {
    items: ranked.slice(0, limit).map(({ item, score }) => ({
      ...item,
      why: [...item.why, `cross-encoder 精排（score=${score.toFixed(4)}）`],
    })),
    reranked: true,
  };
}
