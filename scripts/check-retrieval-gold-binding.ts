#!/usr/bin/env node
/**
 * golden↔release 绑定校验（flywheel：EV-027 机制性护栏）。
 *
 * 校验「golden 期望值 ↔ 当前 release 数据」一致性：每个 case 的
 * expectTitleSubstrings 必须能在当前 bundle 的页面标题中找到（命中才算绑定
 * 有效），并在 meta.kbReleaseId 记录绑定的发布——发布门禁据此拦截「golden
 * 过时」的自动发布。
 *
 * Usage:
 *   npx tsx scripts/check-retrieval-gold-binding.ts [--gold evals/retrieval-gold.json]
 *     [--bundle <okf_bundle_dir>]  缺省时从 DB 解析当前发布 bundle
 *     [--strict]                   任一期望悬空 → exit 1
 *     [--bind <releaseId>]         把 meta.kbReleaseId 写回 golden 文件
 *     [--project default_project]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface GoldCase {
  id: string;
  query: string;
  expectTitleSubstrings?: string[];
}

function argValue(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]!;
  return fallback;
}

const strict = process.argv.includes("--strict");
const bindReleaseId = argValue("--bind", "");
const goldPath = resolve(process.cwd(), argValue("--gold", "evals/retrieval-gold.json"));
const projectId = argValue("--project", "default_project");

const gold = JSON.parse(readFileSync(goldPath, "utf8")) as {
  meta?: Record<string, unknown>;
  cases?: GoldCase[];
};

let bundleDir = argValue("--bundle", "");
if (!bundleDir) {
  const { config } = await import("../src/server/config");
  const { createDatabase } = await import("../src/server/db");
  const { createReleaseService } = await import("../src/server/services/releaseService");
  const { OkfBundleReader } = await import("../src/server/services/kbQuery/OkfBundleReader");
  const db = await createDatabase({ databaseUrl: config.databaseUrl });
  try {
    const release = await createReleaseService(db, resolve(process.cwd(), config.dataDir)).getCurrent(projectId);
    if (!release) {
      console.error(`[gold-binding] 项目 ${projectId} 无当前发布，无法校验`);
      process.exit(2);
    }
    bundleDir = new OkfBundleReader(resolve(process.cwd(), config.dataDir)).okfBundleDir(release);
  } finally {
    await db.close();
  }
}

const indexPath = join(bundleDir, "search", "index.json");
if (!existsSync(indexPath)) {
  console.error(`[gold-binding] bundle 缺少 ${indexPath}`);
  process.exit(2);
}
const index = JSON.parse(readFileSync(indexPath, "utf8")) as { pages?: Array<{ title?: string }> };
const titles = (index.pages ?? []).map((page) => String(page.title ?? ""));

const cases = Array.isArray(gold.cases) ? gold.cases : [];
const stale: string[] = [];
let expectedTotal = 0;
for (const testCase of cases) {
  const expected = testCase.expectTitleSubstrings ?? [];
  for (const needle of expected) {
    expectedTotal += 1;
    const hit = titles.some((title) => title.includes(needle));
    if (!hit) stale.push(`${testCase.id}: ${needle}`);
  }
}

const bound = gold.meta?.kbReleaseId ?? "";
console.log(`[gold-binding] cases=${cases.length} expectations=${expectedTotal} stale=${stale.length} bound=${bound}`);
for (const item of stale.slice(0, 20)) console.log(`  stale: ${item}`);

if (bindReleaseId) {
  gold.meta = { ...(gold.meta ?? {}), kbReleaseId: bindReleaseId };
  writeFileSync(goldPath, `${JSON.stringify(gold, null, 2)}\n`, "utf8");
  console.log(`[gold-binding] meta.kbReleaseId → ${bindReleaseId}（已写回 ${goldPath}）`);
}

if (strict && stale.length > 0) {
  console.error("[gold-binding] 存在悬空期望（golden 过时），--strict 模式下 exit 1");
  process.exit(1);
}
process.exit(0);
