import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";

import { buildApp } from "../src/server/app";
import { createDatabase } from "../src/server/db";
import type { DatabaseHandle } from "../src/server/types";
import { TEST_DATABASE_URL } from "./helpers/testEnv";

describe("search & package filter", () => {
  let db: DatabaseHandle;
  let schema: string;
  let dir: string;
  let app: FastifyInstance;
  let auth: { authorization: string };

  beforeAll(async () => {
    schema = `test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    db = await createDatabase({ databaseUrl: TEST_DATABASE_URL, schema });
    dir = mkdtempSync(join(tmpdir(), "kh-search-"));
    app = await buildApp({ db, jwtSecret: "test-secret", dataDir: dir });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "adminpw" } });
    auth = { authorization: `Bearer ${login.json<{ token: string }>().token}` };

    await db.adapter.query(
      `INSERT INTO asset_packages
        (package_id, name, kind, status, description, created_by_run_id, source_version_ids, legacy_paths, quality_summary, created_at)
       VALUES
        ('pkg_alpha','Alpha Combat System','kb_builder_pipeline','published','combat rules','run_a','[]','[]','{}',NOW()),
        ('pkg_beta','Beta Economy','kb_builder_pipeline','draft','economy notes','run_b','[]','[]','{}',NOW())`
    );
    await db.adapter.query(
      `INSERT INTO asset_components
        (component_id, package_id, artifact_id, group_name, kind, title, status, legacy_path, storage_uri, source_refs, quality)
       VALUES ('cmp_x','pkg_alpha','wiki/Combat','wiki','wiki_page','Combat Overview','draft','','data/wiki/combat.md','[]','{}')`
    );
  });

  afterAll(async () => {
    await db.close();
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("filters packages by keyword and status", async () => {
    const byQ = await app.inject({ method: "GET", url: "/api/packages?q=economy", headers: auth });
    expect(byQ.statusCode).toBe(200);
    expect(byQ.json().packages.map((p: { packageId: string }) => p.packageId)).toEqual(["pkg_beta"]);

    const byStatus = await app.inject({ method: "GET", url: "/api/packages?status=published", headers: auth });
    expect(byStatus.json().packages.map((p: { packageId: string }) => p.packageId)).toEqual(["pkg_alpha"]);
  });

  it("returns cross-entity search hits with navigation ids", async () => {
    const res = await app.inject({ method: "GET", url: "/api/search?q=combat", headers: auth });
    expect(res.statusCode).toBe(200);
    const hits = res.json().result.hits as Array<{ kind: string; id: string; packageId?: string }>;
    expect(hits.find((h) => h.kind === "package")?.id).toBe("pkg_alpha");
    const component = hits.find((h) => h.kind === "component");
    expect(component?.id).toBe("cmp_x");
    expect(component?.packageId).toBe("pkg_alpha");
  });
});
