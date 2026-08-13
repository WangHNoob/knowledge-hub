import { describe, expect, it } from "vitest";

import {
  buildOkfDenseIndexV2,
  DENSE_INDEX_URI_V2,
  embedQueryForDenseIndex,
  resolveDenseMethod,
  searchDenseIndexV2Aware,
} from "../src/server/services/okf/denseIndexV2";
import { buildOkfDenseIndex, searchDenseIndex } from "../src/server/services/okf/hybridSearch";
import type { OkfSearchIndex, OkfSearchPage } from "../src/server/services/okf/searchIndex";
import { tokenizeSearchText } from "../src/server/services/okf/searchIndex";

function makePage(componentId: string, title: string): OkfSearchPage {
  const fields = {
    title,
    path: `/wiki/${title}`,
    type: "concept",
    headings: [title],
    body: `${title} 正文内容说明`,
    dataDependencies: "",
    tables: [] as string[],
    citations: [] as string[],
  };
  const terms = {
    title: tokenizeSearchText(fields.title),
    path: [] as string[],
    type: [] as string[],
    headings: tokenizeSearchText(title),
    body: tokenizeSearchText(fields.body),
    dataDependencies: [] as string[],
    tables: [] as string[],
    citations: [] as string[],
  };
  return {
    componentId,
    title,
    artifactId: `wiki/${title}`,
    okfPath: `/wiki/${title}`,
    kind: "wiki_page",
    type: "concept",
    trust: null,
    fields,
    terms,
  };
}

const indexFixture: OkfSearchIndex = {
  okfAssetType: "search_index",
  version: "v1",
  generatedAt: "2026-08-13T00:00:00.000Z",
  pages: [makePage("p1", "目标页 甲"), makePage("p2", "干扰页 乙")],
};

const fakeEmbedder = {
  calls: 0,
  async embed(texts: string[]): Promise<number[][]> {
    this.calls += 1;
    return texts.map(() => [0, 1, 0]);
  },
};

describe("denseIndexV2 (flywheel 02-P2)", () => {
  it("resolveDenseMethod defaults to fastembed and falls back on invalid values", () => {
    expect(resolveDenseMethod({})).toBe("fastembed");
    expect(resolveDenseMethod({ OKF_DENSE_METHOD: "hashing_trick" })).toBe("hashing_trick");
    expect(resolveDenseMethod({ OKF_DENSE_METHOD: "bogus" })).toBe("hashing_trick");
  });

  it("buildOkfDenseIndexV2 produces a v2 index with injected embedder", async () => {
    const dense = await buildOkfDenseIndexV2(indexFixture, { embedder: fakeEmbedder });
    expect(dense.version).toBe("v2");
    expect(dense.method).toBe("fastembed");
    expect(dense.dim).toBe(3);
    expect(dense.vectors).toHaveLength(2);
    expect(dense.vectors[0]).toMatchObject({ componentId: "p1", title: "目标页 甲" });
    expect(dense.vectors[0]!.embedding).toEqual([0, 1, 0]);
    expect(DENSE_INDEX_URI_V2).toBe("search/dense.v2.json");
  });

  it("embedQueryForDenseIndex keeps v1 indexes on the hashing trick", async () => {
    const v1 = buildOkfDenseIndex(indexFixture);
    const vec = await embedQueryForDenseIndex(v1, "甲", fakeEmbedder);
    expect(vec.length).toBe(64); // hashing trick dim
  });

  it("embedQueryForDenseIndex uses the same model for fastembed indexes with LRU cache", async () => {
    const v2 = await buildOkfDenseIndexV2(indexFixture, { embedder: fakeEmbedder });
    const probe = { ...fakeEmbedder, calls: 0 };
    const first = await embedQueryForDenseIndex(v2, "查询Q1", probe);
    const second = await embedQueryForDenseIndex(v2, "查询Q1", probe);
    expect(first).toEqual([0, 1, 0]);
    expect(second).toEqual(first);
    expect(probe.calls).toBe(1); // 命中缓存，不重复推理
  });

  it("searchDenseIndexV2Aware ranks fastembed vectors by cosine", async () => {
    const v2 = {
      okfAssetType: "search_dense_index" as const,
      version: "v2",
      generatedAt: "2026-08-13T00:00:00.000Z",
      dim: 3,
      method: "fastembed",
      vectors: [
        { componentId: "p1", artifactId: "a", okfPath: "/p1", title: "t1", embedding: [1, 0, 0] },
        { componentId: "p2", artifactId: "b", okfPath: "/p2", title: "t2", embedding: [0, 1, 0] },
      ],
    };
    const ranks = await searchDenseIndexV2Aware(v2, "任意查询", 10, {
      async embed() {
        return [[0, 1, 0]];
      },
    });
    expect(ranks.map((row) => row.componentId)).toEqual(["p2"]);
    expect(ranks[0]!.score).toBeGreaterThan(0.9);
    // p1 与 query 正交 → 被 score > 0.01 过滤
  });

  it("v1 dense path in searchDenseIndexV2Aware matches searchDenseIndex", async () => {
    const v1 = buildOkfDenseIndex(indexFixture);
    const aware = await searchDenseIndexV2Aware(v1, "甲", 10, fakeEmbedder);
    const plain = searchDenseIndex(v1, "甲", 10);
    expect(aware.map((row) => row.componentId)).toEqual(plain.map((row) => row.componentId));
  });
});
