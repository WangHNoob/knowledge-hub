import { describe, expect, it } from "vitest";

import type { OkfSearchResultItem } from "../src/server/services/okf/searchIndex";
import {
  RerankModelUnavailableError,
  rerankSearchResults,
  resolveRerankMethod,
  type Reranker,
} from "../src/server/services/okf/rerank";

function item(componentId: string, title: string, snippet = "snippet"): OkfSearchResultItem {
  return {
    componentId,
    title,
    artifactId: `wiki/${title}`,
    okfPath: `/wiki/${title}`,
    kind: "wiki_page",
    type: "concept",
    trust: null,
    snippet,
    score: 1,
    matchedTerms: [],
    matchedFields: ["lexical"],
    why: ["lexical 命中"],
    tableDependencies: [],
  };
}

describe("okf rerank (Phase B)", () => {
  it("resolveRerankMethod: cross_encoder only for explicit env value", () => {
    expect(resolveRerankMethod({ OKF_RERANK: "cross_encoder" })).toBe("cross_encoder");
    expect(resolveRerankMethod({ OKF_RERANK: "CROSS_ENCODER" })).toBe("cross_encoder");
    expect(resolveRerankMethod({})).toBe("off");
    expect(resolveRerankMethod({ OKF_RERANK: "llm" })).toBe("off");
    expect(resolveRerankMethod({ OKF_RERANK: "off" })).toBe("off");
  });

  it("reranks candidates by cross-encoder score and truncates to limit", async () => {
    const fake: Reranker = {
      async score(_query, pairs) {
        // 按 componentId 给分：b 最高、d 次之（与输入顺序无关，验证确实重排）
        const scoreById: Record<string, number> = { a: 0.1, b: 0.9, c: 0.5, d: 0.7 };
        return pairs.map((pair) => scoreById[pair.componentId] ?? 0);
      },
    };
    const items = [item("a", "甲页"), item("b", "乙页"), item("c", "丙页"), item("d", "丁页")];
    const result = await rerankSearchResults("query", items, 2, { reranker: fake });
    expect(result.reranked).toBe(true);
    expect(result.items.map((i) => i.componentId)).toEqual(["b", "d"]);
    expect(result.items[0]!.why.join(" ")).toContain("cross-encoder 精排");
  });

  it("uses provided texts map for scoring", async () => {
    let scored: string[] = [];
    const fake: Reranker = {
      async score(_query, pairs) {
        scored = pairs.map((p) => p.text);
        return pairs.map((_, i) => i);
      },
    };
    const texts = new Map([["a", "来自 map 的文本"]]);
    await rerankSearchResults("q", [item("a", "甲页", "fallback snippet"), item("b", "乙页")], 1, { reranker: fake, texts });
    expect(scored[0]).toBe("来自 map 的文本");
    expect(scored[1]).toContain("乙页");
  });

  it("no-op when pool is too small or limit covers all", async () => {
    const fake: Reranker = { async score() { return [1, 2]; } };
    const single = [item("a", "甲页")];
    expect((await rerankSearchResults("q", single, 5, { reranker: fake })).reranked).toBe(false);
    const two = [item("a", "甲页"), item("b", "乙页")];
    expect((await rerankSearchResults("q", two, 2, { reranker: fake })).reranked).toBe(false);
    expect((await rerankSearchResults("q", two, 0, { reranker: fake })).reranked).toBe(false);
  });

  it("degrades to original order when the model is unavailable (no throw)", async () => {
    const fake: Reranker = {
      async score() {
        throw new RerankModelUnavailableError(new Error("no model"));
      },
    };
    const items = [item("a", "甲页"), item("b", "乙页"), item("c", "丙页")];
    const result = await rerankSearchResults("q", items, 1, { reranker: fake });
    expect(result.reranked).toBe(false);
    expect(result.items.map((i) => i.componentId)).toEqual(["a", "b", "c"]);
  });
});
