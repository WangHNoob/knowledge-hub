// 一次性脚本：清空飞轮产生的所有数据（DB + 磁盘工作区），保留账号 / 原始资料 /
// 翻译表 / 策划立法规则 / 质量门禁 Profile。DB 删除包在单个事务里，任一步失败即回滚。
//
// 用法：
//   node scripts/reset-flywheel.mjs            # 清 DB + 磁盘工作区
//   node scripts/reset-flywheel.mjs --db-only  # 只清 DB，不动磁盘
//   node scripts/reset-flywheel.mjs --keep-logs # 保留 diagnostic_logs 与 data/logs
import "dotenv/config";
import { existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("缺少 DATABASE_URL");
  process.exit(1);
}

const argv = new Set(process.argv.slice(2));
const DB_ONLY = argv.has("--db-only");
const KEEP_LOGS = argv.has("--keep-logs");
const DATA_DIR = process.env.KH_DATA_DIR || "./data";

// 删除顺序：先清有外键依赖的子表 / 引用表，asset_packages 走级联。
const TARGETS = [
  "release_channels",      // 外键指向 releases，必须先清
  "releases",
  "knowledge_build_runs",
  "asset_packages",        // 级联：asset_components / evidence_records / review_tasks / annotation_examples / rule_dismissals
  "knowledge_events",
  "agent_events",
  "mcp_audit",
  "attribution_audits",
  ...(KEEP_LOGS ? [] : ["diagnostic_logs"]),
];

// 这些表会被 asset_packages 级联删除，单独统计以便核对。
const CASCADED = [
  "asset_components",
  "evidence_records",
  "review_tasks",
  "annotation_examples",
  "rule_dismissals",
];

const KEEP = [
  "users",
  "source_blobs", "source_bundles", "source_bundle_versions", "source_files",
  "table_aliases",
  "knowledge_rule_profiles",
  "quality_gate_profiles",
];

// 磁盘上要清空内容（但保留目录本身）的飞轮工作区。
// 注意：data/storage（原始资料 blob）与 data/logs（除非清日志）必须保留。
const DISK_TARGETS = [
  "kb-build-runs",   // 构建运行工作区
  "releases",        // 已发布 OKF bundle 导出
  ".kh-cache",       // extract/tables 内容哈希缓存
  ...(KEEP_LOGS ? [] : ["logs"]),
];
const DISK_KEEP = ["storage"]; // 原始资料 blob，永不删

function clearDirContents(dir) {
  if (!existsSync(dir)) return { existed: false, removed: 0 };
  let removed = 0;
  for (const entry of readdirSync(dir)) {
    rmSync(join(dir, entry), { recursive: true, force: true });
    removed += 1;
  }
  return { existed: true, removed };
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

async function counts(tables) {
  const out = {};
  for (const t of tables) {
    const { rows } = await client.query(`SELECT COUNT(*)::int AS c FROM ${t}`);
    out[t] = rows[0].c;
  }
  return out;
}

try {
  console.log("=== 删除前行数 (清除目标 + 级联子表) ===");
  console.table(await counts([...TARGETS, ...CASCADED]));

  await client.query("BEGIN");
  const deleted = {};
  for (const t of TARGETS) {
    const res = await client.query(`DELETE FROM ${t}`);
    deleted[t] = res.rowCount;
  }
  await client.query("COMMIT");

  console.log("=== 本次 DELETE 影响行数 ===");
  console.table(deleted);

  console.log("=== 删除后行数 (应全为 0) ===");
  console.table(await counts([...TARGETS, ...CASCADED]));

  console.log("=== 保留表行数 (应不变) ===");
  console.table(await counts(KEEP));
  console.log("OK: 飞轮数据已清空，保留表完好。");

  if (DB_ONLY) {
    console.log("\n--db-only：跳过磁盘清理。");
  } else {
    console.log(`\n=== 清理磁盘工作区 (KH_DATA_DIR=${DATA_DIR}) ===`);
    const diskReport = {};
    for (const name of DISK_TARGETS) {
      const { existed, removed } = clearDirContents(join(DATA_DIR, name));
      diskReport[name] = existed ? `清空 ${removed} 项` : "不存在 (跳过)";
    }
    console.table(diskReport);
    const keepReport = {};
    for (const name of DISK_KEEP) {
      const dir = join(DATA_DIR, name);
      keepReport[name] = existsSync(dir) ? `保留 (${readdirSync(dir).length} 项)` : "不存在";
    }
    console.table(keepReport);
    console.log("OK: 磁盘工作区已清空，原始资料 blob 完整保留。");
  }
} catch (err) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("FAILED, 已回滚:", err);
  process.exitCode = 1;
} finally {
  await client.end();
}
