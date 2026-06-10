import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import bcrypt from "bcryptjs";

import type { DatabaseHandle } from "./types";

export interface CreateDatabaseOptions {
  dataDir: string;
  seedUsers?: boolean;
}

export function createDatabase(options: CreateDatabaseOptions): DatabaseHandle {
  mkdirSync(options.dataDir, { recursive: true });
  const path = join(options.dataDir, "knowledge-hub.sqlite");
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  migrate(sqlite);
  if (options.seedUsers ?? true) {
    seedDefaultUsers(sqlite);
  }
  return {
    path,
    sqlite,
    close: () => sqlite.close()
  };
}

function migrate(db: DatabaseSync): void {
  // 旧 sources 表（单文件、无版本集）已被 source_bundles/_versions/_files + source_blobs 取代。
  db.exec("DROP TABLE IF EXISTS sources;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      display_name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_blobs (
      content_hash TEXT PRIMARY KEY,
      byte_size INTEGER NOT NULL,
      storage_uri TEXT NOT NULL,
      first_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_bundles (
      bundle_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_bundle_versions (
      version_id TEXT PRIMARY KEY,
      bundle_id TEXT NOT NULL REFERENCES source_bundles(bundle_id) ON DELETE CASCADE,
      parent_version_id TEXT,
      label TEXT NOT NULL,
      note TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      file_count INTEGER NOT NULL,
      added_count INTEGER NOT NULL,
      modified_count INTEGER NOT NULL,
      removed_count INTEGER NOT NULL,
      unchanged_count INTEGER NOT NULL,
      total_bytes INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_source_bundle_versions_bundle
      ON source_bundle_versions(bundle_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS source_files (
      version_id TEXT NOT NULL REFERENCES source_bundle_versions(version_id) ON DELETE CASCADE,
      logical_path TEXT NOT NULL,
      category TEXT NOT NULL,
      content_hash TEXT NOT NULL REFERENCES source_blobs(content_hash),
      byte_size INTEGER NOT NULL,
      PRIMARY KEY (version_id, logical_path)
    );

    CREATE INDEX IF NOT EXISTS idx_source_files_hash ON source_files(content_hash);

    CREATE TABLE IF NOT EXISTS asset_packages (
      package_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      description TEXT NOT NULL,
      created_by_run_id TEXT NOT NULL,
      source_version_ids TEXT NOT NULL,
      legacy_paths TEXT NOT NULL,
      quality_summary TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS asset_components (
      component_id TEXT PRIMARY KEY,
      package_id TEXT NOT NULL REFERENCES asset_packages(package_id) ON DELETE CASCADE,
      artifact_id TEXT NOT NULL,
      group_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      legacy_path TEXT NOT NULL,
      storage_uri TEXT NOT NULL,
      source_refs TEXT NOT NULL,
      quality TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evidence_records (
      evidence_id TEXT PRIMARY KEY,
      package_id TEXT NOT NULL REFERENCES asset_packages(package_id) ON DELETE CASCADE,
      component_id TEXT NOT NULL REFERENCES asset_components(component_id) ON DELETE CASCADE,
      source_version_id TEXT NOT NULL,
      quote TEXT NOT NULL,
      note TEXT NOT NULL,
      confidence REAL NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS review_tasks (
      task_id TEXT PRIMARY KEY,
      package_id TEXT NOT NULL REFERENCES asset_packages(package_id) ON DELETE CASCADE,
      component_id TEXT NOT NULL REFERENCES asset_components(component_id) ON DELETE CASCADE,
      severity TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      suggested_action TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS releases (
      release_id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      status TEXT NOT NULL,
      package_ids TEXT NOT NULL,
      published_at TEXT,
      quality_gate TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_events (
      event_id TEXT PRIMARY KEY,
      release_id TEXT NOT NULL,
      query TEXT NOT NULL,
      hit_component_ids TEXT NOT NULL,
      quality_flags TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  // 默认资料集
  db.prepare(
    `INSERT OR IGNORE INTO source_bundles (bundle_id, name, description, created_at)
     VALUES (?, ?, ?, ?)`
  ).run("default", "默认资料集", "gamedata 表格 + gamedocs 文档统一版本化", new Date(0).toISOString());
}

function seedDefaultUsers(db: DatabaseSync): void {
  const existing = db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
  if (existing.count > 0) return;
  const stmt = db.prepare(
    "INSERT INTO users (id, username, password_hash, role, display_name) VALUES (?, ?, ?, ?, ?)"
  );
  stmt.run("usr_admin", "admin", bcrypt.hashSync("adminpw", 8), "admin", "管理员");
  stmt.run("usr_dev", "dev", bcrypt.hashSync("devpw", 8), "developer", "主开发者");
  stmt.run("usr_viewer", "viewer", bcrypt.hashSync("viewpw", 8), "viewer", "访客");
}
