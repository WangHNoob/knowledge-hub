import { createHash } from "node:crypto";

import type { OkfSearchIndex, OkfSearchPage, OkfSearchResultItem } from "./searchIndex";
import { tokenizeSearchText } from "./searchIndex";

export const DENSE_INDEX_URI = "search/dense.json";
export const DENSE_DIM = 64;

export interface OkfDenseIndex {
  okfAssetType: "search_dense_index";
  /** v1 = hashing_trick，v2 = fastembed 真实 embedding（见 denseIndexV2.ts） */
  version: string;
  generatedAt: string;
  dim: number;
  method: string;
  vectors: Array<{
    componentId: string;
    artifactId: string;
    okfPath: string;
    title: string;
    embedding: number[];
  }>;
}

/** Offline-friendly dense vectors from page terms (no external embedding API). */
export function buildOkfDenseIndex(index: OkfSearchIndex): OkfDenseIndex {
  return {
    okfAssetType: "search_dense_index",
    version: "v1",
    generatedAt: index.generatedAt,
    dim: DENSE_DIM,
    method: "hashing_trick_v1",
    vectors: index.pages.map((page) => ({
      componentId: page.componentId,
      artifactId: page.artifactId,
      okfPath: page.okfPath,
      title: page.title,
      embedding: embedText(pageEmbeddingText(page)),
    })),
  };
}

export function searchDenseIndex(
  dense: OkfDenseIndex,
  query: string,
  limit = 10,
): Array<{ componentId: string; score: number; rank: number }> {
  const queryVec = embedText(query);
  const scored = dense.vectors
    .map((row) => ({
      componentId: row.componentId,
      score: cosine(queryVec, row.embedding),
    }))
    .filter((row) => row.score > 0.01)
    .sort((a, b) => b.score - a.score || a.componentId.localeCompare(b.componentId));
  return scored.slice(0, limit).map((row, index) => ({ ...row, rank: index + 1 }));
}

/** Reciprocal Rank Fusion of lexical + dense ranked lists. */
export function fuseSearchWithRrf(
  lexical: OkfSearchResultItem[],
  denseRanks: Array<{ componentId: string; score: number; rank: number }>,
  pageById: Map<string, OkfSearchPage>,
  limit: number,
  k = 60,
): OkfSearchResultItem[] {
  const scores = new Map<string, number>();
  const lexicalById = new Map(lexical.map((item, index) => [item.componentId, { item, rank: index + 1 }] as const));
  for (const [componentId, entry] of lexicalById) {
    scores.set(componentId, (scores.get(componentId) ?? 0) + 1 / (k + entry.rank));
  }
  for (const dense of denseRanks) {
    scores.set(dense.componentId, (scores.get(dense.componentId) ?? 0) + 1 / (k + dense.rank));
  }
  const fusedIds = [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([componentId]) => componentId);

  return fusedIds.map((componentId) => {
    const lexicalHit = lexicalById.get(componentId)?.item;
    if (lexicalHit) {
      const dense = denseRanks.find((row) => row.componentId === componentId);
      return {
        ...lexicalHit,
        score: scores.get(componentId) ?? lexicalHit.score,
        why: [
          ...lexicalHit.why,
          dense ? `dense RRF 命中（cosine=${dense.score.toFixed(3)}）` : "lexical RRF 命中",
        ],
        matchedFields: unique([...lexicalHit.matchedFields, "dense"]),
      };
    }
    const page = pageById.get(componentId);
    const dense = denseRanks.find((row) => row.componentId === componentId);
    return {
      componentId,
      title: page?.title ?? componentId,
      artifactId: page?.artifactId ?? "",
      okfPath: page?.okfPath ?? "",
      kind: page?.kind ?? "",
      type: page?.type ?? "",
      trust: page?.trust ?? null,
      snippet: (page?.fields.body ?? "").slice(0, 180),
      score: scores.get(componentId) ?? 0,
      matchedTerms: tokenizeSearchText(page?.title ?? ""),
      matchedFields: ["dense"],
      why: [`dense RRF 命中（cosine=${(dense?.score ?? 0).toFixed(3)}）`],
      tableDependencies: page?.fields.tables ?? [],
    } satisfies OkfSearchResultItem;
  });
}

export function embedText(text: string): number[] {
  const vec = new Array<number>(DENSE_DIM).fill(0);
  const tokens = tokenizeSearchText(text);
  if (tokens.length === 0) return vec;
  for (const token of tokens) {
    const digest = createHash("sha1").update(token).digest();
    const index = digest.readUInt16BE(0) % DENSE_DIM;
    const sign = (digest[2] ?? 0) & 1 ? 1 : -1;
    vec[index] += sign;
  }
  return l2Normalize(vec);
}

function pageEmbeddingText(page: OkfSearchPage): string {
  return [
    page.fields.title,
    page.fields.headings.join(" "),
    page.fields.type,
    page.fields.tables.join(" "),
    page.fields.dataDependencies,
    page.fields.body.slice(0, 2000),
  ].join("\n");
}

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i += 1) dot += a[i]! * b[i]!;
  return dot;
}

/** 余弦相似度（向量已 L2 归一化时为点积）。dense v2 查询侧复用。 */
export function cosineSimilarity(a: number[], b: number[]): number {
  return cosine(a, b);
}

/** L2 归一化。dense v2 查询侧复用（fastembed 输出的 query 向量）。 */
export function l2Normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0));
  if (norm <= 0) return vec;
  return vec.map((value) => value / norm);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
