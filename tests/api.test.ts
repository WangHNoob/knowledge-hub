import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import xlsx from "xlsx";

import { buildApp, type BuildAppOptions } from "../src/server/app";
import { createDatabase } from "../src/server/db";
import type { DatabaseHandle } from "../src/server/types";
import { TEST_DATABASE_URL } from "./helpers/testEnv";

describe("knowledge hub api", () => {
  let db: DatabaseHandle;
  let schema: string;
  let dir: string;
  let opts: BuildAppOptions;

  beforeAll(async () => {
    schema = `test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    db = await createDatabase({ databaseUrl: TEST_DATABASE_URL, schema });
    dir = mkdtempSync(join(tmpdir(), "kh-api-"));
    opts = { db, jwtSecret: "test-secret", dataDir: dir };
  });

  afterAll(async () => {
    await db.close();
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  async function getToken(username = "admin", password = "adminpw") {
    const app = await buildApp(opts);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username, password }
    });
    const token = login.json<{ token: string }>().token;
    return { app, token };
  }

  it("requires login for knowledge endpoints and returns an empty dashboard after authentication", async () => {
    const { app, token } = await getToken();

    const denied = await app.inject({ method: "GET", url: "/api/dashboard" });
    expect(denied.statusCode).toBe(401);

    const dashboard = await app.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(dashboard.statusCode).toBe(200);
    const body = dashboard.json();
    expect(body.packages.total).toBe(0);
    expect(body.sources.bundles).toBe(1);
    expect(body.sources.versions).toBe(0);
    expect(body.sources.latest).toBeNull();
  });

  it("imports a legacy directory into a draft package through the api", async () => {
    const { app, token } = await getToken();
    const legacy = join(dir, "legacy-api-" + randomUUID().slice(0, 6));
    mkdirSync(join(legacy, "gamedocs"), { recursive: true });
    mkdirSync(join(legacy, "wiki", "systems"), { recursive: true });
    mkdirSync(join(legacy, "wiki", "_meta"), { recursive: true });
    writeFileSync(join(legacy, "gamedocs", "equipment.docx"), "equipment source");
    writeFileSync(join(legacy, "wiki", "systems", "equipment.md"), "# Equipment");
    writeFileSync(join(legacy, "wiki", "_meta", "topic_index.json"), "{}");

    const imported = await app.inject({
      method: "POST",
      url: "/api/legacy/import",
      headers: { authorization: `Bearer ${token}` },
      payload: { path: legacy }
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json().package.status).toBe("draft");
    expect(imported.json().createdComponents).toBe(2);
  });

  it("imports a gamedata/gamedocs directory as a versioned source bundle", async () => {
    const { app, token } = await getToken();
    const root = join(dir, "raw-v1");
    mkdirSync(join(root, "gamedata"), { recursive: true });
    mkdirSync(join(root, "gamedocs"), { recursive: true });
    writeFileSync(join(root, "gamedata", "items.csv"), "id,name\n1,A\n");
    writeFileSync(join(root, "gamedocs", "design.md"), "# Design");

    const created = await app.inject({
      method: "POST",
      url: "/api/source-bundles/default/versions",
      headers: { authorization: `Bearer ${token}` },
      payload: { rootPath: root, note: "initial" }
    });
    expect(created.statusCode).toBe(200);
    const result = created.json();
    expect(result.version.fileCount).toBe(2);
    expect(result.version.addedCount).toBe(2);
    expect(result.newBlobCount).toBe(2);

    const versions = await app.inject({
      method: "GET",
      url: "/api/source-bundles/default/versions",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(versions.json().versions).toHaveLength(1);
  });

  it("builds a knowledge asset package from a source version through the api", async () => {
    const { app, token } = await getToken();
    const root = join(dir, "build-raw");
    mkdirSync(join(root, "gamedocs"), { recursive: true });
    mkdirSync(join(root, "gamedata", "Combat"), { recursive: true });
    writeFileSync(join(root, "gamedocs", "battle.md"), [
      "---",
      "type: system",
      "title: Battle System",
      "source: gamedocs/battle.md",
      "facts:",
      "  config_table: Skill",
      "entities:",
      "  - name: Battle System",
      "    type: system",
      "---",
      "## Overview",
      "Battle rules.",
      "## Data Dependencies",
      "Uses Skill."
    ].join("\n"));
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet([{ Id: 1, Name: "Slash" }]), "Skill");
    xlsx.writeFile(workbook, join(root, "gamedata", "Combat", "Skill.xlsx"));

    const created = await app.inject({
      method: "POST",
      url: "/api/source-bundles/default/versions",
      headers: { authorization: `Bearer ${token}` },
      payload: { rootPath: root, note: "build fixture" }
    });
    expect(created.statusCode).toBe(200);
    const versionId = created.json().version.versionId;

    const built = await app.inject({
      method: "POST",
      url: `/api/source-bundles/default/versions/${versionId}/build`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        stages: ["convert", "extract", "tables", "graph", "viz"],
        modelConfig: {
          provider: "openai-compatible",
          baseUrl: "https://llm.local/v1",
          model: "gpt-test",
          apiKey: "secret-key"
        },
        force: false,
        only: null,
        qualityProfileId: "default"
      }
    });

    expect(built.statusCode, JSON.stringify(built.json())).toBe(202);
    expect(["running", "completed"]).toContain(built.json().run.status);
    expect(built.json().package).toBeUndefined();
    expect(built.json().run.model).toBe("gpt-test");
    expect(built.json().run.config.modelConfig).toMatchObject({
      provider: "openai-compatible",
      baseUrl: "https://llm.local/v1",
      model: "gpt-test",
      apiKeyConfigured: true
    });
    expect(built.json().run.config.modelConfig.apiKey).toBeUndefined();

    const run = await waitForBuildRun(app, token, built.json().run.runId);
    expect(run.status).toBe("completed");
    expect(run.packageId).toMatch(/^pkg_/u);
  }, 20000);

  it("allows admins and rejects non-admins for quality profile updates", async () => {
    const { app, token: adminToken } = await getToken();
    const dev = await getToken("dev", "devpw");
    const config = {
      minPackageScore: 0.8,
      rules: {
        wikiSpecCompleteness: { enabled: true, severity: "blocking", minScore: 0.8 }
      }
    };

    const rejected = await dev.app.inject({
      method: "PUT",
      url: "/api/quality-gate/profile",
      headers: { authorization: `Bearer ${dev.token}` },
      payload: { config }
    });
    expect(rejected.statusCode).toBe(403);

    const updated = await app.inject({
      method: "PUT",
      url: "/api/quality-gate/profile",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { config }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().profile.config.minPackageScore).toBe(0.8);

    const read = await app.inject({
      method: "GET",
      url: "/api/quality-gate/profile",
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().profile.config.minPackageScore).toBe(0.8);
  });

  it("tests OpenAI-compatible model connectivity without returning the api key", async () => {
    const { app, token } = await getToken();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ id: "chatcmpl-test" }), { status: 200 }));
    try {
      const tested = await app.inject({
        method: "POST",
        url: "/api/model-connectivity/test",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          modelConfig: {
            provider: "openai-compatible",
            baseUrl: "https://llm.local/v1",
            model: "gpt-test",
            apiKey: "secret-key"
          }
        }
      });

      expect(tested.statusCode).toBe(200);
      expect(tested.json()).toMatchObject({
        ok: true,
        provider: "openai-compatible",
        model: "gpt-test",
        message: "模型连接成功。"
      });
      expect(JSON.stringify(tested.json())).not.toContain("secret-key");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

async function waitForBuildRun(app: FastifyInstance, token: string, runId: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/build-runs/${runId}`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(response.statusCode).toBe(200);
    const run = response.json().run;
    if (run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Build run ${runId} did not finish.`);
}
