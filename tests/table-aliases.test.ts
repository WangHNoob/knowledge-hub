import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";

import { buildApp } from "../src/server/app";
import { createDatabase } from "../src/server/db";
import { createTableAliasService } from "../src/server/services/tableAliasService";
import { scanGamedataTableNames, writeAliasFile } from "../src/server/services/kbBuilder/aliasPrep";
import type { DatabaseHandle } from "../src/server/types";
import { TEST_DATABASE_URL } from "./helpers/testEnv";

describe("table alias service + routes", () => {
  let db: DatabaseHandle;
  let schema: string;
  let dir: string;
  let app: FastifyInstance;
  let auth: { authorization: string };

  beforeAll(async () => {
    schema = `test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    db = await createDatabase({ databaseUrl: TEST_DATABASE_URL, schema });
    dir = mkdtempSync(join(tmpdir(), "kh-alias-"));
    app = await buildApp({ db, jwtSecret: "test-secret", dataDir: dir });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "adminpw" } });
    auth = { authorization: `Bearer ${login.json<{ token: string }>().token}` };
  });

  afterAll(async () => {
    await db.close();
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("ensures rows, persists edits, and reports missing", async () => {
    const service = createTableAliasService(db);
    expect(await service.ensureTables(["Hero", "Scene/Scene"])).toEqual(["Hero", "Scene/Scene"]);
    expect(await service.ensureTables(["Hero"])).toEqual([]); // idempotent
    expect(await service.listMissing()).toEqual(["Hero", "Scene/Scene"]);

    const list = await app.inject({ method: "GET", url: "/api/table-aliases", headers: auth });
    expect(list.json().entries).toHaveLength(2);

    const saved = await app.inject({
      method: "PUT",
      url: "/api/table-aliases",
      headers: auth,
      payload: { entries: [{ canonical: "Hero", aliases: ["英雄", "英雄表"] }] }
    });
    expect(saved.statusCode).toBe(200);
    const hero = saved.json().entries.find((e: { canonical: string }) => e.canonical === "Hero");
    expect(hero.aliases).toEqual(["英雄", "英雄表"]);
    expect(hero.source).toBe("manual");
    expect(hero.updatedBy).toBe("admin");
    expect(await service.listMissing()).toEqual(["Scene/Scene"]);
  });

  it("rejects viewers from editing", async () => {
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "viewer", password: "viewpw" } });
    const viewerToken = login.json<{ token: string }>().token;
    const denied = await app.inject({
      method: "PUT",
      url: "/api/table-aliases",
      headers: { authorization: `Bearer ${viewerToken}` },
      payload: { entries: [{ canonical: "Hero", aliases: ["x"] }] }
    });
    expect(denied.statusCode).toBe(403);
  });

  it("scans gamedata table names and writes the injected alias file", () => {
    const work = mkdtempSync(join(tmpdir(), "kh-alias-work-"));
    try {
      mkdirSync(join(work, "gamedata", "autoChess"), { recursive: true });
      writeFileSync(join(work, "gamedata", "Hero.xlsx"), "x");
      writeFileSync(join(work, "gamedata", "autoChess", "AutoChessHero.csv"), "x");
      writeFileSync(join(work, "gamedata", "readme.txt"), "ignored");
      expect(scanGamedataTableNames(work)).toEqual(["Hero", "autoChess/AutoChessHero"]);

      writeAliasFile(work, [{ table: "Hero", aliases: ["英雄"] }]);
      const parsed = JSON.parse(readFileSync(join(work, "table_aliases.json"), "utf8"));
      expect(parsed).toEqual([{ table: "Hero", aliases: ["英雄"] }]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
