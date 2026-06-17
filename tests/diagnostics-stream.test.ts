import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import { createDatabase } from "../src/server/db";
import { createDiagnosticLogger } from "../src/server/services/diagnosticService";
import { formatSseFrame } from "../src/server/services/sse";
import type { DatabaseHandle } from "../src/server/types";
import { TEST_DATABASE_URL } from "./helpers/testEnv";

let dir: string;
let db: DatabaseHandle;
let schema: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "kh-diag-"));
  schema = `test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  db = await createDatabase({ databaseUrl: TEST_DATABASE_URL, schema, seedUsers: false });
});

afterEach(async () => {
  try { await db.close(); } catch { /* pool may already be closed */ }
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  try {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await pool.end();
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("DiagnosticLogger event bus", () => {
  it("emits each written record to subscribers and unsubscribes", async () => {
    const logger = createDiagnosticLogger(db, dir, { logToDb: false, logToFile: false });
    const seen: string[] = [];
    const unsub = logger.subscribe((record) => seen.push(record.message));
    await logger.write({ category: "kb_build", message: "first", runId: "run_1", status: "event" });
    unsub();
    await logger.write({ category: "kb_build", message: "second", runId: "run_1", status: "event" });
    expect(seen).toEqual(["first"]);
  });
});

describe("formatSseFrame", () => {
  it("formats a data frame terminated by a blank line", () => {
    const frame = formatSseFrame({ a: 1, msg: "x" });
    expect(frame).toBe(`data: {"a":1,"msg":"x"}\n\n`);
  });
  it("supports an event name", () => {
    expect(formatSseFrame({ ok: true }, "done")).toBe(`event: done\ndata: {"ok":true}\n\n`);
  });
});

import { mkdirSync as mkd, writeFileSync as wf } from "node:fs";
import { runExtractStage } from "../src/server/services/kbBuilder/extractStage";
import { loadWikiSpecs } from "../src/server/services/kbBuilder/specs";

describe("runExtractStage onProgress", () => {
  it("invokes onProgress once per parsed document", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "kh-extract-"));
    const specDir = path.join(ws, "processed", "wiki_specs");
    mkd(specDir, { recursive: true });
    wf(path.join(specDir, "manifest.json"), JSON.stringify({ page_types: { concept: { dir: "concepts", template: "concept.md" } }, entity_types: [], relation_types: [] }));
    wf(path.join(specDir, "concept.md"), "## Overview\n");
    const parsed = path.join(ws, "processed", "parsed");
    mkd(parsed, { recursive: true });
    wf(path.join(parsed, "a.md"), "# A\nbody");
    wf(path.join(parsed, "b.md"), "# B\nbody");

    const specs = loadWikiSpecs(specDir);
    const messages: string[] = [];
    await runExtractStage({
      dataDir: ws, specs, model: "deterministic", force: true, only: null,
      onProgress: (info) => messages.push(info.message),
    });
    expect(messages.length).toBe(2);
    rmSync(ws, { recursive: true, force: true });
  });
});
