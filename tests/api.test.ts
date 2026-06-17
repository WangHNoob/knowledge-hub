import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("serves legislation profile read, create, and activate endpoints", async () => {
    const { app, token } = await getToken();

    const current = await app.inject({
      method: "GET",
      url: "/api/legislation/profile",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(current.statusCode).toBe(200);
    expect(current.json().profile.profileId).toBeTruthy();
    expect(current.json().profile.config.pageTypes.system).toBeTruthy();

    const created = await app.inject({
      method: "POST",
      url: "/api/legislation/profile",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "API profile",
        activate: false,
        config: {
          ...current.json().profile.config,
          entityTypes: [...current.json().profile.config.entityTypes, { id: "buff", label: "Buff", publishable: true }]
        }
      }
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().profile.active).toBe(false);

    const activated = await app.inject({
      method: "POST",
      url: "/api/legislation/profile/activate",
      headers: { authorization: `Bearer ${token}` },
      payload: { profileId: created.json().profile.profileId }
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json().profile.profileId).toBe(created.json().profile.profileId);
    expect(activated.json().profile.active).toBe(true);
  });

  it("seeds a planner-friendly default knowledge rule profile with document wiki templates", async () => {
    const { app, token } = await getToken();

    const current = await app.inject({
      method: "GET",
      url: "/api/legislation/profile",
      headers: { authorization: `Bearer ${token}` }
    });

    expect(current.statusCode).toBe(200);
    const config = current.json().profile.config;
    expect(config.documentTypes.system_rule.wikiSpecTemplate.requiredSections).toContain("核心规则");
    expect(config.documentTypes.activity_gameplay.wikiSpecTemplate.requiredFacts).toContain("reward");
    expect(config.documentTypes.table_schema.defaultPageTypeId).toBe("table");
    expect(config.pageTypes.field.requiredFacts).toContain("field_meaning");
    expect(config.entityTypes.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining(["system", "activity", "config_table", "field", "item", "numeric_item"]));
    expect(config.relationTypes.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining(["depends_on", "affects", "contains", "references", "produces", "consumes", "prerequisite_of", "mutually_exclusive_with"]));
    expect(config.qualityRules.source_trace_missing.severity).toBe("blocking");
  });

  it("creates and lists agent output attribution audits through the api", async () => {
    const { app, token } = await getToken();

    const created = await app.inject({
      method: "POST",
      url: "/api/agent/output-audits",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        releaseId: "rel_api_demo",
        title: "API output audit",
        segments: [
          { text: "Battle uses Skill.", trace: { componentIds: ["cmp_1"], evidenceIds: ["ev_1"] } },
          { text: "Add a new burst mode.", trace: { componentIds: [], evidenceIds: [] } }
        ]
      }
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().audit.segments.map((segment: { attributionType: string }) => segment.attributionType)).toEqual(["引用", "创作"]);

    const list = await app.inject({
      method: "GET",
      url: "/api/agent/output-audits",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().audits.some((audit: { auditId: string }) => audit.auditId === created.json().audit.auditId)).toBe(true);
  });

  it("writes diagnostic logs for api requests and returns a trace id", async () => {
    const { app, token } = await getToken();

    const response = await app.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { authorization: `Bearer ${token}` }
    });

    expect(response.statusCode).toBe(200);
    const traceId = response.headers["x-trace-id"];
    expect(traceId).toEqual(expect.stringMatching(/^trc_/u));

    const { rows } = await db.adapter.query(
      "SELECT * FROM diagnostic_logs WHERE trace_id = $1 AND category = 'http' ORDER BY created_at ASC",
      [traceId]
    );
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "started", route: "/api/dashboard", method: "GET" }),
      expect.objectContaining({ status: "completed", route: "/api/dashboard", method: "GET" })
    ]));
    expect(Number(rows.at(-1)?.duration_ms ?? 0)).toBeGreaterThanOrEqual(0);

    const logPath = join(dir, "logs", `${new Date().toISOString().slice(0, 10)}.jsonl`);
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, "utf8")).toContain(String(traceId));
  });

  it("redacts sensitive payload fields from diagnostic logs", async () => {
    const app = await buildApp(opts);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "adminpw", apiKey: "secret-key", token: "raw-token" }
    });

    expect(response.statusCode).toBe(200);
    const traceId = response.headers["x-trace-id"];
    const { rows } = await db.adapter.query(
      "SELECT request_payload_json FROM diagnostic_logs WHERE trace_id = $1 AND status = 'started'",
      [traceId]
    );
    const payload = JSON.stringify(rows[0]?.request_payload_json ?? "");
    expect(payload).not.toContain("adminpw");
    expect(payload).not.toContain("secret-key");
    expect(payload).not.toContain("raw-token");
    expect(payload).toContain("[REDACTED]");
  });

  it("serves diagnostic summaries, filtered logs, and trace timelines only to authenticated users", async () => {
    const { app, token } = await getToken();
    const dashboard = await app.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { authorization: `Bearer ${token}` }
    });
    const traceId = String(dashboard.headers["x-trace-id"]);

    const denied = await app.inject({ method: "GET", url: "/api/diagnostics/logs" });
    expect(denied.statusCode).toBe(401);

    const logs = await app.inject({
      method: "GET",
      url: `/api/diagnostics/logs?category=http&traceId=${encodeURIComponent(traceId)}&limit=5`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(logs.statusCode).toBe(200);
    expect(logs.json().logs.every((log: { traceId: string; category: string }) => log.traceId === traceId && log.category === "http")).toBe(true);

    const timeline = await app.inject({
      method: "GET",
      url: `/api/diagnostics/logs/${encodeURIComponent(traceId)}`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(timeline.statusCode).toBe(200);
    expect(timeline.json().logs.length).toBeGreaterThanOrEqual(2);
    expect(timeline.json().logs[0].traceId).toBe(traceId);

    const summary = await app.inject({
      method: "GET",
      url: "/api/diagnostics/summary",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().summary).toEqual(expect.objectContaining({
      errors24h: expect.any(Number),
      slowRequests24h: expect.any(Number),
      failedBuilds24h: expect.any(Number),
      mcpErrors24h: expect.any(Number),
      llmErrors24h: expect.any(Number)
    }));
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
    const { rows: buildLogs } = await db.adapter.query(
      "SELECT category, message, status, run_id FROM diagnostic_logs WHERE run_id = $1 ORDER BY created_at ASC",
      [run.runId]
    );
    expect(buildLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "kb_build", message: "knowledge build run", status: "started" }),
      expect.objectContaining({ category: "kb_build", message: "kb build stage materialize", status: "started" }),
      expect.objectContaining({ category: "llm", message: "kb build stage extract", status: "started" }),
      expect.objectContaining({ category: "kb_build", message: "kb build stage persist completed", status: "completed" })
    ]));
  }, 20000);

  it("browses local directories without returning file contents", async () => {
    const { app, token } = await getToken();
    const root = join(dir, "browser-root");
    mkdirSync(join(root, "gamedata", "Combat"), { recursive: true });
    mkdirSync(join(root, "gamedocs"), { recursive: true });
    writeFileSync(join(root, "gamedata", "Combat", "Skill.csv"), "Id,Name\n1,Slash\n");
    writeFileSync(join(root, "gamedocs", "battle.md"), "# Battle\n");

    const browsed = await app.inject({
      method: "GET",
      url: `/api/local-files/browse?path=${encodeURIComponent(root)}`,
      headers: { authorization: `Bearer ${token}` }
    });

    expect(browsed.statusCode).toBe(200);
    const body = browsed.json();
    expect(body.path).toBe(root);
    expect(body.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "gamedata", kind: "directory" }),
      expect.objectContaining({ name: "gamedocs", kind: "directory" })
    ]));
    expect(JSON.stringify(body)).not.toContain("Slash");
  });

  it("stops and deletes build runs through the api", async () => {
    const { app, token } = await getToken();
    for (const versionId of ["srcv_stop", "srcv_delete"]) {
      await db.adapter.query(
        `INSERT INTO source_bundle_versions
          (version_id, bundle_id, parent_version_id, label, note, created_by, created_at, file_count, added_count, modified_count, removed_count, unchanged_count, total_bytes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [versionId, "default", null, versionId, "", "admin", new Date().toISOString(), 0, 0, 0, 0, 0, 0]
      );
    }
    await db.adapter.query(
      `INSERT INTO knowledge_build_runs
        (run_id, source_version_id, package_id, adapter, stages, model, wiki_specs_hash, quality_profile_id, status, started_at, finished_at, error, output_uri, config_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        "run_api_stop",
        "srcv_stop",
        null,
        "native",
        JSON.stringify(["convert"]),
        "deterministic",
        "",
        "default",
        "running",
        new Date().toISOString(),
        null,
        "",
        "",
        JSON.stringify({})
      ]
    );
    await db.adapter.query(
      `INSERT INTO knowledge_build_runs
        (run_id, source_version_id, package_id, adapter, stages, model, wiki_specs_hash, quality_profile_id, status, started_at, finished_at, error, output_uri, config_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        "run_api_delete",
        "srcv_delete",
        null,
        "native",
        JSON.stringify(["convert"]),
        "deterministic",
        "",
        "default",
        "failed",
        new Date().toISOString(),
        new Date().toISOString(),
        "fixture",
        "",
        JSON.stringify({})
      ]
    );

    const stopped = await app.inject({
      method: "POST",
      url: "/api/build-runs/run_api_stop/stop",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().run.status).toBe("failed");
    expect(stopped.json().run.error).toContain("Stopped");

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/build-runs/run_api_delete",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true });

    const missing = await app.inject({
      method: "GET",
      url: "/api/build-runs/run_api_delete",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(missing.statusCode).toBe(404);
  });

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

  it("creates, publishes, reads current, and rolls back immutable releases through the api", async () => {
    const { app, token } = await getToken();
    const first = await insertPackageFixture(db, "api_first");
    const second = await insertPackageFixture(db, "api_second");

    const draftOne = await app.inject({
      method: "POST",
      url: "/api/releases",
      headers: { authorization: `Bearer ${token}` },
      payload: { version: "api.1", packageIds: [first.packageId] }
    });
    expect(draftOne.statusCode, JSON.stringify(draftOne.json())).toBe(200);
    expect(draftOne.json().release.status).toBe("draft");

    const publishedOne = await app.inject({
      method: "POST",
      url: `/api/releases/${draftOne.json().release.releaseId}/publish`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(publishedOne.statusCode, JSON.stringify(publishedOne.json())).toBe(200);
    expect(publishedOne.json().release.manifestHash).toMatch(/^sha256:/u);
    expect(publishedOne.json().release.manifest.componentIds).toContain(first.componentId);

    const draftTwo = await app.inject({
      method: "POST",
      url: "/api/releases",
      headers: { authorization: `Bearer ${token}` },
      payload: { version: "api.2", packageIds: [second.packageId] }
    });
    const publishedTwo = await app.inject({
      method: "POST",
      url: `/api/releases/${draftTwo.json().release.releaseId}/publish`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(publishedTwo.statusCode).toBe(200);

    const current = await app.inject({
      method: "GET",
      url: "/api/releases/current",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(current.statusCode).toBe(200);
    expect(current.json().release.releaseId).toBe(publishedTwo.json().release.releaseId);

    const rollback = await app.inject({
      method: "POST",
      url: "/api/releases/rollback",
      headers: { authorization: `Bearer ${token}` },
      payload: { releaseId: publishedOne.json().release.releaseId }
    });
    expect(rollback.statusCode).toBe(200);
    expect(rollback.json().release.releaseId).toBe(publishedOne.json().release.releaseId);
  });

  it("writes diagnostic logs for mcp queries alongside audit records", async () => {
    const { app, token } = await getToken();
    const fixture = await insertPackageFixture(db, "mcp_diag");
    const draft = await app.inject({
      method: "POST",
      url: "/api/releases",
      headers: { authorization: `Bearer ${token}` },
      payload: { version: "mcp.diag", packageIds: [fixture.packageId] }
    });
    const published = await app.inject({
      method: "POST",
      url: `/api/releases/${draft.json().release.releaseId}/publish`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(published.statusCode).toBe(200);

    const queried = await app.inject({
      method: "POST",
      url: "/api/mcp/query",
      headers: { authorization: `Bearer ${token}` },
      payload: { toolName: "kb_get_release", payload: {} }
    });

    expect(queried.statusCode).toBe(200);
    const traceId = String(queried.headers["x-trace-id"]);
    const { rows: audits } = await db.adapter.query("SELECT * FROM mcp_audit WHERE tool_name = $1", ["kb_get_release"]);
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const { rows: logs } = await db.adapter.query(
      "SELECT * FROM diagnostic_logs WHERE trace_id = $1 AND category = 'mcp'",
      [traceId]
    );
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "Knowledge MCP kb_get_release", status: "started" }),
      expect.objectContaining({ message: "Knowledge MCP kb_get_release completed", status: "completed" })
    ]));
  });

  it("rejects publishing when selected packages have open blocking tasks", async () => {
    const { app, token } = await getToken();
    const fixture = await insertPackageFixture(db, "api_blocked");
    await db.adapter.query(
      `INSERT INTO review_tasks
        (task_id, package_id, component_id, severity, status, title, description, suggested_action, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        `task_${fixture.packageId}`,
        fixture.packageId,
        fixture.componentId,
        "blocking",
        "open",
        "Blocking issue",
        "must resolve",
        "resolve before publish",
        new Date().toISOString()
      ]
    );

    const draft = await app.inject({
      method: "POST",
      url: "/api/releases",
      headers: { authorization: `Bearer ${token}` },
      payload: { version: "api.blocked", packageIds: [fixture.packageId] }
    });
    expect(draft.statusCode).toBe(200);

    const rejected = await app.inject({
      method: "POST",
      url: `/api/releases/${draft.json().release.releaseId}/publish`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toMatch(/blocking/i);
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

  it("tests Anthropic model connectivity without returning the api key", async () => {
    const { app, token } = await getToken();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "msg-test", content: [{ type: "text", text: "ok" }] }), { status: 200 });
    });
    try {
      const tested = await app.inject({
        method: "POST",
        url: "/api/model-connectivity/test",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          modelConfig: {
            provider: "anthropic",
            baseUrl: "https://api.anthropic.com/v1",
            model: "claude-sonnet-4-5",
            apiKey: "sk-ant-secret"
          }
        }
      });

      expect(tested.statusCode).toBe(200);
      expect(tested.json()).toMatchObject({
        ok: true,
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        message: "模型连接成功。"
      });
      expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
      expect(calls[0].init?.headers).toMatchObject({
        "content-type": "application/json",
        "x-api-key": "sk-ant-secret",
        "anthropic-version": "2023-06-01"
      });
      expect(JSON.stringify(tested.json())).not.toContain("sk-ant-secret");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("accepts a full Anthropic messages endpoint as the base url", async () => {
    const { app, token } = await getToken();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "msg-test", content: [{ type: "text", text: "ok" }] }), { status: 200 });
    });
    try {
      const tested = await app.inject({
        method: "POST",
        url: "/api/model-connectivity/test",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          modelConfig: {
            provider: "anthropic",
            baseUrl: "https://proxy.local/anthropic/v1/messages",
            model: "claude-sonnet-4-5",
            apiKey: "sk-ant-secret"
          }
        }
      });

      expect(tested.statusCode).toBe(200);
      expect(calls[0].url).toBe("https://proxy.local/anthropic/v1/messages");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("normalizes the Anthropic service root to the v1 messages endpoint", async () => {
    const { app, token } = await getToken();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "msg-test", content: [{ type: "text", text: "ok" }] }), { status: 200 });
    });
    try {
      const tested = await app.inject({
        method: "POST",
        url: "/api/model-connectivity/test",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          modelConfig: {
            provider: "anthropic",
            baseUrl: "https://api.anthropic.com",
            model: "claude-sonnet-4-5",
            apiKey: "sk-ant-secret"
          }
        }
      });

      expect(tested.statusCode).toBe(200);
      expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("deletes an unpublished asset package and cascades its components", async () => {
    const { app, token } = await getToken();
    const fixture = await insertPackageFixture(db, "delete");

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/packages/${fixture.packageId}`,
      headers: { authorization: `Bearer ${token}` }
    });

    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true });

    const remainingPackages = await db.adapter.query("SELECT package_id FROM asset_packages WHERE package_id = $1", [fixture.packageId]);
    const remainingComponents = await db.adapter.query("SELECT component_id FROM asset_components WHERE component_id = $1", [fixture.componentId]);
    expect(remainingPackages.rows).toEqual([]);
    expect(remainingComponents.rows).toEqual([]);
  });

  it("rejects deleting an asset package referenced by a release", async () => {
    const { app, token } = await getToken();
    const fixture = await insertPackageFixture(db, "released_delete");
    await db.adapter.query(
      `INSERT INTO releases
        (release_id, version, status, package_ids, manifest_hash, manifest_json, created_by, created_at, published_by, published_at, quality_gate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        `rel_${randomUUID().slice(0, 6)}`,
        `v-${randomUUID().slice(0, 6)}`,
        "published",
        JSON.stringify([fixture.packageId]),
        "hash",
        JSON.stringify({}),
        "admin",
        new Date().toISOString(),
        "admin",
        new Date().toISOString(),
        JSON.stringify({})
      ]
    );

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/packages/${fixture.packageId}`,
      headers: { authorization: `Bearer ${token}` }
    });

    expect(deleted.statusCode).toBe(409);
    expect(deleted.json().error).toContain("already referenced by release");
    const remaining = await db.adapter.query("SELECT package_id FROM asset_packages WHERE package_id = $1", [fixture.packageId]);
    expect(remaining.rows).toHaveLength(1);
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

async function insertPackageFixture(db: DatabaseHandle, suffix: string) {
  const packageId = `pkg_${suffix}_${randomUUID().slice(0, 6)}`;
  const componentId = `cmp_${suffix}_${randomUUID().slice(0, 6)}`;
  await db.adapter.query(
    `INSERT INTO asset_packages
      (package_id, name, kind, status, description, created_by_run_id, source_version_ids, legacy_paths, quality_summary, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      packageId,
      `Package ${suffix}`,
      "kb_builder_pipeline",
      "draft",
      "api fixture",
      "run_api_fixture",
      JSON.stringify([`srcv_${suffix}`]),
      JSON.stringify([]),
      JSON.stringify({ overallScore: 0.91, blockingCount: 0, warningCount: 0 }),
      new Date().toISOString()
    ]
  );
  await db.adapter.query(
    `INSERT INTO asset_components
      (component_id, package_id, artifact_id, group_name, kind, title, status, legacy_path, storage_uri, source_refs, quality)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      componentId,
      packageId,
      `wiki/${suffix}.md`,
      "wiki",
      "wiki_page",
      `Page ${suffix}`,
      "draft",
      `wiki/${suffix}.md`,
      `kb-build-runs/run_api_fixture/data/wiki/${suffix}.md`,
      JSON.stringify([`gamedocs/${suffix}.md`]),
      JSON.stringify({ confidence: 0.91 })
    ]
  );
  return { packageId, componentId };
}
