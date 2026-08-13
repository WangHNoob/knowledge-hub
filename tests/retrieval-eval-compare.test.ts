import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { compareGate, hitAtK, runCompareOnBundle } from "../scripts/eval-retrieval";
import { buildOkfDenseIndex } from "../src/server/services/okf/hybridSearch";
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

const gold = {
  cases: [{ id: "EV-T", query: "甲", expectTitleSubstrings: ["目标页 甲"] }],
};

interface DenseV2Vector {
  componentId: string;
  embedding: number[];
}

function makeBundle(v2Vectors?: DenseV2Vector[]): string {
  const dir = mkdtempSync(join(tmpdir(), "kh-retrieval-compare-"));
  mkdirSync(join(dir, "search"), { recursive: true });
  const index: OkfSearchIndex = {
    okfAssetType: "search_index",
    version: "v1",
    generatedAt: "2026-08-13T00:00:00.000Z",
    // 注意：正确页用 "p2"、干扰页用 "p1"——RRF 平局按 componentId 升序，
    // 使"v2 dense 把干扰页排第一"的回归场景可确定性复现。
    pages: [makePage("p1", "干扰页 乙"), makePage("p2", "目标页 甲")],
  };
  writeFileSync(join(dir, "search", "index.json"), JSON.stringify(index), "utf8");
  writeFileSync(join(dir, "search", "dense.json"), JSON.stringify(buildOkfDenseIndex(index)), "utf8");
  if (v2Vectors) {
    const denseV2 = {
      okfAssetType: "search_dense_index",
      version: "v2",
      generatedAt: "2026-08-13T00:00:00.000Z",
      dim: 3,
      method: "fastembed",
      vectors: v2Vectors.map((row) => ({
        componentId: row.componentId,
        artifactId: row.componentId === "p1" ? "a" : "b",
        okfPath: row.componentId === "p1" ? "/p1" : "/p2",
        title: row.componentId === "p1" ? "干扰页 乙" : "目标页 甲",
        embedding: row.embedding,
      })),
    };
    writeFileSync(join(dir, "search", "dense.v2.json"), JSON.stringify(denseV2), "utf8");
  }
  return dir;
}

const dirs: string[] = [];

function withBundle(v2Vectors?: DenseV2Vector[]): string {
  const dir = makeBundle(v2Vectors);
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("eval-retrieval v1/v2 compare (flywheel 02-P2)", () => {
  it("hitAtK requires an expected title substring in the top-k", () => {
    expect(hitAtK(["目标页 甲"], ["目标页 甲"])).toBe(true);
    expect(hitAtK(["干扰页 乙"], ["目标页 甲"])).toBe(false);
    expect(hitAtK([], ["目标页 甲"])).toBe(false);
    expect(hitAtK(["任意页"], [])).toBe(true); // 无期望 = 有结果即算
  });

  it("v1 and v2 both hit when v2 embeddings align with the query", async () => {
    const summary = await runCompareOnBundle(withBundle([
      { componentId: "p1", embedding: [0, 1, 0] },
      { componentId: "p2", embedding: [0, 1, 0] },
    ]), gold, 1, {
      embedder: { async embed() { return [[0, 1, 0]]; } },
    });
    expect(summary.v1HitAtK).toBe(1);
    expect(summary.v2HitAtK).toBe(1);
    expect(summary.v2Available).toBe(true);
    expect(compareGate(summary).ok).toBe(true);
  });

  it("v2 regression (v2 ranks the wrong page first) fails the gate", async () => {
    const summary = await runCompareOnBundle(withBundle([
      // p2（正确页，词法命中）与 query 正交 → dense 侧被过滤；
      // p1（干扰页）cosine=1 → dense 排第一；RRF 平局按 id 升序 → p1 胜出
      { componentId: "p1", embedding: [0, 1, 0] },
      { componentId: "p2", embedding: [1, 0, 0] },
    ]), gold, 1, {
      embedder: { async embed() { return [[0, 1, 0]]; } },
    });
    expect(summary.v1HitAtK).toBe(1);
    expect(summary.v2HitAtK).toBe(0);
    expect(summary.cases[0]!.v1Hit).toBe(true);
    expect(summary.cases[0]!.v2Hit).toBe(false);
    const gate = compareGate(summary);
    expect(gate.ok).toBe(false);
    expect(gate.reasons.join(" ")).toContain("回退");
  });

  it("v2 unavailable (no dense.v2.json) is not a regression", async () => {
    const summary = await runCompareOnBundle(withBundle(), gold, 1, {
      embedder: { async embed() { throw new Error("no model"); } },
    });
    expect(summary.v2Available).toBe(false);
    const gate = compareGate(summary);
    expect(gate.ok).toBe(true);
    expect(gate.reasons.join(" ")).toContain("不可用");
  });
});
