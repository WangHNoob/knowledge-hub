import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/server/app";
import { createDatabase } from "../src/server/db";
import type { DatabaseHandle } from "../src/server/types";
import { TEST_DATABASE_URL } from "./helpers/testEnv";

describe("source bundle web upload", () => {
  let app: FastifyInstance;
  let db: DatabaseHandle;
  let schema: string;
  let dir: string;
  let token: string;

  beforeAll(async () => {
    schema = `upload_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    db = await createDatabase({ databaseUrl: TEST_DATABASE_URL, schema });
    dir = mkdtempSync(join(tmpdir(), "kh-upload-"));
    app = await buildApp({ db, jwtSecret: "test-secret", dataDir: dir });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "adminpw" }
    });
    token = login.json<{ token: string }>().token;
  });

  afterAll(async () => {
    await app.close();
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("preserves uploaded directory paths and accepts a selected knowledge root folder", async () => {
    const boundary = `----kh-${randomUUID()}`;
    const body = Buffer.from([
      `--${boundary}`,
      `Content-Disposition: form-data; name="files"; filename="knowledge/gamedocs/test.md"`,
      "Content-Type: text/markdown",
      "",
      "# Test Doc",
      `--${boundary}--`,
      ""
    ].join("\r\n"));

    const uploaded = await app.inject({
      method: "POST",
      url: "/api/source-bundles/default/uploads",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(body.byteLength)
      },
      payload: body
    });

    expect(uploaded.statusCode).toBe(200);
    const versionId = uploaded.json<{ version: { versionId: string; fileCount: number } }>().version.versionId;
    expect(uploaded.json<{ version: { fileCount: number } }>().version.fileCount).toBe(1);

    const detail = await app.inject({
      method: "GET",
      url: `/api/source-bundles/default/versions/${versionId}`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<{ files: Array<{ logicalPath: string }> }>().files[0]?.logicalPath).toBe("gamedocs/test.md");
  });
});
