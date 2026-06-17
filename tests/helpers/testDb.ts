import { randomUUID } from "node:crypto";
import pg from "pg";

import { createDatabase } from "../../src/server/db";
import type { DatabaseHandle } from "../../src/server/types";
import { TEST_DATABASE_URL } from "./testEnv";

export interface TestDbHandle {
  db: DatabaseHandle;
  schema: string;
  cleanup: () => Promise<void>;
}

export async function createTestDb(options: { seedUsers?: boolean } = {}): Promise<TestDbHandle> {
  const schema = `test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const db = await createDatabase({
    databaseUrl: TEST_DATABASE_URL,
    schema,
    seedUsers: options.seedUsers ?? false,
  });
  return {
    db,
    schema,
    cleanup: async () => {
      await db.close();
      const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
      try {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await pool.end();
      }
    },
  };
}
