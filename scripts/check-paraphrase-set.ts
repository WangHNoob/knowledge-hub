// 临时校验：retrieval-paraphrase.json 的每个 case 必须满足
//  1) 期望标题子串存在于 bundle 页面标题（stale 检查）
//  2) query 与目标页**零词法重叠**（用真实 searchOkfIndex 打分路径验证：
//     目标页不得出现在 top-50，且列出重叠 token 供改写）
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { OkfSearchIndex } from "../src/server/services/okf/searchIndex";
import { searchOkfIndex, tokenizeSearchText } from "../src/server/services/okf/searchIndex";

const bundleDir = process.argv[2] ?? "data/releases/rel_20260809142245_mSJBqC/okf_bundle";
const goldPath = process.argv[3] ?? "evals/retrieval-paraphrase.json";
const gold = JSON.parse(readFileSync(goldPath, "utf8")) as { cases?: Array<{ id: string; query: string; expectTitleSubstrings?: string[] }> };
const index = JSON.parse(readFileSync(join(bundleDir, "search", "index.json"), "utf8")) as OkfSearchIndex;
const titles = index.pages.map((p) => p.title);

let bad = 0;
for (const c of gold.cases ?? []) {
  const expected = c.expectTitleSubstrings ?? [];
  const problems: string[] = [];
  // 1) stale 检查
  for (const needle of expected) {
    if (!titles.some((t) => t.includes(needle))) problems.push(`期望子串悬空: ${needle}`);
  }
  // 2) 词法零重叠：目标页不得被 searchOkfIndex 召回
  const hits = searchOkfIndex(index, c.query, 50);
  const qTokens = new Set(tokenizeSearchText(c.query));
  for (const needle of expected) {
    const target = index.pages.filter((p) => p.title.includes(needle));
    for (const page of target) {
      const hit = hits.some((h) => h.componentId === page.componentId);
      if (hit) {
        const pageTokens = new Set(Object.values(page.terms).flat());
        const overlap = [...qTokens].filter((t) => pageTokens.has(t));
        problems.push(`词法重叠命中 ${page.title}（重叠 token: ${overlap.join(",")}）`);
      }
    }
  }
  if (problems.length > 0) {
    bad += 1;
    console.log(`✗ ${c.id} ${c.query.slice(0, 40)}`);
    for (const p of problems) console.log(`    ${p}`);
  } else {
    console.log(`✓ ${c.id}`);
  }
}
console.log(`\n${(gold.cases ?? []).length - bad}/${gold.cases?.length} 通过零词法重叠校验`);
process.exit(bad > 0 ? 1 : 0);
