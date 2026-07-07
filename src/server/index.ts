import { existsSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";

import staticPlugin from "@fastify/static";

import { buildApp } from "./app";
import { config } from "./config";
import { createDatabase } from "./db";
import { createKbBuilderPipelineService } from "./services/kbBuilderService";

const root = process.cwd();
const dataDir = isAbsolute(config.dataDir) ? config.dataDir : resolve(root, config.dataDir);

const db = await createDatabase({ databaseUrl: config.databaseUrl });

// 回收上次进程遗留的孤儿构建（进程被重启/杀掉，DB 行仍挂 running）。重启即可靠地停掉一切。
const reclaimed = await createKbBuilderPipelineService(db, dataDir).failInterruptedRuns();
if (reclaimed > 0) console.log(`Reclaimed ${reclaimed} interrupted build run(s) from a previous process.`);

const app = await buildApp({
  db,
  jwtSecret: config.jwtSecret,
  dataDir,
  enableSourceIngestAutomation: config.autoBuildOnUpload,
  enableHealthSweep: true,
});

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
