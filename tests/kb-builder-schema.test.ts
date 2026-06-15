import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/server/db";

describe("kb builder schema", () => {
  it("creates build run and quality profile tables with a default active profile", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-schema-"));
    const db = await createDatabase({ dataDir, seedUsers: false });
    try {
      const runTables = await db.adapter.query(
        "SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_name IN ('knowledge_build_runs', 'quality_gate_profiles')"
      );
      expect(runTables.rows[0].count).toBe(2);

      const profiles = await db.adapter.query("SELECT profile_id, active, config_json FROM quality_gate_profiles");
      expect(profiles.rows).toHaveLength(1);
      expect(profiles.rows[0].profile_id).toBe("default");
      expect(profiles.rows[0].active).toBe(true);
      expect(profiles.rows[0].config_json.rules.wikiSpecCompleteness.enabled).toBe(true);
    } finally {
      await db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 15000);
});
