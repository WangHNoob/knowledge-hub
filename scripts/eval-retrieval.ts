#!/usr/bin/env node
/**
 * Retrieval eval against the current published release.
 *
 * 默认模式（回归门禁，与 releaseAutomationService 同源）：
 *   npx tsx scripts/eval-retrieval.ts [--gold evals/retrieval-gold.json] [--project default_project] [--k 5]
 *   [--min-hit 0.85] [--min-citation 0]
 *
 * v1/v2 对比模式（flywheel 02-P2：真实 embedding 是否回退检索质量）：
 *   npx tsx scripts/eval-retrieval.ts --compare-v1-v2 [--bundle <okf_bundle_dir>] [--rerank cross_encoder|off]
 *   --bundle 给出 OKF bundle 目录可免 DB（直接读 search/index.json + dense.json + dense.v2.json）；
 *   缺省时从 DB 解析当前 release 的 bundle。命中率 v2 < v1 时 exit 1（回归拦截）；
 *   fastembed 模型不可用则 v2 标记 skipped 并以 exit 0 通过（另发告警）。
 *   --rerank cross_encoder 开启 Phase B 精排（RRF top-20 → bge-reranker-base → top-k），
 *   默认取环境变量 OKF_RERANK（缺省 off）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { FastembedEmbedder } from "../src/server/services/okf/denseIndexV2";
import { DenseModelUnavailableError, pageEmbeddingText, searchDenseIndexV2Aware } from "../src/server/services/okf/denseIndexV2";
import { fuseSearchWithRrf, searchDenseIndex } from "../src/server/services/okf/hybridSearch";
import type { OkfDenseIndex } from "../src/server/services/okf/hybridSearch";
import type { OkfSearchIndex } from "../src/server/services/okf/searchIndex";
import { searchOkfIndex } from "../src/server/services/okf/searchIndex";
import { resolveRerankMethod, rerankSearchResults, type RerankMethod, type Reranker } from "../src/server/services/okf/rerank";

// ─── 纯对比逻辑（可单测） ───────────────────────────────────────────────

export interface RetrievalGoldCase {
  id: string;
  query: string;
  expectComponentIds?: string[];
  expectTitleSubstrings?: string[];
  minTrust?: number;
}

export interface CompareCaseResult {
  id: string;
  query: string;
  v1Hit: boolean;
  v2Hit: boolean;
  v1TopTitles: string[];
  v2TopTitles: string[];
}

export interface CompareSummary {
  total: number;
  v1HitAtK: number;
  v2HitAtK: number;
  /** false = fastembed 模型不可用，v2 未参与对比 */
  v2Available: boolean;
  cases: CompareCaseResult[];
}

export function hitAtK(titles: string[], expected: string[]): boolean {
  if (expected.length === 0) return titles.length > 0;
  return expected.some((needle) => titles.some((title) => title.includes(needle)));
}

export interface EvaluateMethodOptions {
  embedder?: FastembedEmbedder;
  reranker?: Reranker;
  rerankMethod?: RerankMethod;
}

export function evaluateMethod(
  index: OkfSearchIndex,
  dense: OkfDenseIndex | null,
  query: string,
  k: number,
  opts: EvaluateMethodOptions = {},
): Promise<{ titles: string[]; denseUsed: boolean }> {
  const lexical = searchOkfIndex(index, query, Math.max(k * 2, 20));
  if (!dense || dense.vectors.length === 0) {
    return Promise.resolve({
      titles: lexical.slice(0, k).map((item) => item.title),
      denseUsed: false,
    });
  }
  return searchDenseIndexV2Aware(dense, query, Math.max(k * 2, 20), opts.embedder)
    .then(async (denseRanks) => {
      const pageById = new Map(index.pages.map((page) => [page.componentId, page] as const));
      const fused = fuseSearchWithRrf(lexical, denseRanks, pageById, Math.max(k * 2, 20));
      // Phase B 精排（可选，--rerank cross_encoder）：RRF top-20 → 重排 → top-k。
      // 注意：降级（模型不可用）时 rerankSearchResults 返回原 top-20 全量，
      // 这里必须 slice(0, k)，否则命中判定会错误地按 top-20 计算。
      if (opts.rerankMethod === "cross_encoder") {
        const texts = new Map(index.pages.map((page) => [page.componentId, pageEmbeddingText(page)] as const));
        const reranked = await rerankSearchResults(query, fused, k, { texts, reranker: opts.reranker });
        return { titles: reranked.items.slice(0, k).map((item) => item.title), denseUsed: true };
      }
      return { titles: fused.slice(0, k).map((item) => item.title), denseUsed: true };
    });
}

/** 对 bundle 目录跑 v1（hashing trick）与 v2（fastembed）双管线对比。 */
export async function runCompareOnBundle(
  bundleDir: string,
  gold: { cases?: RetrievalGoldCase[] },
  k: number,
  opts: { embedder?: FastembedEmbedder; reranker?: Reranker; rerankMethod?: RerankMethod } = {},
): Promise<CompareSummary> {
  const cases = Array.isArray(gold.cases) ? gold.cases : [];
  const indexPath = join(bundleDir, "search", "index.json");
  if (!existsSync(indexPath)) {
    throw new Error(`OKF bundle has no search/index.json at ${bundleDir}`);
  }
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as OkfSearchIndex;
  const denseV1 = existsSync(join(bundleDir, "search", "dense.json"))
    ? JSON.parse(readFileSync(join(bundleDir, "search", "dense.json"), "utf8")) as OkfDenseIndex
    : null;
  const denseV2 = existsSync(join(bundleDir, "search", "dense.v2.json"))
    ? JSON.parse(readFileSync(join(bundleDir, "search", "dense.v2.json"), "utf8")) as OkfDenseIndex
    : null;

  let v2Available = Boolean(denseV2 && denseV2.vectors.length > 0);
  const rows: CompareCaseResult[] = [];
  let v1Hit = 0;
  let v2Hit = 0;

  for (const testCase of cases) {
    const expected = testCase.expectTitleSubstrings ?? [];
    const methodOpts = { embedder: opts.embedder, reranker: opts.reranker, rerankMethod: opts.rerankMethod };
    const v1 = await evaluateMethod(index, denseV1, testCase.query, k, methodOpts);
    let v2: { titles: string[] } | null = null;
    if (v2Available) {
      try {
        v2 = await evaluateMethod(index, denseV2, testCase.query, k, methodOpts);
      } catch (err) {
        if (err instanceof DenseModelUnavailableError) {
          v2Available = false;
        } else {
          throw err;
        }
      }
    }
    const v1CaseHit = hitAtK(v1.titles, expected);
    const v2CaseHit = v2 ? hitAtK(v2.titles, expected) : false;
    if (v1CaseHit) v1Hit += 1;
    if (v2CaseHit) v2Hit += 1;
    rows.push({
      id: testCase.id,
      query: testCase.query,
      v1Hit: v1CaseHit,
      v2Hit: v2CaseHit,
      v1TopTitles: v1.titles.slice(0, 3),
      v2TopTitles: (v2?.titles ?? []).slice(0, 3),
    });
  }

  const total = rows.length;
  return {
    total,
    v1HitAtK: total === 0 ? 1 : v1Hit / total,
    v2HitAtK: !v2Available || total === 0 ? 1 : v2Hit / total,
    v2Available,
    cases: rows,
  };
}

/** 对比门禁：v2 可用时命中率不得低于 v1；v2 不可用不算回归。 */
export function compareGate(summary: CompareSummary): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!summary.v2Available) {
    reasons.push("dense v2 不可用（fastembed 模型未就绪），本次对比跳过 v2（exit 0，需另行告警）");
    return { ok: true, reasons };
  }
  if (summary.total > 0 && summary.v2HitAtK + 1e-9 < summary.v1HitAtK) {
    reasons.push(
      `dense v2 命中率 ${(summary.v2HitAtK * 100).toFixed(1)}% < v1 ${(summary.v1HitAtK * 100).toFixed(1)}%：检索质量回退，禁止放行`,
    );
    return { ok: false, reasons };
  }
  reasons.push(
    `v2 命中率 ${(summary.v2HitAtK * 100).toFixed(1)}% ≥ v1 ${(summary.v1HitAtK * 100).toFixed(1)}%（${summary.total} 例）`,
  );
  return { ok: true, reasons };
}

// ─── 主入口（仅 CLI 直跑时执行；import 复用纯函数不触发 DB） ─────────────

function argValue(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]!;
  return fallback;
}

async function main(): Promise<void> {
  const compareMode = process.argv.includes("--compare-v1-v2");
  const goldPath = resolve(process.cwd(), argValue("--gold", "evals/retrieval-gold.json"));
  const projectId = argValue("--project", "default_project");
  const k = Number(argValue("--k", "5"));

  if (compareMode) {
    const gold = existsSync(goldPath)
      ? JSON.parse(readFileSync(goldPath, "utf8")) as { cases?: RetrievalGoldCase[] }
      : { cases: [] };
    let bundleDir = argValue("--bundle", "");
    if (!bundleDir) {
      const { config } = await import("../src/server/config");
      const { createDatabase } = await import("../src/server/db");
      const { createReleaseService } = await import("../src/server/services/releaseService");
      const { OkfBundleReader } = await import("../src/server/services/kbQuery/OkfBundleReader");
      const db = await createDatabase({ databaseUrl: config.databaseUrl });
      const release = await createReleaseService(db, resolve(process.cwd(), config.dataDir)).getCurrent(projectId);
      if (!release) {
        console.error(`[eval-retrieval] 项目 ${projectId} 无当前发布，无法对比`);
        await db.close();
        process.exit(2);
      }
      bundleDir = new OkfBundleReader(resolve(process.cwd(), config.dataDir)).okfBundleDir(release);
      await db.close();
    }
    const summary = await runCompareOnBundle(bundleDir, gold, k, {
      rerankMethod: argValue("--rerank", resolveRerankMethod()) === "cross_encoder" ? "cross_encoder" : "off",
    });
    const gate = compareGate(summary);
    console.log(JSON.stringify({ bundleDir, k, ...summary, gate }, null, 2));
    if (!gate.ok) process.exit(1);
    process.exit(0);
  }

  // 默认模式：DB 全链路回归门禁（沿用原实现）
  const { config } = await import("../src/server/config");
  const { createDatabase } = await import("../src/server/db");
  const { createGovernanceProfileService } = await import("../src/server/services/governanceProfileService");
  const { createRetrievalEvalService } = await import("../src/server/services/retrievalEvalService");
  const minHit = Number(argValue("--min-hit", String(config.retrievalEvalMinHitAtK)));
  const minCitation = Number(argValue("--min-citation", String(config.retrievalEvalMinCitationCoverage)));

  const db = await createDatabase({ databaseUrl: config.databaseUrl });
  const governance = createGovernanceProfileService(db, {
    evalEnabled: true,
    evalGoldPath: goldPath,
    evalMinHitAtK: minHit,
    evalMinCitationCoverage: minCitation,
  });
  const summary = await createRetrievalEvalService(db, resolve(process.cwd(), config.dataDir), undefined, governance).run({
    projectId,
    goldPath,
    k,
    emitEvent: true,
  });

  console.log(JSON.stringify(summary, null, 2));
  await db.close();

  const hitOk = summary.total === 0 || summary.hitAtK + 1e-9 >= minHit;
  const citationOk = summary.total === 0 || minCitation <= 0 || summary.citationCoverage + 1e-9 >= minCitation;
  process.exit(hitOk && citationOk ? 0 : 1);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  void main();
}
