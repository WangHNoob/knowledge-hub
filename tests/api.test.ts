import { mkdtempSync, rmSync } from "node:fs";
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

    const review = await app.inject({
      method: "GET",
      url: "/api/review/tasks?severity=blocking",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(review.statusCode).toBe(200);
    expect(review.json().tasks).toHaveLength(2);

    await app.close();
  });
});
