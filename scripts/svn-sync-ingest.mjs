#!/usr/bin/env node
import "dotenv/config";

const argv = process.argv.slice(2);
function argValue(flag, fallback = "") {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("-")) return argv[i + 1];
  return fallback;
}

const projectId = argValue("--project", process.env.KH_OPS_PROJECT_ID || "default_project");
const skipSvnUpdate = argv.includes("--skip-svn-update");
const base = (
  process.env.KH_OPS_BASE_URL ||
  process.env.KH_PUBLIC_BASE_URL ||
  `http://127.0.0.1:${process.env.PORT || "4174"}`
).replace(/\/$/, "");

async function obtainToken() {
  if (process.env.KH_OPS_TOKEN?.trim()) return process.env.KH_OPS_TOKEN.trim();
  const username = process.env.KH_OPS_USER?.trim();
  const password = process.env.KH_OPS_PASSWORD ?? "";
  if (!username) throw new Error("请设置 KH_OPS_TOKEN，或 KH_OPS_USER + KH_OPS_PASSWORD");
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `登录失败 HTTP ${res.status}`);
  if (!body.token) throw new Error("登录响应缺少 token");
  return body.token;
}

async function main() {
  console.log(`[svn-sync] target=${base} project=${projectId} skipSvnUpdate=${skipSvnUpdate}`);
  const token = await obtainToken();
  const res = await fetch(`${base}/api/ops/svn-sync`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ projectId, skipSvnUpdate }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(body, null, 2));
  process.exit(body?.result?.ok === true ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
