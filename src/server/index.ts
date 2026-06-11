import { existsSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";

import staticPlugin from "@fastify/static";

import { buildApp } from "./app";
import { config } from "./config";
import { createDatabase } from "./db";

const root = process.cwd();
const dataDir = isAbsolute(config.dataDir) ? config.dataDir : resolve(root, config.dataDir);

// 桌面模式：优先使用 PGlite 嵌入式数据库
const db = await createDatabase({
  dataDir: dataDir,  // PGlite 模式
  databaseUrl: config.databaseUrl  // 回退 PostgreSQL（若未配置则忽略）
});

const app = await buildApp({ db, jwtSecret: config.jwtSecret, dataDir });

const clientDist = join(root, "dist", "client");
if (existsSync(clientDist)) {
  await app.register(staticPlugin, {
    root: clientDist,
    prefix: "/"
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile("index.html");
  });
}

await app.listen({ host: config.host, port: config.port });
console.log(`Knowledge Hub listening on http://${config.host}:${config.port}`);
