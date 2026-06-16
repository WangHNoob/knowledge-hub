import pg from "pg";
import bcrypt from "bcryptjs";

import type { DatabaseHandle } from "./types";
import { PostgresAdapter, type DatabaseAdapter } from "./db-adapter";

export interface CreateDatabaseOptions {
  /** PostgreSQL 连接串；缺省时从 DATABASE_URL 读取 */
  databaseUrl?: string;
  /** 模式名（默认 public） */
  schema?: string;
  /** 是否 seed 演示用户 */
  seedUsers?: boolean;
}

export async function createDatabase(options: CreateDatabaseOptions = {}): Promise<DatabaseHandle> {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("缺少 DATABASE_URL（请在 .env 或部署环境中配置 PostgreSQL 连接串）。");
  }
  const schema = options.schema ?? "public";
  const pool = new pg.Pool({ connectionString: databaseUrl });

  if (schema !== "public") {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await pool.query(`SET search_path TO "${schema}"`);
  }

  const adapter: DatabaseAdapter = new PostgresAdapter(pool, schema);
  await migrate(adapter, schema);
  if (options.seedUsers ?? true) {
    await seedDefaultUsers(adapter, schema);
  }

  return {
    adapter,
    schema,
    close: async () => { await adapter.close(); }
  };
}

function schemaPrefix(schema: string): string {
  return schema === "public" ? "" : `"${schema}".`;
}

async function migrate(adapter: DatabaseAdapter, schema: string): Promise<void> {
  const p = schemaPrefix(schema);

  await adapter.exec(`
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

    CREATE TABLE IF NOT EXISTS ${p}quality_gate_profiles (
      profile_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT false,
      config_json JSONB NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ${p}knowledge_rule_profiles (
      profile_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT false,
      hash TEXT NOT NULL DEFAULT '',
      config_json JSONB NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ${p}knowledge_build_runs (
      run_id TEXT PRIMARY KEY,
      source_version_id TEXT NOT NULL REFERENCES ${p}source_bundle_versions(version_id) ON DELETE CASCADE,
      package_id TEXT,
      adapter TEXT NOT NULL,
      stages JSONB NOT NULL DEFAULT '[]',
      model TEXT NOT NULL DEFAULT '',
      wiki_specs_hash TEXT NOT NULL DEFAULT '',
      quality_profile_id TEXT NOT NULL REFERENCES ${p}quality_gate_profiles(profile_id),
      status TEXT NOT NULL,
      current_stage TEXT NOT NULL DEFAULT '',
      completed_stages JSONB NOT NULL DEFAULT '[]',
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      error TEXT NOT NULL DEFAULT '',
      output_uri TEXT NOT NULL DEFAULT '',
      config_json JSONB NOT NULL DEFAULT '{}'
    );

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
      manifest_hash TEXT NOT NULL DEFAULT '',
      manifest_json JSONB NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      published_by TEXT NOT NULL DEFAULT '',
      published_at TIMESTAMPTZ,
      quality_gate JSONB NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS ${p}release_channels (
      channel_id TEXT PRIMARY KEY,
      current_release_id TEXT REFERENCES ${p}releases(release_id),
      updated_by TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ${p}agent_events (
      event_id TEXT PRIMARY KEY,
      release_id TEXT NOT NULL,
      query TEXT NOT NULL,
      hit_component_ids JSONB NOT NULL DEFAULT '[]',
      quality_flags JSONB NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      feedback_type TEXT NOT NULL DEFAULT 'hit',
      suggested_action TEXT NOT NULL DEFAULT '',
      task_id TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ${p}mcp_audit (
      audit_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL DEFAULT '',
      agent_role TEXT NOT NULL DEFAULT '',
      tool_name TEXT NOT NULL,
      release_id TEXT,
      query_payload JSONB NOT NULL DEFAULT '{}',
      hit_component_ids JSONB NOT NULL DEFAULT '[]',
      quality_flags JSONB NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ${p}attribution_audits (
      audit_id TEXT PRIMARY KEY,
      release_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      segments_json JSONB NOT NULL DEFAULT '[]',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ${p}diagnostic_logs (
      log_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      span_id TEXT NOT NULL,
      parent_span_id TEXT NOT NULL DEFAULT '',
      level TEXT NOT NULL,
      category TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL,
      duration_ms INTEGER,
      actor TEXT NOT NULL DEFAULT '',
      route TEXT NOT NULL DEFAULT '',
      method TEXT NOT NULL DEFAULT '',
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT NOT NULL DEFAULT '',
      run_id TEXT NOT NULL DEFAULT '',
      release_id TEXT NOT NULL DEFAULT '',
      request_payload_json JSONB NOT NULL DEFAULT '{}',
      context_json JSONB NOT NULL DEFAULT '{}',
      error_name TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      error_stack TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_diag_trace_created ON ${p}diagnostic_logs(trace_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_diag_filters ON ${p}diagnostic_logs(category, level, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_diag_run_created ON ${p}diagnostic_logs(run_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_diag_release_created ON ${p}diagnostic_logs(release_id, created_at DESC);
  `);

  await adapter.exec(`
    ALTER TABLE ${p}releases ADD COLUMN IF NOT EXISTS manifest_hash TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${p}releases ADD COLUMN IF NOT EXISTS manifest_json JSONB NOT NULL DEFAULT '{}';
    ALTER TABLE ${p}releases ADD COLUMN IF NOT EXISTS created_by TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${p}releases ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE ${p}releases ADD COLUMN IF NOT EXISTS published_by TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${p}agent_events ADD COLUMN IF NOT EXISTS feedback_type TEXT NOT NULL DEFAULT 'hit';
    ALTER TABLE ${p}agent_events ADD COLUMN IF NOT EXISTS suggested_action TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${p}agent_events ADD COLUMN IF NOT EXISTS task_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${p}knowledge_build_runs ADD COLUMN IF NOT EXISTS current_stage TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${p}knowledge_build_runs ADD COLUMN IF NOT EXISTS completed_stages JSONB NOT NULL DEFAULT '[]';
    ALTER TABLE ${p}knowledge_rule_profiles ADD COLUMN IF NOT EXISTS hash TEXT NOT NULL DEFAULT '';
  `);

  // 默认资料集
  await adapter.query(
    `INSERT INTO ${p}source_bundles (bundle_id, name, description, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (bundle_id) DO NOTHING`,
    ["default", "默认资料集", "gamedata 表格 + gamedocs 文档统一版本化", new Date(0).toISOString()]
  );

  const defaultQualityProfile = {
    minPackageScore: 0.75,
    rules: {
      wikiSpecCompleteness: { enabled: true, severity: "blocking", minScore: 0.75 },
      requiredFacts: { enabled: true, severity: "warning", minScore: 0.7 },
      frontmatterSource: { enabled: true, severity: "blocking" },
      metaWikiSync: { enabled: true, severity: "blocking" },
      tableRegistryConsistency: { enabled: true, severity: "warning", minScore: 0.9 },
      graphIntegrity: { enabled: true, severity: "blocking", minScore: 0.7 },
      indexCoverage: { enabled: true, severity: "warning", minScore: 0.9 },
      conceptOveruse: { enabled: true, severity: "warning", maxRatio: 0.35 }
    }
  };
  await adapter.query(
    `INSERT INTO ${p}quality_gate_profiles (profile_id, name, active, config_json, created_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (profile_id) DO NOTHING`,
    ["default", "默认知识质量门禁", true, defaultQualityProfile, "system", new Date(0).toISOString()]
  );

  const defaultRuleProfile = {
    pageTypes: {
      system: {
        id: "system",
        label: "系统规则",
        dir: "systems",
        template: "system_rule.md",
        requiredSections: ["Overview", "Data Dependencies"],
        requiredFacts: ["config_table"],
        evidenceRequired: true,
        publishable: true
      },
      concept: {
        id: "concept",
        label: "概念说明",
        dir: "concepts",
        template: "concept.md",
        requiredSections: ["Overview"],
        requiredFacts: [],
        evidenceRequired: false,
        publishable: true
      },
      table: {
        id: "table",
        label: "配置表说明",
        dir: "tables",
        template: "table_schema.md",
        requiredSections: ["Overview"],
        requiredFacts: [],
        evidenceRequired: true,
        publishable: true
      }
    },
    entityTypes: [
      { id: "system", label: "系统", publishable: true },
      { id: "activity", label: "活动", publishable: true },
      { id: "table", label: "配置表", publishable: true },
      { id: "resource", label: "资源", publishable: true },
      { id: "attribute", label: "属性", publishable: true },
      { id: "concept", label: "概念", publishable: true },
      { id: "ui_element", label: "界面元素", publishable: true },
      { id: "progression", label: "成长线", publishable: true },
      { id: "field", label: "字段", publishable: true }
    ],
    relationTypes: [
      { id: "depends_on", label: "依赖", direction: "source_to_target", publishable: true, autoGenerated: false },
      { id: "unlocks", label: "解锁", direction: "source_to_target", publishable: true, autoGenerated: false },
      { id: "configured_in", label: "配置于", direction: "source_to_target", publishable: true, autoGenerated: false },
      { id: "configured_by_field", label: "由字段配置", direction: "source_to_target", publishable: true, autoGenerated: false },
      { id: "produces", label: "产出", direction: "source_to_target", publishable: true, autoGenerated: false },
      { id: "consumes", label: "消耗", direction: "source_to_target", publishable: true, autoGenerated: false },
      { id: "belongs_to", label: "属于", direction: "source_to_target", publishable: true, autoGenerated: false },
      { id: "references", label: "引用", direction: "source_to_target", publishable: true, autoGenerated: false },
      { id: "has_field", label: "拥有字段", direction: "source_to_target", publishable: true, autoGenerated: true },
      { id: "fk_to", label: "外键指向", direction: "source_to_target", publishable: true, autoGenerated: true }
    ],
    tableRules: {
      autoConfirmFieldIdSuffixes: ["Id", "Ids"],
      candidateFieldIdSuffixes: []
    },
    qualityRules: {}
  };
  await adapter.query(
    `INSERT INTO ${p}knowledge_rule_profiles (profile_id, name, active, hash, config_json, created_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (profile_id) DO NOTHING`,
    ["default", "默认策划立法规则", true, "", defaultRuleProfile, "system", new Date(0).toISOString()]
  );
}

async function seedDefaultUsers(adapter: DatabaseAdapter, schema: string): Promise<void> {
  const p = schemaPrefix(schema);
  const { rows } = await adapter.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${p}users`);
  if (rows[0].count > 0) return;

  const stmt = `INSERT INTO ${p}users (id, username, password_hash, role, display_name) VALUES ($1, $2, $3, $4, $5)`;
  await adapter.query(stmt, ["usr_admin", "admin", bcrypt.hashSync("adminpw", 8), "admin", "管理员"]);
  await adapter.query(stmt, ["usr_dev", "dev", bcrypt.hashSync("devpw", 8), "developer", "主开发者"]);
  await adapter.query(stmt, ["usr_viewer", "viewer", bcrypt.hashSync("viewpw", 8), "viewer", "访客"]);
}
