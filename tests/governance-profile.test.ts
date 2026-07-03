import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { buildApp, type BuildAppOptions } from "../src/server/app";
import { createDatabase } from "../src/server/db";
import { createGovernanceProfileService } from "../src/server/services/governanceProfileService";
import { createTestDb } from "./helpers/testDb";
import { TEST_DATABASE_URL } from "./helpers/testEnv";

describe("governance profile service", () => {
  it("resolves env defaults, applies project overrides, and resets", async () => {
    const fixture = await createTestDb();
    try {
      const service = createGovernanceProfileService(fixture.db, {
        autoPublishRevisions: false,
        lintAutoEligibleThreshold: 0.85,
        highFrequencyThreshold: 2,
      });

      // 未落库 → 环境默认。
      const base = await service.resolve("default_project");
      expect(base.source).toBe("default");
      expect(base.release.autoPublishRevisions).toBe(false);
      expect(base.lint.autoEligibleThreshold).toBeCloseTo(0.85);
      expect(base.feedback.highFrequencyThreshold).toBe(2);

      // 项目级覆盖：只改动传入的字段，其余沿用默认。
      const updated = await service.update({
        projectId: "default_project",
        patch: {
          release: { autoPublishRevisions: true },
          feedback: { highFrequencyThreshold: 5 },
        },
        updatedBy: "admin",
      });
      expect(updated.source).toBe("project");
      expect(updated.release.autoPublishRevisions).toBe(true);
      expect(updated.feedback.highFrequencyThreshold).toBe(5);
      // 未触及的字段保持默认。
      expect(updated.release.blockOnDeletes).toBe(true);
      expect(updated.lint.autoEligibleThreshold).toBeCloseTo(0.85);
      expect(updated.updatedBy).toBe("admin");

      // resolve 再读一次应持久化（不是内存态）。
      const reread = await service.resolve("default_project");
      expect(reread.source).toBe("project");
      expect(reread.feedback.highFrequencyThreshold).toBe(5);

      // 越界数值被夹紧；未知字段被忽略。
      const clamped = await service.update({
        projectId: "default_project",
        patch: {
          trust: { minAutoPublishScore: 5 },
          feedback: { highFrequencyThreshold: 999 },
          // @ts-expect-error 未知分组应被规范化丢弃
          bogus: { nope: true },
        },
        updatedBy: "admin",
      });
      expect(clamped.trust.minAutoPublishScore).toBe(1);
      expect(clamped.feedback.highFrequencyThreshold).toBe(100);

      // reset → 回退环境默认。
      const reset = await service.reset("default_project");
      expect(reset.source).toBe("default");
      expect(reset.release.autoPublishRevisions).toBe(false);
      expect(reset.feedback.highFrequencyThreshold).toBe(2);
    } finally {
      await fixture.cleanup();
    }
  }, 20000);
});

describe("governance profile api", () => {
  let schema: string;
  let dir: string;
  let opts: BuildAppOptions;

  beforeAll(async () => {
    schema = `test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const db = await createDatabase({ databaseUrl: TEST_DATABASE_URL, schema });
    dir = mkdtempSync(join(tmpdir(), "kh-governance-"));
    opts = { db, jwtSecret: "test-secret", dataDir: dir };
  });

  afterAll(async () => {
    await opts.db.close();
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  async function login(username: string, password: string) {
    const app = await buildApp(opts);
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
    return { app, token: res.json<{ token: string }>().token };
  }

  it("lets any authenticated user read the resolved profile", async () => {
    const { app, token } = await login("viewer", "viewpw");
    const res = await app.inject({
      method: "GET",
      url: "/api/flywheel/governance-profile",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().profile.source).toBe("default");
  });

  it("lets admin update the profile and persists it", async () => {
    const { app, token } = await login("admin", "adminpw");
    const res = await app.inject({
      method: "PUT",
      url: "/api/flywheel/governance-profile",
      headers: { authorization: `Bearer ${token}` },
      payload: { feedback: { highFrequencyThreshold: 4 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().profile.source).toBe("project");
    expect(res.json().profile.feedback.highFrequencyThreshold).toBe(4);

    const reread = await app.inject({
      method: "GET",
      url: "/api/flywheel/governance-profile",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(reread.json().profile.feedback.highFrequencyThreshold).toBe(4);
  });

  it("denies profile update for non-admin roles", async () => {
    const viewer = await login("viewer", "viewpw");
    const viewerRes = await viewer.app.inject({
      method: "PUT",
      url: "/api/flywheel/governance-profile",
      headers: { authorization: `Bearer ${viewer.token}` },
      payload: { feedback: { highFrequencyThreshold: 9 } },
    });
    expect(viewerRes.statusCode).toBe(403);

    const dev = await login("dev", "devpw");
    const devRes = await dev.app.inject({
      method: "PUT",
      url: "/api/flywheel/governance-profile",
      headers: { authorization: `Bearer ${dev.token}` },
      payload: { feedback: { highFrequencyThreshold: 9 } },
    });
    expect(devRes.statusCode).toBe(403);
  });
});
