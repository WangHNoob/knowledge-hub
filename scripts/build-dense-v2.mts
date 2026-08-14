import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildOkfDenseIndexV2, DENSE_INDEX_URI_V2 } from "../src/server/services/okf/denseIndexV2";
import type { OkfSearchIndex } from "../src/server/services/okf/searchIndex";

// 为指定 OKF bundle 生成真实 embedding 的 dense.v2.json（模型已缓存时离线可用）。
const bundleDir = process.argv[2] ?? "data/releases/rel_20260809142245_mSJBqC/okf_bundle";
const index = JSON.parse(readFileSync(join(bundleDir, "search", "index.json"), "utf8")) as OkfSearchIndex;
const start = Date.now();
const dense = await buildOkfDenseIndexV2(index);
mkdirSync(join(bundleDir, "search"), { recursive: true });
writeFileSync(join(bundleDir, DENSE_INDEX_URI_V2), JSON.stringify(dense), "utf8");
console.log(
  `[build-dense-v2] ${dense.vectors.length} vectors dim=${dense.dim} → ${join(bundleDir, DENSE_INDEX_URI_V2)} (${Date.now() - start}ms)`,
);
