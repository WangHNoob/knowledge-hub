import { afterEach, describe, expect, it } from "vitest";

import { createTestDb, type TestDbHandle } from "./helpers/testDb";

describe("PostgresAdapter transaction isolation", () => {
  let handle: TestDbHandle | undefined;

  afterEach(async () => {
    await handle?.cleanup();
    handle = undefined;
  }, 30000);

  it("keeps concurrent transaction() chains on separate connections", async () => {
    handle = await createTestDb();
    const adapter = handle.db.adapter;

    await adapter.query(`
      CREATE TABLE IF NOT EXISTS tx_parents (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL
      )
    `);
    await adapter.query(`
      CREATE TABLE IF NOT EXISTS tx_children (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL REFERENCES tx_parents(id)
      )
    `);

    const worker = async (id: string) => {
      await adapter.transaction(async () => {
        await adapter.query("INSERT INTO tx_parents (id, label) VALUES ($1, $2)", [id, `parent-${id}`]);
        await new Promise((resolve) => setTimeout(resolve, 20));
        await adapter.query("INSERT INTO tx_children (id, parent_id) VALUES ($1, $2)", [`child-${id}`, id]);
      });
    };

    await Promise.all([worker("a"), worker("b"), worker("c")]);

    const parents = await adapter.query<{ id: string }>("SELECT id FROM tx_parents ORDER BY id");
    const children = await adapter.query<{ id: string; parent_id: string }>(
      "SELECT id, parent_id FROM tx_children ORDER BY id",
    );
    expect(parents.rows.map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(children.rows).toEqual([
      { id: "child-a", parent_id: "a" },
      { id: "child-b", parent_id: "b" },
      { id: "child-c", parent_id: "c" },
    ]);
  }, 30000);

  it("rejects nested transaction() on the same async context", async () => {
    handle = await createTestDb();
    const adapter = handle.db.adapter;
    await expect(
      adapter.transaction(async () => adapter.transaction(async () => 1)),
    ).rejects.toThrow(/Nested transaction/);
  }, 15000);

  it("rejects BEGIN via query()", async () => {
    handle = await createTestDb();
    await expect(handle.db.adapter.query("BEGIN")).rejects.toThrow(/transaction\(async/);
  }, 15000);
});
