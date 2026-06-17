import { afterEach, describe, expect, it } from "vitest";

import { createTestDb, type TestDbHandle } from "./helpers/testDb";

describe("database initialization", () => {
  let handle: TestDbHandle | undefined;

  afterEach(async () => {
    await handle?.cleanup();
    handle = undefined;
  });

  it("initializes a Postgres schema with the default source bundle", async () => {
    handle = await createTestDb();

    const { rows } = await handle.db.adapter.query<{ bundle_id: string }>(
      "SELECT bundle_id FROM source_bundles WHERE bundle_id = $1",
      ["default"]
    );
    expect(rows).toEqual([{ bundle_id: "default" }]);
  }, 15000);
});
