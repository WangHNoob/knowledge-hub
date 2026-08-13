import type { OkfSearchIndex } from "./searchIndex";
import type { OkfDenseIndex } from "./hybridSearch";

/**
 * 检索 dense 索引 v2（真实 embedding，替代 hashing-trick v1）。
 *
 * 骨架（方案 02 Phase 1）：提供方法开关与 fastembed 加载路径；模型推理
 * 在 Phase 2 接入构建管线。@fastembed/fastembed 为可选依赖——未安装或
 * 加载失败时抛 DenseModelUnavailableError，调用方应回退 v1 并告警，
 * 绝不静默产出劣质索引。
 *
 * 运行要求：Node 22+；首次加载会下载/缓存模型（
 * BAAI/bge-small-zh-v1.5，ONNX，CPU 可跑）。
 */

export type DenseMethod = "fastembed" | "hashing_trick";

/** 环境变量 OKF_DENSE_METHOD 决定索引构建方法；非法值回退 hashing_trick。 */
export function resolveDenseMethod(env: NodeJS.ProcessEnv = process.env): DenseMethod {
  const value = (env.OKF_DENSE_METHOD ?? "fastembed").trim().toLowerCase();
  return value === "fastembed" ? "fastembed" : "hashing_trick";
}

export class DenseModelUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `fastembed 模型不可用：${cause instanceof Error ? cause.message : String(cause)}`
        + "（可安装 @fastembed/fastembed 并设置 OKF_DENSE_METHOD=fastembed，或回退 hashing_trick）",
    );
    this.name = "DenseModelUnavailableError";
  }
}

export interface FastembedEmbedder {
  embed(texts: string[]): Promise<number[][]>;
}

let embedderSingleton: FastembedEmbedder | null | undefined;

/** 惰性加载 fastembed 嵌入器（进程内单例；失败缓存为不可用）。 */
export async function loadFastembedEmbedder(): Promise<FastembedEmbedder> {
  if (embedderSingleton) return embedderSingleton;
  try {
    // @fastembed/fastembed 为可选依赖：动态 import 走 string 形式，
    // 未安装时在运行时抛 MODULE_NOT_FOUND，由 DenseModelUnavailableError 包装。
    const mod: unknown = await import("@fastembed/fastembed" as string);
    const factory = (mod as { TextEmbedding?: unknown }).TextEmbedding;
    if (!factory || typeof (factory as { init?: unknown }).init !== "function") {
      throw new Error("@fastembed/fastembed TextEmbedding.init is unavailable");
    }
    const instance = await (factory as { init: (opts?: Record<string, unknown>) => Promise<unknown> }).init({
      model: "BAAI/bge-small-zh-v1.5",
    });
    const embed = async (texts: string[]): Promise<number[][]> => {
      const rows = await (instance as { embed: (texts: string[]) => Promise<Iterable<number[]>> }).embed(texts);
      return Array.from(rows);
    };
    embedderSingleton = { embed };
    return embedderSingleton;
  } catch (err) {
    embedderSingleton = null;
    throw new DenseModelUnavailableError(err);
  }
}

/** 用真实 embedding 构建 v2 dense 索引；模型不可用即抛错（由调用方回退 v1）。 */
export async function buildOkfDenseIndexV2(index: OkfSearchIndex, opts: { dim?: number } = {}): Promise<OkfDenseIndex> {
  const embedder = await loadFastembedEmbedder();
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
