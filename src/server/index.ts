import { existsSync } from "node:fs";
import { join } from "node:path";

import staticPlugin from "@fastify/static";

import { buildApp } from "./app";
import { createDatabase } from "./db";

const root = process.cwd();
const dataDir = process.env.KH_DATA_DIR ?? join(root, "data");
const jwtSecret = process.env.KH_JWT_SECRET ?? "dev-secret-change-me";
const port = Number(process.env.PORT ?? 4174);
const host = process.env.HOST ?? "0.0.0.0";

const db = createDatabase({ dataDir, seed: true });
const app = await buildApp({ db, jwtSecret });

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

await app.listen({ host, port });
console.log(`Knowledge Hub listening on http://${host}:${port}`);
