import { describe, expect, it } from "vitest";

import { retrieveConditionalHybrid, isLexicalWeak, resolveSemanticFallback, hasChineseContent, LEXICAL_WEAK_TOP1_SCORE } from "../src/server/services/okf/conditionalRetrieval";
import { buildOkfDenseIndex } from "../src/server/services/okf/hybridSearch";
import type { OkfSearchIndex, OkfSearchPage, OkfSearchResultItem } from "../src/server/services/okf/searchIndex";
import { tokenizeSearchText } from "../src/server/services/okf/searchIndex";
import { RerankModelUnavailableError } from "../src/server/services/okf/rerank";

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

function item(componentId: string, title: string, score: number): OkfSearchResultItem {
  return {
    componentId,
    title,
    artifactId: `wiki/${title}`,
    okfPath: `/wiki/${title}`,
    kind: "wiki_page",
    type: "concept",
    trust: null,
    snippet: `${title} 正文`,
    score,
    matchedTerms: [],
    matchedFields: ["lexical"],
    why: ["lexical 命中"],
    tableDependencies: [],
  };
}

const index: OkfSearchIndex = {
  okfAssetType: "search_index",
  version: "v1",
  generatedAt: "2026-08-14T00:00:00.000Z",
  pages: [makePage("p1", "甲页"), makePage("p2", "乙页"), makePage("p3", "丙页")],
};
const pageById = new Map(index.pages.map((p) => [p.componentId, p] as const));
const denseV1 = buildOkfDenseIndex(index);
const denseV2 = {
  okfAssetType: "search_dense_index" as const,
  version: "v2",
  generatedAt: "2026-08-14T00:00:00.000Z",
  dim: 3,
  method: "fastembed",
  vectors: [
    { componentId: "p1", artifactId: "a", okfPath: "/p1", title: "甲页", embedding: [0, 1, 0] },
    { componentId: "p2", artifactId: "b", okfPath: "/p2", title: "乙页", embedding: [1, 0, 0] },
    { componentId: "p3", artifactId: "c", okfPath: "/p3", title: "丙页", embedding: [0, 0, 1] },
  ],
};

const fakeEmbedder = {
  async embed(texts: string[]) {
    // 语义上把 query 映射到 p3（丙页）
    return texts.map(() => [0, 0, 1]);
  },
};

describe("conditional retrieval (OKF_SEMANTIC_FALLBACK)", () => {
  it("resolveSemanticFallback: default on, off only for explicit value", () => {
    expect(resolveSemanticFallback({})).toBe("on");
    expect(resolveSemanticFallback({ OKF_SEMANTIC_FALLBACK: "off" })).toBe("off");
    expect(resolveSemanticFallback({ OKF_SEMANTIC_FALLBACK: "ON" })).toBe("on");
    expect(resolveSemanticFallback({ OKF_SEMANTIC_FALLBACK: "bogus" })).toBe("on");
  });

  it("isLexicalWeak: no hits or low top-1 score is weak", () => {
    expect(isLexicalWeak([])).toBe(true);
    expect(isLexicalWeak([item("p1", "甲页", 0.5)])).toBe(true);
    expect(isLexicalWeak([item("p1", "甲页", LEXICAL_WEAK_TOP1_SCORE - 1)])).toBe(true);
    expect(isLexicalWeak([item("p1", "甲页", LEXICAL_WEAK_TOP1_SCORE)])).toBe(false);
    expect(isLexicalWeak([item("p1", "甲页", 50)])).toBe(false);
  });

  it("hasChineseContent: semantic fallback is gated on Chinese queries", () => {
    expect(hasChineseContent("打一下跳出来的那个数")).toBe(true);
    expect(hasChineseContent("语义查询")).toBe(true);
    expect(hasChineseContent("nonexistent resurrection economy")).toBe(false);
    expect(hasChineseContent("asdfghjkl qwerty")).toBe(false);
    expect(hasChineseContent("体力")).toBe(false); // < 4 Han 字符
    expect(hasChineseContent("H002 的技能组")).toBe(true);
  });

  it("strong lexical keeps the v1 pipeline and never touches v2", async () => {
    const strong = [item("p1", "甲页", 50), item("p2", "乙页", 30)];
    let v2Touched = false;
    const res = await retrieveConditionalHybrid({
      query: "甲",
      lexical: strong,
      denseV1,
      denseV2,
      pageById,
      limit: 1,
      rerank: "off",
      embedder: {
        async embed() {
          v2Touched = true;
          return [[0, 0, 1]];
        },
      },
    });
    expect(res.mode).toBe("lexical_strong");
    expect(res.reranked).toBe(false);
    expect(v2Touched).toBe(false);
    expect(res.items.map((i) => i.componentId)).toContain("p1");
  });

  it("weak lexical with v2 falls back to semantic dense", async () => {
    const weak = [item("p1", "甲页", 0.5), item("p2", "乙页", 0.3)];
    const res = await retrieveConditionalHybrid({
      query: "语义查询",
      lexical: weak,
      denseV1,
      denseV2,
      pageById,
      limit: 2,
      rerank: "off",
      embedder: fakeEmbedder,
    });
    expect(res.mode).toBe("semantic_fallback");
    // fakeEmbedder 把 query 映射到 p3 → p3 应进入结果
    expect(res.items.some((i) => i.componentId === "p3")).toBe(true);
  });

  it("weak lexical + rerank applies cross-encoder on the fallback", async () => {
    const weak = [item("p1", "甲页", 0.5)];
    const reranker = {
      async score(_query: string, pairs: Array<{ componentId: string; text: string }>) {
        // 把 p3 排到最前
        return pairs.map((pair) => (pair.componentId === "p3" ? 0.9 : 0.1));
      },
    };
    const res = await retrieveConditionalHybrid({
      query: "语义查询",
      lexical: weak,
      denseV1,
      denseV2,
      pageById,
      limit: 1,
      rerank: "cross_encoder",
      embedder: fakeEmbedder,
      reranker,
    });
    expect(res.mode).toBe("semantic_fallback");
    expect(res.reranked).toBe(true);
    expect(res.items[0]!.componentId).toBe("p3");
    expect(res.items[0]!.why.join(" ")).toContain("cross-encoder 精排");
  });

  it("weak lexical but rerank model unavailable degrades to unranked fallback (no throw)", async () => {
    const weak = [item("p1", "甲页", 0.5)];
    const res = await retrieveConditionalHybrid({
      query: "语义查询",
      lexical: weak,
      denseV1,
      denseV2,
      pageById,
      limit: 1,
      rerank: "cross_encoder",
      embedder: fakeEmbedder,
      reranker: {
        async score() {
          throw new RerankModelUnavailableError(new Error("no model"));
        },
      },
    });
    expect(res.mode).toBe("semantic_fallback");
    expect(res.reranked).toBe(false);
  });

  it("v2 unavailable falls back to the v1 pipeline even when lexical is weak", async () => {
    const weak = [item("p1", "甲页", 0.5)];
    const res = await retrieveConditionalHybrid({
      query: "语义查询",
      lexical: weak,
      denseV1,
      denseV2: null,
      pageById,
      limit: 1,
      rerank: "off",
    });
    expect(res.mode).toBe("lexical_strong");
    expect(res.items.some((i) => i.componentId === "p1")).toBe(true);
  });

  it("weak lexical but non-Chinese query keeps the lexical path (no semantic noise)", async () => {
    const weak = [item("p1", "甲页", 0.5)];
    let v2Touched = false;
    const res = await retrieveConditionalHybrid({
      query: "nonexistent resurrection economy",
      lexical: weak,
      denseV1,
      denseV2,
      pageById,
      limit: 1,
      rerank: "off",
      embedder: {
        async embed() {
          v2Touched = true;
          return [[0, 0, 1]];
        },
      },
    });
    expect(res.mode).toBe("lexical_strong");
    expect(v2Touched).toBe(false);
  });
});
