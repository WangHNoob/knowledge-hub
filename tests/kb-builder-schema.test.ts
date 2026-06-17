import { describe, expect, it } from "vitest";

import { createTestDb } from "./helpers/testDb";

describe("kb builder schema", () => {
  it("creates build run and quality profile tables with a default active profile", async () => {
    const { db, schema, cleanup } = await createTestDb();
    try {
      const runTables = await db.adapter.query(
        "SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_schema = $1 AND table_name IN ('knowledge_build_runs', 'quality_gate_profiles')",
        [schema]
      );
      expect(runTables.rows[0].count).toBe(2);

      const profiles = await db.adapter.query("SELECT profile_id, active, config_json FROM quality_gate_profiles");
      expect(profiles.rows).toHaveLength(1);
      expect(profiles.rows[0].profile_id).toBe("default");
      expect(profiles.rows[0].active).toBe(true);
      expect(profiles.rows[0].config_json.rules.wikiSpecCompleteness.enabled).toBe(true);
    } finally {
      await cleanup();
    }
  }, 15000);
});
