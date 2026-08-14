import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createRetrievalEvalService } from "../src/server/services/retrievalEvalService";
import { createTestDb } from "./helpers/testDb";
import type { TestDbHandle } from "./helpers/testDb";

const dirs: string[] = [];
const handles: TestDbHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) await handles.pop()!.cleanup();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function seedRelease(db: TestDbHandle["db"], releaseId: string, withChannel = true): Promise<void> {
  await db.adapter.query(
    `INSERT INTO releases (release_id, project_id, version, status, package_ids, created_by, created_at)
     VALUES ($1, 'default_project', 'v-bind', 'published', '[]', 'admin', NOW())`,
    [releaseId],
  );
  if (withChannel) {
    await db.adapter.query(
      `INSERT INTO release_channels (channel_id, project_id, current_release_id, updated_by, updated_at)
       VALUES ('default', 'default_project', $1, 'admin', NOW())
       ON CONFLICT (channel_id) DO UPDATE SET current_release_id = EXCLUDED.current_release_id`,
      [releaseId],
    );
  }
}

function goldFile(boundReleaseId: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kh-gold-binding-"));
  dirs.push(dir);
  const path = join(dir, "gold.json");
  writeFileSync(path, JSON.stringify({ meta: { kbReleaseId: boundReleaseId }, cases: [] }), "utf8");
  return path;
}

describe("retrieval gold binding (EV-027 guard)", () => {
  it("ok when the golden binds the current release", async () => {
    const fixture = await createTestDb();
    handles.push(fixture);
    await seedRelease(fixture.db, "rel_bound_1");
    const svc = createRetrievalEvalService(fixture.db, join(tmpdir(), "kh-binding-data-1"));
    const summary = await svc.run({ goldPath: goldFile("rel_bound_1"), emitEvent: false });
    expect(summary.binding).toEqual({
      boundReleaseId: "rel_bound_1",
      currentReleaseId: "rel_bound_1",
      ok: true,
    });
  }, 20000);

  it("mismatch when the golden binds a different release (golden 过时)", async () => {
    const fixture = await createTestDb();
    handles.push(fixture);
    await seedRelease(fixture.db, "rel_current_9");
    const svc = createRetrievalEvalService(fixture.db, join(tmpdir(), "kh-binding-data-2"));
    const summary = await svc.run({ goldPath: goldFile("rel_stale_0"), emitEvent: false });
    expect(summary.binding).toEqual({
      boundReleaseId: "rel_stale_0",
      currentReleaseId: "rel_current_9",
      ok: false,
    });
  }, 20000);

  it("mismatch when no current release exists", async () => {
    const fixture = await createTestDb();
    handles.push(fixture);
    const svc = createRetrievalEvalService(fixture.db, join(tmpdir(), "kh-binding-data-3"));
    const summary = await svc.run({ goldPath: goldFile("rel_any"), emitEvent: false });
    expect(summary.binding).toEqual({
      boundReleaseId: "rel_any",
      currentReleaseId: "",
      ok: false,
    });
  }, 20000);

  it("binding is absent when the golden has no kbReleaseId", async () => {
    const fixture = await createTestDb();
    handles.push(fixture);
    const dir = mkdtempSync(join(tmpdir(), "kh-gold-nobind-"));
    dirs.push(dir);
    const path = join(dir, "gold.json");
    writeFileSync(path, JSON.stringify({ cases: [] }), "utf8");
    const svc = createRetrievalEvalService(fixture.db, join(tmpdir(), "kh-binding-data-4"));
    const summary = await svc.run({ goldPath: path, emitEvent: false });
    expect(summary.binding).toBeUndefined();
  }, 20000);
});
