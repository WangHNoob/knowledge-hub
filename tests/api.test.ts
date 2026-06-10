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

  it("requires login for knowledge endpoints and returns a dashboard after authentication", async () => {
    const db = createDatabase({ dataDir: dir, seed: true });
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
    expect(dashboard.json().packages.total).toBe(2);

    await app.close();
  });

  it("lets authenticated users inspect package detail and review tasks", async () => {
    const db = createDatabase({ dataDir: dir, seed: true });
    const app = await buildApp({ db, jwtSecret: "test-secret" });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "dev", password: "devpw" }
    });
    const token = login.json<{ token: string }>().token;

    const detail = await app.inject({
      method: "GET",
      url: "/api/packages/pkg_legacy_core",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().components.length).toBeGreaterThan(3);
    expect(detail.json().evidenceRecords).toHaveLength(4);
    expect(detail.json().evidenceCoverage.coverageRate).toBeCloseTo(0.5);

    const review = await app.inject({
      method: "GET",
      url: "/api/review/tasks?severity=blocking",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(review.statusCode).toBe(200);
    expect(review.json().tasks).toHaveLength(2);

    const evidence = await app.inject({
      method: "GET",
      url: "/api/evidence?packageId=pkg_legacy_core",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(evidence.statusCode).toBe(200);
    expect(evidence.json().records).toHaveLength(4);
    expect(evidence.json().coverage.missingComponents).toBe(3);

    await app.close();
  });

  it("imports a legacy directory into a draft package through the api", async () => {
    const db = createDatabase({ dataDir: dir, seed: true });
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
});
