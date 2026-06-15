import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/server/db";
import type { DatabaseHandle } from "../src/server/types";

describe("database initialization", () => {
  let dir: string | undefined;
  let db: DatabaseHandle | undefined;

  afterEach(async () => {
    await db?.close();
    db = undefined;
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("initializes a PGlite data directory with the default source bundle", async () => {
    dir = mkdtempSync(join(tmpdir(), "kh-pglite-"));

    db = await createDatabase({ dataDir: dir, seedUsers: false });

    const { rows } = await db.adapter.query<{ bundle_id: string }>(
      "SELECT bundle_id FROM source_bundles WHERE bundle_id = $1",
      ["default"]
    );
    expect(rows).toEqual([{ bundle_id: "default" }]);
  }, 15000);
});
