// 一键恢复种子数据：起 PostgreSQL 容器 → 等就绪 → 把全库 dump 恢复进 knowledge_hub。
//
// 原始资料 blob（data/storage/blobs）、OKF 发布物（data/releases）和构建产物
// （data/kb-build-runs/<run>/data/{wiki,table_schemas,processed}）已随 SVN checkout 到位，
// 这里只需把 PostgreSQL 业务数据灌回去。用法：npm run db:restore
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const DUMP = join(repoRoot, "seed", "db", "knowledge_hub.dump");
const SERVICE = "postgres";
const CONTAINER_DUMP = "/tmp/knowledge_hub.dump";

function compose(args, opts = {}) {
  return execFileSync("docker", ["compose", ...args], { cwd: repoRoot, stdio: "inherit", ...opts });
}

function composeQuiet(args) {
  try {
    execFileSync("docker", ["compose", ...args], { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!existsSync(DUMP)) {
  console.error(`找不到种子 dump：${DUMP}\n请确认已完整 svn checkout（seed/db/knowledge_hub.dump 应随仓库一起拉取）。`);
  process.exit(1);
}

console.log("→ 启动 PostgreSQL 容器（docker compose up -d）...");
compose(["up", "-d"]);

console.log("→ 等待数据库就绪...");
let ready = false;
for (let i = 0; i < 60; i += 1) {
  if (composeQuiet(["exec", "-T", SERVICE, "pg_isready", "-U", "postgres", "-d", "knowledge_hub"])) {
    ready = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!ready) {
  console.error("数据库在 60 秒内未就绪，请检查 docker compose logs postgres。");
  process.exit(1);
}

console.log("→ 拷贝 dump 进容器并恢复到 knowledge_hub...");
compose(["cp", DUMP, `${SERVICE}:${CONTAINER_DUMP}`]);
compose([
  "exec", "-T", SERVICE,
  "pg_restore", "--clean", "--if-exists", "--no-owner", "--no-privileges",
  "-U", "postgres", "-d", "knowledge_hub", CONTAINER_DUMP
]);
composeQuiet(["exec", "-T", SERVICE, "rm", "-f", CONTAINER_DUMP]);

console.log("✓ 种子数据已恢复。现在可以 `npm run build && npm start`，或 `npm test` 跑功能测试。");
