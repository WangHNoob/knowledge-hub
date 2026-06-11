import pg from "pg";
import bcrypt from "bcryptjs";

import type { DatabaseHandle } from "./types";

export interface CreateDatabaseOptions {
  databaseUrl?: string;
  schema?: string;
  seedUsers?: boolean;
}

const DEFAULT_URL = "postgres://postgres:whbwhb2026@127.0.0.1:5432/knowledge_hub";

export async function createDatabase(options: CreateDatabaseOptions = {}): Promise<DatabaseHandle> {
  const databaseUrl = options.databaseUrl || process.env.DATABASE_URL || DEFAULT_URL;
  const schema = options.schema ?? "public";

  const pool = new pg.Pool({ connectionString: databaseUrl });

  if (schema !== "public") {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await pool.query(`SET search_path TO "${schema}"`);
  }

  await migrate(pool, schema);

  if (options.seedUsers ?? true) {
    await seedDefaultUsers(pool, schema);
  }

  return {
    pool,
    schema,
    close: async () => { await pool.end(); }
  };
}

function schemaPrefix(schema: string): string {
  return schema === "public" ? "" : `"${schema}".`;
}

async function migrate(pool: pg.Pool, schema: string): Promise<void> {
  const p = schemaPrefix(schema);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${p}users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      display_name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ${p}source_blobs (
      content_hash TEXT PRIMARY KEY,
      byte_size BIGINT NOT NULL,
      storage_uri TEXT NOT NULL,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ${p}source_bundles (
      bundle_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ${p}source_bundle_versions (
      version_id TEXT PRIMARY KEY,
      bundle_id TEXT NOT NULL REFERENCES ${p}source_bundles(bundle_id) ON DELETE CASCADE,
      parent_version_id TEXT,
      label TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      file_count INTEGER NOT NULL DEFAULT 0,
      added_count INTEGER NOT NULL DEFAULT 0,
      modified_count INTEGER NOT NULL DEFAULT 0,
      removed_count INTEGER NOT NULL DEFAULT 0,
      unchanged_count INTEGER NOT NULL DEFAULT 0,
      total_bytes BIGINT NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_sbv_bundle_created
      ON ${p}source_bundle_versions(bundle_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS ${p}source_files (
      version_id TEXT NOT NULL REFERENCES ${p}source_bundle_versions(version_id) ON DELETE CASCADE,
      logical_path TEXT NOT NULL,
      category TEXT NOT NULL,
      content_hash TEXT NOT NULL REFERENCES ${p}source_blobs(content_hash),
      byte_size BIGINT NOT NULL,
      PRIMARY KEY (version_id, logical_path)
    );

    CREATE INDEX IF NOT EXISTS idx_sf_hash ON ${p}source_files(content_hash);

    CREATE TABLE IF NOT EXISTS ${p}asset_packages (
      package_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      description TEXT NOT NULL,
      created_by_run_id TEXT NOT NULL,
      source_version_ids JSONB NOT NULL DEFAULT '[]',
      legacy_paths JSONB NOT NULL DEFAULT '[]',
      quality_summary JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ${p}asset_components (
      component_id TEXT PRIMARY KEY,
      package_id TEXT NOT NULL REFERENCES ${p}asset_packages(package_id) ON DELETE CASCADE,
      artifact_id TEXT NOT NULL,
      group_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      legacy_path TEXT NOT NULL DEFAULT '',
      storage_uri TEXT NOT NULL DEFAULT '',
      source_refs JSONB NOT NULL DEFAULT '[]',
      quality JSONB NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS ${p}evidence_records (
      evidence_id TEXT PRIMARY KEY,
      package_id TEXT NOT NULL REFERENCES ${p}asset_packages(package_id) ON DELETE CASCADE,
      component_id TEXT NOT NULL REFERENCES ${p}asset_components(component_id) ON DELETE CASCADE,
      source_version_id TEXT NOT NULL DEFAULT '',
      quote TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ${p}review_tasks (
      task_id TEXT PRIMARY KEY,
      package_id TEXT NOT NULL REFERENCES ${p}asset_packages(package_id) ON DELETE CASCADE,
      component_id TEXT NOT NULL REFERENCES ${p}asset_components(component_id) ON DELETE CASCADE,
      severity TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      suggested_action TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ${p}releases (
      release_id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      status TEXT NOT NULL,
      package_ids JSONB NOT NULL DEFAULT '[]',
      published_at TIMESTAMPTZ,
      quality_gate JSONB NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS ${p}agent_events (
      event_id TEXT PRIMARY KEY,
      release_id TEXT NOT NULL,
      query TEXT NOT NULL,
      hit_component_ids JSONB NOT NULL DEFAULT '[]',
      quality_flags JSONB NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 默认资料集
  await pool.query(
    `INSERT INTO ${p}source_bundles (bundle_id, name, description, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (bundle_id) DO NOTHING`,
    ["default", "默认资料集", "gamedata 表格 + gamedocs 文档统一版本化", new Date(0).toISOString()]
  );
}

async function seedDefaultUsers(pool: pg.Pool, schema: string): Promise<void> {
  const p = schemaPrefix(schema);
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM ${p}users`);
  if (rows[0].count > 0) return;

  const stmt = `INSERT INTO ${p}users (id, username, password_hash, role, display_name) VALUES ($1, $2, $3, $4, $5)`;
  await pool.query(stmt, ["usr_admin", "admin", bcrypt.hashSync("adminpw", 8), "admin", "管理员"]);
  await pool.query(stmt, ["usr_dev", "dev", bcrypt.hashSync("devpw", 8), "developer", "主开发者"]);
  await pool.query(stmt, ["usr_viewer", "viewer", bcrypt.hashSync("viewpw", 8), "viewer", "访客"]);
}
