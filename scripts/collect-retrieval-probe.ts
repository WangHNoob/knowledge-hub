#!/usr/bin/env node
/**
 * 生产检索失败样本回流（flywheel 02-P4，K8）：
 * 扫描 mcp_audit 中 kb_search 的 miss / 低质量命中（quality_flags），
 * 生成候选集 evals/retrieval-probe-candidates.json（只读，不写业务表）。
 * 人工确认后并入 evals/retrieval-gold.json 做回归评测（与方案 03 回流调度器同源）。
 *
 * Usage:
 *   npx tsx scripts/collect-retrieval-probe.ts [--days 7] [--project default_project]
 *     [--out evals/retrieval-probe-candidates.json] [--limit 200]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { config } from "../src/server/config";
import { createDatabase } from "../src/server/db";
import { jsonArray } from "../src/server/db/mappers";

function argValue(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]!;
  return fallback;
}

const days = Number(argValue("--days", "7"));
const projectId = argValue("--project", "default_project");
const limit = Number(argValue("--limit", "200"));
const outPath = resolve(process.cwd(), argValue("--out", "evals/retrieval-probe-candidates.json"));

const db = await createDatabase({ databaseUrl: config.databaseUrl });
try {
  const { rows } = await db.adapter.query(
    `SELECT audit_id, query_payload, hit_component_ids, quality_flags, status, release_id, created_at
     FROM mcp_audit
     WHERE project_id = $1
       AND tool_name = 'kb_search'
       AND created_at > NOW() - ($2 || ' days')::interval
     ORDER BY created_at DESC
     LIMIT $3`,
    [projectId, days, limit],
  );
  const candidates = rows
    .map((row) => {
      const payload = jsonArray(row.query_payload);
      const query = typeof payload?.query === "string" ? payload.query : "";
      const flags = jsonArray(row.quality_flags).map(String);
      const hits = jsonArray(row.hit_component_ids).map(String);
      const miss = String(row.status ?? "") === "miss" || flags.length === 0;
      const lowQuality = flags.some((flag) => flag.startsWith("low_quality:") || flag.startsWith("low_trust:"));
      if (!query || (!miss && !lowQuality)) return null;
      return {
        auditId: String(row.audit_id ?? ""),
        query,
        status: miss ? "miss" : "low_quality",
        qualityFlags: flags,
        topComponentIds: hits.slice(0, 5),
        releaseId: String(row.release_id ?? ""),
        createdAt: String(row.created_at ?? ""),
        // 溯源：人工确认时凭 auditId 回查完整请求
        traceId: "",
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    projectId,
    windowDays: days,
    note: "候选集：人工确认后并入 evals/retrieval-gold.json（auditId 溯源，禁止静默自动入库）",
    total: candidates.length,
    candidates,
  }, null, 2), "utf8");
  console.log(`[collect-retrieval-probe] ${candidates.length} 条候选 → ${outPath}`);
  console.log(
    candidates.slice(0, 10).map((c) => `  ${c.status}\t${c.query.slice(0, 60)}`).join("\n"),
  );
} finally {
  await db.close();
}
