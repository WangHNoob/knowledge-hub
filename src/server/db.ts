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
    CREATE TABLE IF NOT EXISTS ${p}projects (
      project_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ${p}users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      display_name TEXT NOT NULL,
      current_project_id TEXT NOT NULL DEFAULT 'default_project'
    );

    CREATE TABLE IF NOT EXISTS ${p}source_blobs (
      content_hash TEXT PRIMARY KEY,
      byte_size BIGINT NOT NULL,
      storage_uri TEXT NOT NULL,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ${p}source_bundles (
      bundle_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'default_project',
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
      project_id TEXT NOT NULL DEFAULT 'default_project',
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
      project_id TEXT NOT NULL DEFAULT 'default_project',
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
      project_id TEXT NOT NULL DEFAULT 'default_project',
      package_id TEXT NOT NULL REFERENCES ${p}asset_packages(package_id) ON DELETE CASCADE,
      component_id TEXT NOT NULL REFERENCES ${p}asset_components(component_id) ON DELETE CASCADE,
      severity TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      suggested_action TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_by TEXT NOT NULL DEFAULT '',
      resolved_at TIMESTAMPTZ,
      resolution_note TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS ${p}annotation_examples (
      example_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'default_project',
      package_id TEXT NOT NULL REFERENCES ${p}asset_packages(package_id) ON DELETE CASCADE,
      component_id TEXT NOT NULL REFERENCES ${p}asset_components(component_id) ON DELETE CASCADE,
      task_id TEXT NOT NULL DEFAULT '',
      rule_id TEXT NOT NULL DEFAULT '',
      apply_mode TEXT NOT NULL DEFAULT 'hint',
      page_type TEXT NOT NULL DEFAULT '',
      context_hash TEXT NOT NULL,
      context_snapshot JSONB NOT NULL DEFAULT '{}',
      correct_value JSONB NOT NULL DEFAULT '{}',
      active BOOLEAN NOT NULL DEFAULT true,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ${p}source_corrections (
      correction_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'default_project',
      bundle_id TEXT NOT NULL DEFAULT '',
      source_path TEXT NOT NULL DEFAULT '',
      rule_id TEXT NOT NULL DEFAULT '',
      page_type TEXT NOT NULL DEFAULT '',
      fact_key TEXT,
      bound_source_hash TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'active',
      correct_value JSONB NOT NULL DEFAULT '{}',
      component_id TEXT,
      package_id TEXT,
      example_id TEXT NOT NULL DEFAULT '',
      task_id TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ${p}rule_dismissals (
      dismissal_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'default_project',
      package_id TEXT NOT NULL REFERENCES ${p}asset_packages(package_id) ON DELETE CASCADE,
      component_id TEXT NOT NULL REFERENCES ${p}asset_components(component_id) ON DELETE CASCADE,
      component_ref TEXT NOT NULL DEFAULT '',
      rule_id TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT true,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (component_id, rule_id)
    );

    CREATE TABLE IF NOT EXISTS ${p}knowledge_events (
      event_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'default_project',
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT NOT NULL DEFAULT '',
      payload_json JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ${p}knowledge_event_outbox (
      outbox_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT NOT NULL DEFAULT '',
      payload_json JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS ${p}knowledge_lint_remediations (
      remediation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'default_project',
      release_id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'warning',
      action_type TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      auto_eligible BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      diagnosis TEXT NOT NULL DEFAULT '',
      remediation TEXT NOT NULL DEFAULT '',
      target_component_id TEXT NOT NULL DEFAULT '',
      target_okf_path TEXT NOT NULL DEFAULT '',
      run_id TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      UNIQUE (release_id, issue_id)
    );

    CREATE TABLE IF NOT EXISTS ${p}knowledge_governance_profiles (
      project_id TEXT PRIMARY KEY,
      config_json JSONB NOT NULL DEFAULT '{}',
      updated_by TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ${p}exception_dismissals (
      dismissal_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'default_project',
      dedup_key TEXT NOT NULL,
      exception_type TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      dismissed_by TEXT NOT NULL DEFAULT '',
      dismissed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      restored_by TEXT NOT NULL DEFAULT '',
      restored_at TIMESTAMPTZ,
      UNIQUE (project_id, dedup_key)
    );

    CREATE TABLE IF NOT EXISTS ${p}table_aliases (
      canonical TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'default_project',
      aliases JSONB NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'manual',
      updated_by TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ${p}releases (
      release_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'default_project',
      parent_release_id TEXT,
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
      project_id TEXT NOT NULL DEFAULT 'default_project',
      current_release_id TEXT REFERENCES ${p}releases(release_id),
      updated_by TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ${p}agent_events (
      event_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'default_project',
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
      project_id TEXT NOT NULL DEFAULT 'default_project',
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
    CREATE INDEX IF NOT EXISTS idx_annotation_examples_page_rule ON ${p}annotation_examples(page_type, rule_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_annotation_examples_component ON ${p}annotation_examples(component_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_source_corrections_source ON ${p}source_corrections(bundle_id, source_path, state);
    CREATE INDEX IF NOT EXISTS idx_source_corrections_component ON ${p}source_corrections(component_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_source_corrections_active_anchor
      ON ${p}source_corrections(bundle_id, source_path, rule_id, page_type, COALESCE(fact_key, ''))
      WHERE state <> 'retired';
    CREATE INDEX IF NOT EXISTS idx_rule_dismissals_component ON ${p}rule_dismissals(component_id, active);
    CREATE INDEX IF NOT EXISTS idx_knowledge_events_type_created ON ${p}knowledge_events(event_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_event_outbox_pending ON ${p}knowledge_event_outbox(created_at ASC) WHERE delivered_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_lint_remediations_project_status ON ${p}knowledge_lint_remediations(project_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_exception_dismissals_active ON ${p}exception_dismissals(project_id, restored_at);

    CREATE TABLE IF NOT EXISTS ${p}gap_fill_candidates (
      candidate_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      release_id TEXT NOT NULL DEFAULT '',
      query_key TEXT NOT NULL,
      query_raw TEXT NOT NULL DEFAULT '',
      feedback_type TEXT NOT NULL DEFAULT 'knowledge_gap',
      expected TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      source_bundle_id TEXT NOT NULL DEFAULT '',
      source_path TEXT NOT NULL DEFAULT '',
      event_count INTEGER NOT NULL DEFAULT 1,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (project_id, query_key)
    );
    CREATE INDEX IF NOT EXISTS idx_gap_fill_candidates_open
      ON ${p}gap_fill_candidates(project_id, status, event_count DESC, last_seen_at DESC);
  `);

  await adapter.exec(`
    ALTER TABLE ${p}users ADD COLUMN IF NOT EXISTS current_project_id TEXT NOT NULL DEFAULT 'default_project';
    ALTER TABLE ${p}source_bundles ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT 'default_project';
    ALTER TABLE ${p}knowledge_build_runs ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT 'default_project';
    ALTER TABLE ${p}asset_packages ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT 'default_project';
    ALTER TABLE ${p}review_tasks ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT 'default_project';
    ALTER TABLE ${p}annotation_examples ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT 'default_project';
    ALTER TABLE ${p}source_corrections ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT 'default_project';
    ALTER TABLE ${p}rule_dismissals ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT 'default_project';
    ALTER TABLE ${p}knowledge_events ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT 'default_project';
    ALTER TABLE ${p}table_aliases ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT 'default_project';
    ALTER TABLE ${p}releases ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT 'default_project';
    ALTER TABLE ${p}release_channels ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT 'default_project';
    ALTER TABLE ${p}agent_events ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT 'default_project';
    ALTER TABLE ${p}mcp_audit ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT 'default_project';
    ALTER TABLE ${p}knowledge_lint_remediations ADD COLUMN IF NOT EXISTS run_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${p}releases ADD COLUMN IF NOT EXISTS manifest_hash TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${p}releases ADD COLUMN IF NOT EXISTS manifest_json JSONB NOT NULL DEFAULT '{}';
    ALTER TABLE ${p}releases ADD COLUMN IF NOT EXISTS parent_release_id TEXT;
    ALTER TABLE ${p}releases ADD COLUMN IF NOT EXISTS created_by TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${p}releases ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE ${p}releases ADD COLUMN IF NOT EXISTS published_by TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${p}releases ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${p}agent_events ADD COLUMN IF NOT EXISTS feedback_type TEXT NOT NULL DEFAULT 'hit';
    ALTER TABLE ${p}agent_events ADD COLUMN IF NOT EXISTS suggested_action TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${p}agent_events ADD COLUMN IF NOT EXISTS task_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${p}knowledge_build_runs ADD COLUMN IF NOT EXISTS current_stage TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${p}knowledge_build_runs ADD COLUMN IF NOT EXISTS completed_stages JSONB NOT NULL DEFAULT '[]';
    ALTER TABLE ${p}knowledge_rule_profiles ADD COLUMN IF NOT EXISTS hash TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${p}review_tasks ADD COLUMN IF NOT EXISTS resolved_by TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${p}review_tasks ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
    ALTER TABLE ${p}review_tasks ADD COLUMN IF NOT EXISTS resolution_note TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${p}review_tasks ADD COLUMN IF NOT EXISTS task_kind TEXT NOT NULL DEFAULT 'review';
    ALTER TABLE ${p}review_tasks ADD COLUMN IF NOT EXISTS rule_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${p}review_tasks ADD COLUMN IF NOT EXISTS candidates JSONB NOT NULL DEFAULT '[]';
    ALTER TABLE ${p}review_tasks ADD COLUMN IF NOT EXISTS confidence REAL NOT NULL DEFAULT 0;
    ALTER TABLE ${p}review_tasks ADD COLUMN IF NOT EXISTS context_snapshot JSONB NOT NULL DEFAULT '{}';
    ALTER TABLE ${p}review_tasks ADD COLUMN IF NOT EXISTS annotation_value JSONB NOT NULL DEFAULT '{}';
    ALTER TABLE ${p}review_tasks ADD COLUMN IF NOT EXISTS annotated_by TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${p}review_tasks ADD COLUMN IF NOT EXISTS annotated_at TIMESTAMPTZ;
    ALTER TABLE ${p}annotation_examples ADD COLUMN IF NOT EXISTS apply_mode TEXT NOT NULL DEFAULT 'hint';
    ALTER TABLE ${p}annotation_examples ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE ${p}source_corrections ADD COLUMN IF NOT EXISTS example_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${p}source_corrections ADD COLUMN IF NOT EXISTS task_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${p}source_corrections ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE ${p}rule_dismissals ADD COLUMN IF NOT EXISTS component_ref TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${p}review_tasks ADD COLUMN IF NOT EXISTS auto_fixed BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE ${p}review_tasks ADD COLUMN IF NOT EXISTS llm_analysis JSONB;
    ALTER TABLE ${p}annotation_examples ADD COLUMN IF NOT EXISTS auto_generated BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE ${p}annotation_examples ADD COLUMN IF NOT EXISTS llm_analysis JSONB;
    CREATE INDEX IF NOT EXISTS idx_review_tasks_auto_fixed ON ${p}review_tasks(auto_fixed, status) WHERE auto_fixed = TRUE;
    CREATE INDEX IF NOT EXISTS idx_annotation_examples_override ON ${p}annotation_examples(apply_mode, page_type, rule_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_annotation_examples_active ON ${p}annotation_examples(active, apply_mode, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_source_bundles_project ON ${p}source_bundles(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_asset_packages_project ON ${p}asset_packages(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_build_runs_project ON ${p}knowledge_build_runs(project_id, started_at DESC);
    -- 同项目同资料版本：飞轮类（非 scoped rebuild）同时只允许一条 running，防止双构建并发 persist。
    CREATE UNIQUE INDEX IF NOT EXISTS idx_build_runs_one_running_flywheel
      ON ${p}knowledge_build_runs (project_id, source_version_id)
      WHERE status = 'running'
        AND COALESCE(config_json->>'mergeIntoPackageId', '') = ''
        AND COALESCE(config_json->>'rebuildTaskId', '') = '';
    CREATE INDEX IF NOT EXISTS idx_releases_project ON ${p}releases(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_events_project ON ${p}agent_events(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mcp_audit_project ON ${p}mcp_audit(project_id, created_at DESC);
  `);

  await adapter.exec(`
    INSERT INTO ${p}source_corrections (
      correction_id, bundle_id, source_path, rule_id, page_type, fact_key,
      bound_source_hash, state, correct_value, component_id, package_id,
      example_id, task_id, created_by, created_at, updated_at
    )
    SELECT
      'corr_migrated_' || substr(md5(e.example_id), 1, 16),
      COALESCE(v.bundle_id, 'default'),
      COALESCE(NULLIF(e.context_snapshot ->> 'sourceFile', ''), NULLIF(e.context_snapshot ->> 'sourcePath', ''), ''),
      e.rule_id,
      e.page_type,
      NULLIF(COALESCE(e.correct_value ->> 'factKey', e.correct_value ->> 'fact_key', e.correct_value ->> 'field', e.correct_value ->> 'key', ''), ''),
      COALESCE(sf.content_hash, ''),
      CASE WHEN e.active THEN 'active' ELSE 'retired' END,
      e.correct_value,
      e.component_id,
      e.package_id,
      e.example_id,
      e.task_id,
      e.created_by,
      e.created_at,
      e.created_at
    FROM ${p}annotation_examples e
    LEFT JOIN ${p}asset_packages ap ON ap.package_id = e.package_id
    LEFT JOIN LATERAL (
      SELECT sv.version_id, sv.bundle_id
      FROM ${p}source_bundle_versions sv
      WHERE ap.source_version_ids ? sv.version_id
      ORDER BY sv.created_at DESC, sv.version_id DESC
      LIMIT 1
    ) v ON true
    LEFT JOIN ${p}source_files sf
      ON sf.version_id = v.version_id
     AND sf.logical_path = COALESCE(NULLIF(e.context_snapshot ->> 'sourceFile', ''), NULLIF(e.context_snapshot ->> 'sourcePath', ''), '')
    WHERE e.apply_mode = 'override'
      AND COALESCE(NULLIF(e.context_snapshot ->> 'sourceFile', ''), NULLIF(e.context_snapshot ->> 'sourcePath', ''), '') <> ''
    ON CONFLICT DO NOTHING;
  `);

  await adapter.query(
    `INSERT INTO ${p}projects (project_id, name, description, status, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     ON CONFLICT (project_id) DO NOTHING`,
    ["default_project", "默认项目", "现有知识库数据的默认游戏项目", "active", "system", new Date(0).toISOString()]
  );
  await adapter.query(
    `UPDATE ${p}projects
     SET name = $2, updated_at = $3
     WHERE project_id = $1 AND name = '默认项目'`,
    ["default_project", "默认项目", new Date(0).toISOString()]
  );

  await adapter.query(`UPDATE ${p}users SET current_project_id = 'default_project' WHERE current_project_id = ''`);
  await adapter.query(`UPDATE ${p}source_bundles SET project_id = 'default_project' WHERE project_id = ''`);
  await adapter.query(`UPDATE ${p}asset_packages SET project_id = 'default_project' WHERE project_id = ''`);
  await adapter.query(`UPDATE ${p}knowledge_build_runs SET project_id = 'default_project' WHERE project_id = ''`);
  await adapter.query(`UPDATE ${p}releases SET project_id = 'default_project' WHERE project_id = ''`);
  await adapter.query(`UPDATE ${p}release_channels SET project_id = 'default_project' WHERE project_id = ''`);
  await adapter.query(`UPDATE ${p}agent_events SET project_id = 'default_project' WHERE project_id = ''`);
  await adapter.query(`UPDATE ${p}mcp_audit SET project_id = 'default_project' WHERE project_id = ''`);

  // 默认资料集
  await adapter.query(
    `INSERT INTO ${p}source_bundles (bundle_id, project_id, name, description, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (bundle_id) DO NOTHING`,
    ["default", "default_project", "默认资料集", "gamedata 表格 + gamedocs 文档统一版本化", new Date(0).toISOString()]
  );

  const defaultQualityProfile = {
    minPackageScore: 0.45,
    rules: {
      wikiSpecCompleteness: { enabled: true, severity: "warning", minScore: 0.45 },
      requiredFacts: { enabled: true, severity: "warning", minScore: 0.35 },
      frontmatterSource: { enabled: true, severity: "warning" },
      metaWikiSync: { enabled: true, severity: "warning" },
      tableRegistryConsistency: { enabled: true, severity: "info", minScore: 0.6 },
      graphIntegrity: { enabled: true, severity: "warning", minScore: 0.4 },
      candidateRelationships: { enabled: true, severity: "warning" },
      tableRelationCandidates: { enabled: true, severity: "info" },
      indexCoverage: { enabled: true, severity: "info", minScore: 0.6 },
      conceptOveruse: { enabled: true, severity: "warning", maxRatio: 0.8 }
    }
  };
  await adapter.query(
    `INSERT INTO ${p}quality_gate_profiles (profile_id, name, active, config_json, created_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (profile_id) DO NOTHING`,
    ["default", "默认知识质量门禁", true, defaultQualityProfile, "system", new Date(0).toISOString()]
  );
  await adapter.query(
    `UPDATE ${p}quality_gate_profiles
     SET config_json = $2, updated_at = $3
     WHERE profile_id = $1 AND created_by = 'system'`,
    ["default", defaultQualityProfile, new Date(0).toISOString()]
  );

  // 面向《星轨猎手》模拟知识库（knowledge/gamedocs + gamedata）的默认立法：
  // 必填章节必须与文档 ## 二级标题精确一致（见 kbBuilder/qualityGate）。
  const defaultRuleProfile = {
    documentTypes: {
      concept_note: {
        id: "concept_note",
        label: "术语与总览文档",
        description: "统一术语、枚举与 ID 注册表；是全库唯一权威口径，禁止同义替换或越权注册 ID。",
        defaultPageTypeId: "concept",
        wikiSpecTemplate: {
          requiredSections: [
            "背景与目标",
            "术语表（权威定义，禁止同义替换）",
            "枚举定义（token 全库唯一）",
            "ID 注册表（唯一权威，禁止越权注册）",
            "配表引用",
            "未决问题 / 风险"
          ],
          requiredFacts: ["definition", "source"],
          evidenceRequired: false,
          guidance: "对应 gamedocs/00_项目总览与术语表.md。只承载口径与 ID，不写可执行公式。"
        },
        publishable: true
      },
      numeric_rule: {
        id: "numeric_rule",
        label: "数值与公式文档",
        description: "定义伤害/战力等权威公式、参数来源与边界；同一概念全库只允许一个出处。",
        defaultPageTypeId: "numeric",
        wikiSpecTemplate: {
          requiredSections: ["背景与目标", "配表引用", "未决问题 / 风险"],
          requiredFacts: ["formula", "parameter_source", "source"],
          evidenceRequired: true,
          guidance: "对应 01_战斗框架与伤害公式、02_属性体系与战力评估。公式正文可用自由章节，但必须保留上述必填节。"
        },
        publishable: true
      },
      system_rule: {
        id: "system_rule",
        label: "系统规则文档",
        description: "说明长期系统如何运行、与其他系统接口，以及依赖哪些配表/ID。",
        defaultPageTypeId: "system",
        wikiSpecTemplate: {
          requiredSections: ["背景与目标", "配表引用", "未决问题 / 风险"],
          requiredFacts: ["system_name", "config_table", "source"],
          evidenceRequired: true,
          guidance: "对应技能/Buff/角色/武器装备/副本/掉落经济/商店等系统文档（03–09）。中间业务章节可自由命名。"
        },
        publishable: true
      },
      table_schema: {
        id: "table_schema",
        label: "配表规范文档",
        description: "说明 CSV/xlsx 编码、字段规范、主键粒度与可验证外键清单。",
        defaultPageTypeId: "table",
        wikiSpecTemplate: {
          requiredSections: [
            "背景与目标",
            "文件与编码",
            "字段规范",
            "外键清单（子表字段 → 父表主键，必须可验证）",
            "配表引用",
            "未决问题 / 风险"
          ],
          requiredFacts: ["table_name", "primary_key", "key_fields", "source"],
          evidenceRequired: true,
          guidance: "对应 10_配表规范与外键约定.md；也适用于由 gamedata 生成的表级 Wiki。"
        },
        publishable: true
      },
      qa_checklist: {
        id: "qa_checklist",
        label: "边界与 QA 清单",
        description: "记录自检结论、边界异常用例与跨表证据链，供发布前验收。",
        defaultPageTypeId: "qa",
        wikiSpecTemplate: {
          requiredSections: [
            "自检清单（逐条，全部 PASS）",
            "边界异常用例（QA 必测）",
            "跨 3 跳证据链（写入本文档，防断裂）",
            "未决问题 / 风险"
          ],
          requiredFacts: ["checklist_status", "source"],
          evidenceRequired: true,
          guidance: "对应 11_边界异常与QA检查清单.md。"
        },
        publishable: true
      },
      changelog: {
        id: "changelog",
        label: "版本变更记录",
        description: "记录配表/文档变更摘要，保证 QA 清单可回溯。",
        defaultPageTypeId: "changelog",
        wikiSpecTemplate: {
          requiredSections: ["配表引用"],
          requiredFacts: ["source"],
          evidenceRequired: false,
          guidance: "对应 12_版本变更记录_v0.1.md。"
        },
        publishable: true
      },
      field_spec: {
        id: "field_spec",
        label: "字段说明文档",
        description: "说明高风险字段含义、取值、枚举与关系推断。",
        defaultPageTypeId: "field",
        wikiSpecTemplate: {
          requiredSections: ["字段含义", "取值规则", "枚举或单位", "关系推断"],
          requiredFacts: ["field_name", "field_meaning", "value_rule", "source"],
          evidenceRequired: true,
          guidance: "适用于 Agent 易误读的外键/枚举字段（如 buffId、itemType+itemId、recommendPower）。"
        },
        publishable: true
      },
      activity_gameplay: {
        id: "activity_gameplay",
        label: "活动玩法文档",
        description: "限时/运营活动的参与条件、流程与奖励（本库当前无独立活动篇，预留类型）。",
        defaultPageTypeId: "activity",
        wikiSpecTemplate: {
          requiredSections: ["背景与目标", "配表引用", "未决问题 / 风险"],
          requiredFacts: ["activity_name", "reward", "config_table", "source"],
          evidenceRequired: true,
          guidance: "商店常驻兑换归 system_rule；仅限时活动使用本类型。"
        },
        publishable: true
      },
      ui_flow: {
        id: "ui_flow",
        label: "操作流程文档",
        description: "玩家界面入口、步骤与状态变化（本库偏规则/数值，预留类型）。",
        defaultPageTypeId: "ui_flow",
        wikiSpecTemplate: {
          requiredSections: ["背景与目标", "配表引用", "未决问题 / 风险"],
          requiredFacts: ["entry", "steps", "source"],
          evidenceRequired: true,
          guidance: "有独立 UI 流程稿时使用。"
        },
        publishable: true
      }
    },
    pageTypes: {
      concept: {
        id: "concept",
        label: "术语与总览",
        dir: "concepts",
        template: "concept.md",
        requiredSections: [
          "背景与目标",
          "术语表（权威定义，禁止同义替换）",
          "枚举定义（token 全库唯一）",
          "ID 注册表（唯一权威，禁止越权注册）",
          "配表引用",
          "未决问题 / 风险"
        ],
        requiredFacts: ["definition", "source"],
        evidenceRequired: false,
        publishable: true
      },
      numeric: {
        id: "numeric",
        label: "数值与公式",
        dir: "numeric_rules",
        template: "numeric_rule.md",
        requiredSections: ["背景与目标", "配表引用", "未决问题 / 风险"],
        requiredFacts: ["formula", "parameter_source", "source"],
        evidenceRequired: true,
        publishable: true
      },
      system: {
        id: "system",
        label: "系统规则",
        dir: "systems",
        template: "system_rule.md",
        requiredSections: ["背景与目标", "配表引用", "未决问题 / 风险"],
        requiredFacts: ["system_name", "config_table", "source"],
        evidenceRequired: true,
        publishable: true
      },
      table: {
        id: "table",
        label: "配表规范",
        dir: "tables",
        template: "table_schema.md",
        requiredSections: [
          "背景与目标",
          "文件与编码",
          "字段规范",
          "外键清单（子表字段 → 父表主键，必须可验证）",
          "配表引用",
          "未决问题 / 风险"
        ],
        requiredFacts: ["table_name", "primary_key", "key_fields", "source"],
        evidenceRequired: true,
        publishable: true
      },
      qa: {
        id: "qa",
        label: "边界与 QA",
        dir: "qa",
        template: "qa_checklist.md",
        requiredSections: [
          "自检清单（逐条，全部 PASS）",
          "边界异常用例（QA 必测）",
          "跨 3 跳证据链（写入本文档，防断裂）",
          "未决问题 / 风险"
        ],
        requiredFacts: ["checklist_status", "source"],
        evidenceRequired: true,
        publishable: true
      },
      changelog: {
        id: "changelog",
        label: "版本变更",
        dir: "changelogs",
        template: "changelog.md",
        requiredSections: ["配表引用"],
        requiredFacts: ["source"],
        evidenceRequired: false,
        publishable: true
      },
      field: {
        id: "field",
        label: "字段说明",
        dir: "fields",
        template: "field_spec.md",
        requiredSections: ["字段含义", "取值规则", "枚举或单位", "关系推断"],
        requiredFacts: ["field_name", "field_meaning", "value_rule", "source"],
        evidenceRequired: true,
        publishable: true
      },
      activity: {
        id: "activity",
        label: "活动玩法",
        dir: "activities",
        template: "activity_gameplay.md",
        requiredSections: ["背景与目标", "配表引用", "未决问题 / 风险"],
        requiredFacts: ["activity_name", "reward", "config_table", "source"],
        evidenceRequired: true,
        publishable: true
      },
      ui_flow: {
        id: "ui_flow",
        label: "操作流程",
        dir: "ui_flows",
        template: "ui_flow.md",
        requiredSections: ["背景与目标", "配表引用", "未决问题 / 风险"],
        requiredFacts: ["entry", "steps", "source"],
        evidenceRequired: true,
        publishable: true
      }
    },
    entityTypes: [
      { id: "system", label: "系统", publishable: true },
      { id: "hero", label: "角色", publishable: true },
      { id: "skill", label: "技能", publishable: true },
      { id: "buff", label: "Buff/状态", publishable: true },
      { id: "weapon", label: "武器", publishable: true },
      { id: "equipment", label: "装备", publishable: true },
      { id: "dungeon", label: "副本", publishable: true },
      { id: "drop_table", label: "掉落组", publishable: true },
      { id: "shop_item", label: "商店商品", publishable: true },
      { id: "material", label: "材料", publishable: true },
      { id: "currency", label: "货币", publishable: true },
      { id: "breakthrough", label: "突破", publishable: true },
      { id: "element", label: "元素", publishable: true },
      { id: "attribute", label: "属性", publishable: true },
      { id: "config_table", label: "配置表", publishable: true },
      { id: "field", label: "字段", publishable: true },
      { id: "resource", label: "资源", publishable: true },
      { id: "item", label: "道具", publishable: true },
      { id: "reward", label: "奖励", publishable: true },
      { id: "cost", label: "消耗", publishable: true },
      { id: "condition", label: "条件", publishable: true },
      { id: "state", label: "状态", publishable: true },
      { id: "numeric_item", label: "数值项", publishable: true },
      { id: "progression", label: "成长线", publishable: true },
      { id: "activity", label: "活动", publishable: true },
      { id: "concept", label: "概念", publishable: true }
    ],
    relationTypes: [
      { id: "depends_on", label: "依赖", direction: "source_to_target", publishable: true, autoGenerated: false },
      { id: "affects", label: "影响", direction: "source_to_target", publishable: true, autoGenerated: false },
      { id: "contains", label: "包含", direction: "source_to_target", publishable: true, autoGenerated: true },
      { id: "references", label: "引用", direction: "source_to_target", publishable: true, autoGenerated: false },
      { id: "produces", label: "产出", direction: "source_to_target", publishable: true, autoGenerated: false },
      { id: "consumes", label: "消耗", direction: "source_to_target", publishable: true, autoGenerated: false },
      { id: "prerequisite_of", label: "前置", direction: "source_to_target", publishable: true, autoGenerated: false },
      { id: "mutually_exclusive_with", label: "互斥", direction: "bidirectional", publishable: true, autoGenerated: false },
      { id: "configured_in", label: "配置于", direction: "source_to_target", publishable: true, autoGenerated: false },
      { id: "configured_by_field", label: "由字段配置", direction: "source_to_target", publishable: true, autoGenerated: false },
      { id: "belongs_to", label: "属于", direction: "source_to_target", publishable: true, autoGenerated: false },
      { id: "unlocks", label: "解锁", direction: "source_to_target", publishable: true, autoGenerated: false },
      { id: "grants", label: "授予", direction: "source_to_target", publishable: true, autoGenerated: false },
      { id: "costs", label: "需要消耗", direction: "source_to_target", publishable: true, autoGenerated: false },
      { id: "applies", label: "施加", direction: "source_to_target", publishable: true, autoGenerated: false },
      { id: "counters", label: "克制", direction: "source_to_target", publishable: true, autoGenerated: false },
      { id: "drops_from", label: "掉落自", direction: "source_to_target", publishable: true, autoGenerated: false },
      { id: "upgrades", label: "升级/强化", direction: "source_to_target", publishable: true, autoGenerated: false },
      { id: "has_field", label: "拥有字段", direction: "source_to_target", publishable: true, autoGenerated: true },
      { id: "fk_to", label: "外键指向", direction: "source_to_target", publishable: true, autoGenerated: true }
    ],
    tableRules: {
      autoConfirmFieldIdSuffixes: [
        "Id", "Ids",
        "HeroId", "SkillId", "BuffId", "WeaponId", "EquipId", "DungeonId", "DropId", "ShopId",
        "MaterialId", "PassiveSkillId", "ItemId", "CostId", "ConditionId", "StateId",
        "TableId", "ConfigId", "RewardId", "ActivityId"
      ],
      candidateFieldIdSuffixes: []
    },
    qualityRules: {
      required_wiki_sections_missing: { enabled: true, severity: "blocking", description: "Wiki 缺少该文档类型要求的必填章节（须与 ## 标题精确一致）。" },
      required_facts_missing: { enabled: true, severity: "warning", description: "Wiki 缺少该文档类型要求的关键事实。" },
      source_trace_missing: { enabled: true, severity: "blocking", description: "知识结论无法追溯到 source version 或 evidence。" },
      illegal_relation_type: { enabled: true, severity: "blocking", description: "图谱关系类型不在主策划定义范围内。" },
      concept_overuse: { enabled: true, severity: "warning", description: "实体过度落入概念类型；角色/技能/Buff/配表等应使用专用实体类型。" },
      candidate_relation_unconfirmed: { enabled: true, severity: "warning", description: "候选关系尚未被人工确认，试发布可先带风险放行。" },
      field_relation_unconfirmed: { enabled: true, severity: "info", description: "表字段推断关系先作为提示，不阻断试发布。" },
      stale_rule_profile: { enabled: true, severity: "warning", description: "资产包使用的规则 Profile 已不是当前启用版本，需要复审。" }
    },
    governanceRules: {
      schema: {
        requireFrontmatter: true,
        requireOkfType: true,
        requireDescription: true,
        requireTags: true,
        allowObsidianLinks: false,
        linkMode: "okf_absolute"
      },
      evidence: {
        requiredComponentKinds: ["wiki_page", "table_wiki_page"],
        citationRequiredOkfTypes: ["system_rule", "numeric_rule", "table_schema", "qa_checklist", "activity_gameplay"],
        autoBackfillOnPublish: true,
        missingEvidenceSeverity: "blocking"
      },
      trust: {
        policyVersion: "v2-lite",
        trustedMinScore: 0.85,
        usableMinScore: 0.7,
        reviewMinScore: 0.55,
        blockBelowScore: 0.55,
        warnBelowScore: 0.75,
        blockOnLowTrust: false
      },
      lint: {
        enabledDomains: ["links", "evidence", "graph", "trust", "table_dependencies", "mcp_feedback"],
        blockingDomains: ["evidence", "trust", "table_dependencies", "mcp_feedback"],
        failPublishOnBlocking: false
      },
      agent: {
        includeTrustInMcp: true,
        includeEvidenceInMcp: true,
        recordUnresolvedQueries: true,
        repeatedMissBlockingThreshold: 3
      }
    }
  };
  await adapter.query(
    `INSERT INTO ${p}knowledge_rule_profiles (profile_id, name, active, hash, config_json, created_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (profile_id) DO NOTHING`,
    ["default", "星轨猎手默认策划立法", true, "", defaultRuleProfile, "system", new Date(0).toISOString()]
  );
  await adapter.query(
    `UPDATE ${p}knowledge_rule_profiles
     SET config_json = $2, hash = '', updated_at = $3, name = $4
     WHERE profile_id = $1
       AND created_by = 'system'
       AND (
         config_json #>> '{documentTypes,system_rule,id}' IS NULL
         OR NOT (COALESCE(config_json->'pageTypes'->'system'->'requiredSections', '[]'::jsonb) @> '"背景与目标"'::jsonb)
         OR config_json #>> '{documentTypes,qa_checklist,id}' IS NULL
       )`,
    ["default", defaultRuleProfile, new Date(0).toISOString(), "星轨猎手默认策划立法"]
  );
  await adapter.query(
    `UPDATE ${p}knowledge_rule_profiles
     SET config_json = jsonb_set(jsonb_set(jsonb_set(config_json, '{tableRules,autoConfirmFieldIdSuffixes}', $2::jsonb, true), '{tableRules,candidateFieldIdSuffixes}', '[]'::jsonb, true), '{qualityRules,field_relation_unconfirmed,severity}', '"info"'::jsonb, true),
         hash = '',
         updated_at = $3
     WHERE profile_id = $1 AND created_by = 'system'`,
    ["default", JSON.stringify(defaultRuleProfile.tableRules.autoConfirmFieldIdSuffixes), new Date(0).toISOString()]
  );
  await adapter.query(
    `UPDATE ${p}review_tasks
     SET severity = 'warning'
     WHERE status = 'open'
       AND severity = 'blocking'
       AND (
         task_id LIKE '%wiki_spec_completeness%'
         OR task_id LIKE '%required_facts%'
         OR task_id LIKE '%frontmatter_source%'
         OR task_id LIKE '%graph_integrity%'
         OR task_id LIKE '%candidate_relationships%'
         OR title ILIKE '%Wiki spec incomplete%'
         OR title ILIKE '%Required facts missing%'
         OR title ILIKE '%Source trace invalid%'
         OR title ILIKE '%Graph has unconfirmed candidate relationships%'
       )`
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
