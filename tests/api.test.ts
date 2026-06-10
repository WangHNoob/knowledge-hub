import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/server/app";
import { createDatabase } from "../src/server/db";

describe("knowledge hub api", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "knowledge-hub-api-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("requires login for knowledge endpoints and returns an empty dashboard after authentication", async () => {
    const db = createDatabase({ dataDir: dir });
    const app = await buildApp({ db, jwtSecret: "test-secret" });

    const denied = await app.inject({ method: "GET", url: "/api/dashboard" });
    expect(denied.statusCode).toBe(401);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "adminpw" }
    });
    expect(login.statusCode).toBe(200);
    const token = login.json<{ token: string }>().token;

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

    await app.close();
  });

  it("imports a legacy directory into a draft package through the api", async () => {
    const db = createDatabase({ dataDir: dir });
    const legacy = join(dir, "legacy-api");
    mkdirSync(join(legacy, "gamedocs"), { recursive: true });
    mkdirSync(join(legacy, "wiki", "systems"), { recursive: true });
    mkdirSync(join(legacy, "wiki", "_meta"), { recursive: true });
    writeFileSync(join(legacy, "gamedocs", "equipment.docx"), "equipment source");
    writeFileSync(join(legacy, "wiki", "systems", "equipment.md"), "# Equipment");
    writeFileSync(join(legacy, "wiki", "_meta", "topic_index.json"), "{}");

    const app = await buildApp({ db, jwtSecret: "test-secret" });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "adminpw" }
    });
    const token = login.json<{ token: string }>().token;

    const imported = await app.inject({
      method: "POST",
      url: "/api/legacy/import",
      headers: { authorization: `Bearer ${token}` },
      payload: { path: legacy }
    });

    expect(imported.statusCode).toBe(200);
    expect(imported.json().package.status).toBe("draft");
    expect(imported.json().createdComponents).toBe(2);

    const packages = await app.inject({
      method: "GET",
      url: "/api/packages",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(packages.json().packages.some((pkg: { packageId: string }) => pkg.packageId === imported.json().package.packageId)).toBe(true);

    await app.close();
  });

  it("imports a gamedata/gamedocs directory as a versioned source bundle", async () => {
    const db = createDatabase({ dataDir: dir });
    const root = join(dir, "raw-v1");
    mkdirSync(join(root, "gamedata"), { recursive: true });
    mkdirSync(join(root, "gamedocs"), { recursive: true });
    writeFileSync(join(root, "gamedata", "items.csv"), "id,name\n1,A\n");
    writeFileSync(join(root, "gamedocs", "design.md"), "# Design");

    const app = await buildApp({ db, jwtSecret: "test-secret" });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "adminpw" }
    });
    const token = login.json<{ token: string }>().token;

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

    await app.close();
  });
});
