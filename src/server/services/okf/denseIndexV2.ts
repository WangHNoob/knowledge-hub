import type { OkfSearchIndex } from "./searchIndex";
import type { OkfDenseIndex } from "./hybridSearch";
import { cosineSimilarity, embedText, l2Normalize } from "./hybridSearch";

/**
 * 检索 dense 索引 v2（真实 embedding，替代 hashing-trick v1）。
 *
 * 骨架（方案 02 Phase 1）：提供方法开关与模型加载路径；模型推理在
 * Phase 2 接入构建管线。@xenova/transformers 为可选依赖——未安装或
 * 加载失败（含模型下载不可达）时抛 DenseModelUnavailableError，调用方
 * 应回退 v1 并告警，绝不静默产出劣质索引。
 *
 * 运行要求：Node 22+；首次加载会下载/缓存模型（
 * Xenova/bge-small-zh-v1.5 量化版，ONNX，CPU 可跑，query 推理约数十毫秒）。
 */

export type DenseMethod = "fastembed" | "hashing_trick";

/** v2 索引产物路径（v1 保留 search/dense.json 作回退与评测对比基线）。 */
export const DENSE_INDEX_URI_V2 = "search/dense.v2.json";

/** 环境变量 OKF_DENSE_METHOD 决定索引构建方法；非法值回退 hashing_trick。 */
export function resolveDenseMethod(env: NodeJS.ProcessEnv = process.env): DenseMethod {
  const value = (env.OKF_DENSE_METHOD ?? "fastembed").trim().toLowerCase();
  return value === "fastembed" ? "fastembed" : "hashing_trick";
}

export class DenseModelUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `embedding 模型不可用：${cause instanceof Error ? cause.message : String(cause)}`
        + "（可安装 @xenova/transformers 并确保模型可下载，或回退 hashing_trick）",
    );
    this.name = "DenseModelUnavailableError";
  }
}

export interface FastembedEmbedder {
  embed(texts: string[]): Promise<number[][]>;
}

let embedderSingleton: FastembedEmbedder | null | undefined;

/** 惰性加载 embedding 嵌入器（进程内单例；失败缓存为不可用）。 */
export async function loadFastembedEmbedder(): Promise<FastembedEmbedder> {
  if (embedderSingleton) return embedderSingleton;
  try {
    // @xenova/transformers 为可选依赖：动态 import 走 string 形式，
    // 未安装时在运行时抛 MODULE_NOT_FOUND，由 DenseModelUnavailableError 包装。
    const mod: unknown = await import("@xenova/transformers" as string);
    const pipeline = (mod as { pipeline?: unknown }).pipeline;
    if (typeof pipeline !== "function") {
      throw new Error("@xenova/transformers pipeline is unavailable");
    }
    // 模型仓库镜像（如 OKF_HF_ENDPOINT=https://hf-mirror.com，供国内部署）
    const remoteHost = process.env.OKF_HF_ENDPOINT;
    if (remoteHost) {
      const envMod = (mod as { env?: { remoteHost?: string } }).env;
      if (envMod) envMod.remoteHost = remoteHost;
    }
    const extractor = await (pipeline as (
      task: string,
      model: string,
      opts?: Record<string, unknown>,
    ) => Promise<unknown>)("feature-extraction", "Xenova/bge-small-zh-v1.5", { quantized: true });
    const embed = async (texts: string[]): Promise<number[][]> => {
      const output = await (extractor as (texts: string[], opts?: Record<string, unknown>) => Promise<{ tolist: () => number[][] }>)(texts, {
        pooling: "mean",
        normalize: true,
      });
      return output.tolist();
    };
    embedderSingleton = { embed };
    return embedderSingleton;
  } catch (err) {
    embedderSingleton = null;
    throw new DenseModelUnavailableError(err);
  }
}

/** 用真实 embedding 构建 v2 dense 索引；模型不可用即抛错（由调用方回退 v1）。 */
export async function buildOkfDenseIndexV2(
  index: OkfSearchIndex,
  opts: { dim?: number; embedder?: FastembedEmbedder } = {},
): Promise<OkfDenseIndex> {
  const embedder = opts.embedder ?? await loadFastembedEmbedder();
  const pageTexts = index.pages.map((page) => pageEmbeddingText(page));
  const vectors = await embedder.embed(pageTexts);
  const dim = opts.dim ?? (vectors[0]?.length ?? 512);
  return {
    okfAssetType: "search_dense_index",
    version: "v2",
    generatedAt: index.generatedAt,
    dim,
    method: "fastembed",
    vectors: index.pages.map((page, i) => ({
      componentId: page.componentId,
      artifactId: page.artifactId,
      okfPath: page.okfPath,
      title: page.title,
      embedding: vectors[i] ?? [],
    })),
  };
}

// ─── 查询侧（Phase 2）：v2 索引用同模型推理 query 向量，v1 回退 hashing trick ───

const QUERY_CACHE_MAX = 256;
const queryEmbeddingCache = new Map<string, number[]>();

/**
 * 为一次查询产出与 dense 索引同空间的向量：
 * - fastembed 索引 → 同模型推理（进程内 LRU 缓存，重复 query 零成本）；
 * - v1 索引 → hashing trick（与 searchDenseIndex 一致）。
 */
export async function embedQueryForDenseIndex(
  dense: OkfDenseIndex,
  query: string,
  embedder?: FastembedEmbedder,
): Promise<number[]> {
  if (dense.method !== "fastembed") return embedText(query);
  const cached = queryEmbeddingCache.get(query);
  if (cached) return cached;
  const model = embedder ?? await loadFastembedEmbedder();
  const rows = await model.embed([query]);
  const vec = l2Normalize(rows[0] ?? []);
  if (queryEmbeddingCache.size >= QUERY_CACHE_MAX) {
    const oldest = queryEmbeddingCache.keys().next().value;
    if (oldest !== undefined) queryEmbeddingCache.delete(oldest);
  }
  queryEmbeddingCache.set(query, vec);
  return vec;
}

/**
 * dense 检索（v1/v2 感知）。v2 且模型不可用时抛 DenseModelUnavailableError，
 * 调用方捕获后应退化为纯词法检索（绝不静默错配）。
 */
export async function searchDenseIndexV2Aware(
  dense: OkfDenseIndex,
  query: string,
  limit = 10,
  embedder?: FastembedEmbedder,
): Promise<Array<{ componentId: string; score: number; rank: number }>> {
  const queryVec = await embedQueryForDenseIndex(dense, query, embedder);
  const scored = dense.vectors
    .map((row) => ({
      componentId: row.componentId,
      score: cosineSimilarity(queryVec, row.embedding),
    }))
    .filter((row) => row.score > 0.01)
    .sort((a, b) => b.score - a.score || a.componentId.localeCompare(b.componentId));
  return scored.slice(0, limit).map((row, index) => ({ ...row, rank: index + 1 }));
}

/** 与 v1 对齐的页面嵌入文本（标题/标题层级/类型/表格/依赖/正文前 2000 字）。 */
export function pageEmbeddingText(page: OkfSearchIndex["pages"][number]): string {
  return [
    page.fields.title,
    page.fields.headings.join(" "),
    page.fields.type,
    page.fields.tables.join(" "),
    page.fields.dataDependencies,
    page.fields.body.slice(0, 2000),
  ].join("\n");
}
