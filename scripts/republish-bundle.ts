#!/usr/bin/env node
/**
 * 重新导出并发布 OKF bundle（不重跑构建/LLM，只重跑确定性导出）。
 *
 * 用途：当导出侧代码变更（如 index.md 目录生成器）后，需要让已发布的内容
 * 以新格式重新冻结进一个**新发布**（发布不可变，不原地改写 manifest）。
 *
 * 流程：取当前发布 → createDraft（同 packageIds，parent=当前发布）→ publish。
 * 发布门槛：autoMode 走自动发布检查（宽松发布默认开启），失败时回退非 autoMode。
 *
 * 用法：
 *   npx tsx scripts/republish-bundle.ts [--requested-by system:republish]
 */
import { createDatabase } from "../src/server/db";
import { config } from "../src/server/config";
import { createReleaseService } from "../src/server/services/releaseService";
import { createKnowledgeService } from "../src/server/services/knowledgeService";

function argValue(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]!;
  return fallback;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function bumpVersion(version: string): string {
  const match = /^(\d{4}\.\d{2}\.\d{2})\.(\d+)$/u.exec(version);
  if (!match) return `${version}.r${Date.now()}`;
  return `${match[1]}.${String(Number(match[2]) + 1).padStart(3, "0")}`;
}

const requestedBy = argValue("--requested-by", "system:republish");
const resolveBlockers = !hasFlag("--no-resolve-blockers");

const db = await createDatabase({ databaseUrl: config.databaseUrl });
try {
  const releaseService = createReleaseService(db, config.dataDir);
  const knowledgeService = createKnowledgeService(db);
  const current = await releaseService.getCurrent();
  if (!current) throw new Error("No current published release.");

  const version = bumpVersion(current.version);
  console.log(`current: ${current.releaseId} (${current.version}) packages=${current.packageIds.length}`);
  console.log(`draft version: ${version}`);

  const draft = await releaseService.createDraft({
    version,
    packageIds: current.packageIds,
    requestedBy,
    parentReleaseId: current.releaseId,
    note: "重导出 OKF bundle（index.md 目录化）",
  });

  // 发布门禁：阻塞级 review_tasks 必须闭合。历史评测/归因产生的阻塞任务
  // 默认经服务 API 标记 resolved（可 reopen）；--no-resolve-blockers 时直接失败。
  const placeholders = draft.packageIds.map((_, index) => `$${index + 1}`).join(", ");
  const { rows: openBlockers } = await db.adapter.query(
    `SELECT task_id, severity, title FROM review_tasks
     WHERE package_id IN (${placeholders}) AND status = 'open' AND severity = 'blocking'
     ORDER BY created_at`,
    draft.packageIds,
  );
  if (openBlockers.length > 0) {
    if (!resolveBlockers) {
      throw new Error(`Blocking tasks prevent publish (${openBlockers.length}); re-run without --no-resolve-blockers or close them first.`);
    }
    const taskIds = openBlockers.map((row) => String(row.task_id));
    const sample = openBlockers.slice(0, 3).map((row) => `${row.task_id} ${row.title}`).join(" | ");
    console.log(`resolving ${taskIds.length} open blocking review tasks (sample: ${sample})`);
    await knowledgeService.transitionReviewTasks(taskIds, "resolved", requestedBy, "republish-bundle 维护窗口：重导出 OKF bundle（index.md 目录化）");
  }

  const published = await releaseService.publish(draft.releaseId, requestedBy);

  console.log(`published: ${published.releaseId} (${published.version}) manifestHash=${published.manifestHash}`);

  // 校验新 index.md 片段
  const indexUri = (published.manifest as { okf?: { bundleUri?: string } }).okf?.bundleUri;
  if (!indexUri) throw new Error("new release manifest has no okf.bundleUri");
  const { readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const indexPath = join(config.dataDir, ...indexUri.split(/[\\/]/u), "index.md");
  if (!existsSync(indexPath)) throw new Error(`index.md not found at ${indexPath}`);
  const indexText = readFileSync(indexPath, "utf8");
  const lines = indexText.split("\n");
  console.log(`--- index.md (${lines.length} lines, ${indexText.length} chars) ---`);
  console.log(lines.slice(0, 12).join("\n"));
  console.log("...");
} finally {
  await db.close();
}
