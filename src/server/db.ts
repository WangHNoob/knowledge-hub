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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_by TEXT NOT NULL DEFAULT '',
      resolved_at TIMESTAMPTZ,
      resolution_note TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS ${p}annotation_examples (
      example_id TEXT PRIMARY KEY,
      package_id TEXT NOT NULL REFERENCES ${p}asset_packages(package_id) ON DELETE CASCADE,
      component_id TEXT NOT NULL REFERENCES ${p}asset_components(component_id) ON DELETE CASCADE,
      task_id TEXT NOT NULL DEFAULT '',
      rule_id TEXT NOT NULL DEFAULT '',
      page_type TEXT NOT NULL DEFAULT '',
      context_hash TEXT NOT NULL,
      context_snapshot JSONB NOT NULL DEFAULT '{}',
      correct_value JSONB NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ${p}rule_dismissals (
      dismissal_id TEXT PRIMARY KEY,
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
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT NOT NULL DEFAULT '',
      payload_json JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ${p}table_aliases (
      canonical TEXT PRIMARY KEY,
      aliases JSONB NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'manual',
      updated_by TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ${p}releases (
      release_id TEXT PRIMARY KEY,
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
    CREATE INDEX IF NOT EXISTS idx_annotation_examples_page_rule ON ${p}annotation_examples(page_type, rule_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_annotation_examples_component ON ${p}annotation_examples(component_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_rule_dismissals_component ON ${p}rule_dismissals(component_id, active);
    CREATE INDEX IF NOT EXISTS idx_knowledge_events_type_created ON ${p}knowledge_events(event_type, created_at DESC);
  `);

  await adapter.exec(`
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
    ALTER TABLE ${p}rule_dismissals ADD COLUMN IF NOT EXISTS component_ref TEXT NOT NULL DEFAULT '';
  `);

  // 默认资料集
  await adapter.query(
    `INSERT INTO ${p}source_bundles (bundle_id, name, description, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (bundle_id) DO NOTHING`,
    ["default", "默认资料集", "gamedata 表格 + gamedocs 文档统一版本化", new Date(0).toISOString()]
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

  const defaultRuleProfile = {
    documentTypes: {
      system_rule: {
        id: "system_rule",
        label: "系统规则文档",
        description: "说明一个长期存在的游戏系统如何开启、运行、依赖配置并影响其他系统。",
        defaultPageTypeId: "system",
        wikiSpecTemplate: {
          requiredSections: ["概览", "核心规则", "入口与条件", "配置表依赖", "数值与奖励", "边界与异常", "证据"],
          requiredFacts: ["system_name", "entry_condition", "config_table", "reward_or_cost", "source"],
          evidenceRequired: true,
          guidance: "适用于成就、任务、背包、养成线等系统型资料。"
        },
        publishable: true
      },
      activity_gameplay: {
        id: "activity_gameplay",
        label: "活动玩法文档",
        description: "说明限时活动或运营活动的参与条件、流程、奖励和配置依赖。",
        defaultPageTypeId: "activity",
        wikiSpecTemplate: {
          requiredSections: ["概览", "活动目标", "开放条件", "玩法流程", "奖励与消耗", "关联配置表", "证据"],
          requiredFacts: ["activity_name", "open_condition", "flow", "reward", "config_table", "source"],
          evidenceRequired: true,
          guidance: "适用于神秘商店、节日活动、限时玩法等活动资料。"
        },
        publishable: true
      },
      table_schema: {
        id: "table_schema",
        label: "配置表说明文档",
        description: "说明配置表的业务用途、主键、关键字段、枚举和跨表关系。",
        defaultPageTypeId: "table",
        wikiSpecTemplate: {
          requiredSections: ["概览", "表用途", "主键与粒度", "关键字段", "关联表", "常见误用", "证据"],
          requiredFacts: ["table_name", "primary_key", "business_owner", "key_fields", "source"],
          evidenceRequired: true,
          guidance: "适用于 gamedata/xlsx 生成的表级 Wiki。"
        },
        publishable: true
      },
      field_spec: {
        id: "field_spec",
        label: "字段说明文档",
        description: "说明字段含义、取值范围、枚举、默认值、单位和是否可推断关系。",
        defaultPageTypeId: "field",
        wikiSpecTemplate: {
          requiredSections: ["字段含义", "取值规则", "枚举或单位", "关系推断", "证据"],
          requiredFacts: ["field_name", "field_meaning", "value_rule", "source"],
          evidenceRequired: true,
          guidance: "适用于高风险字段、关系字段和 Agent 经常误读的字段。"
        },
        publishable: true
      },
      numeric_rule: {
        id: "numeric_rule",
        label: "数值规则文档",
        description: "说明公式、倍率、阈值、成长曲线和结算顺序。",
        defaultPageTypeId: "numeric",
        wikiSpecTemplate: {
          requiredSections: ["规则目标", "计算公式", "参数来源", "生效条件", "边界情况", "证据"],
          requiredFacts: ["formula", "parameter_source", "effective_condition", "source"],
          evidenceRequired: true,
          guidance: "适用于战力、奖励倍率、成长曲线、概率和结算规则。"
        },
        publishable: true
      },
      concept_note: {
        id: "concept_note",
        label: "概念说明文档",
        description: "说明团队内需要统一口径的业务概念，避免 Agent 把概念误当规则。",
        defaultPageTypeId: "concept",
        wikiSpecTemplate: {
          requiredSections: ["概念定义", "适用范围", "相关系统", "不适用情况"],
          requiredFacts: ["definition"],
          evidenceRequired: false,
          guidance: "只用于术语口径，不承载可执行规则。"
        },
        publishable: true
      },
      ui_flow: {
        id: "ui_flow",
        label: "操作流程文档",
        description: "说明玩家或运营人员在界面上的操作路径、入口和状态变化。",
        defaultPageTypeId: "ui_flow",
        wikiSpecTemplate: {
          requiredSections: ["入口", "操作步骤", "状态变化", "关联系统", "证据"],
          requiredFacts: ["entry", "steps", "state_change", "source"],
          evidenceRequired: true,
          guidance: "适用于界面流程、功能入口和操作路径说明。"
        },
        publishable: true
      }
    },
    pageTypes: {
      system: {
        id: "system",
        label: "系统规则",
        dir: "systems",
        template: "system_rule.md",
        requiredSections: ["概览", "核心规则", "入口与条件", "配置表依赖", "数值与奖励", "边界与异常", "证据"],
        requiredFacts: ["system_name", "entry_condition", "config_table", "source"],
        evidenceRequired: true,
        publishable: true
      },
      activity: {
        id: "activity",
        label: "活动玩法",
        dir: "activities",
        template: "activity_gameplay.md",
        requiredSections: ["概览", "活动目标", "开放条件", "玩法流程", "奖励与消耗", "关联配置表", "证据"],
        requiredFacts: ["activity_name", "open_condition", "flow", "reward", "config_table", "source"],
        evidenceRequired: true,
        publishable: true
      },
      table: {
        id: "table",
        label: "配置表说明",
        dir: "tables",
        template: "table_schema.md",
        requiredSections: ["概览", "表用途", "主键与粒度", "关键字段", "关联表", "常见误用", "证据"],
        requiredFacts: ["table_name", "primary_key", "key_fields", "source"],
        evidenceRequired: true,
        publishable: true
      },
      field: {
        id: "field",
        label: "字段说明",
        dir: "fields",
        template: "field_spec.md",
        requiredSections: ["字段含义", "取值规则", "枚举或单位", "关系推断", "证据"],
        requiredFacts: ["field_name", "field_meaning", "value_rule", "source"],
        evidenceRequired: true,
        publishable: true
      },
      numeric: {
        id: "numeric",
        label: "数值规则",
        dir: "numeric_rules",
        template: "numeric_rule.md",
        requiredSections: ["规则目标", "计算公式", "参数来源", "生效条件", "边界情况", "证据"],
        requiredFacts: ["formula", "parameter_source", "effective_condition", "source"],
        evidenceRequired: true,
        publishable: true
      },
      ui_flow: {
        id: "ui_flow",
        label: "操作流程",
        dir: "ui_flows",
        template: "ui_flow.md",
        requiredSections: ["入口", "操作步骤", "状态变化", "关联系统", "证据"],
        requiredFacts: ["entry", "steps", "state_change", "source"],
        evidenceRequired: true,
        publishable: true
      },
      concept: {
        id: "concept",
        label: "概念说明",
        dir: "concepts",
        template: "concept.md",
        requiredSections: ["概念定义", "适用范围", "相关系统", "不适用情况"],
        requiredFacts: ["definition"],
        evidenceRequired: false,
        publishable: true
      }
    },
    entityTypes: [
      { id: "system", label: "系统", publishable: true },
      { id: "activity", label: "活动", publishable: true },
      { id: "config_table", label: "配置表", publishable: true },
      { id: "field", label: "字段", publishable: true },
      { id: "resource", label: "资源", publishable: true },
      { id: "item", label: "道具", publishable: true },
      { id: "currency", label: "货币", publishable: true },
      { id: "reward", label: "奖励", publishable: true },
      { id: "cost", label: "消耗", publishable: true },
      { id: "condition", label: "条件", publishable: true },
      { id: "state", label: "状态", publishable: true },
      { id: "numeric_item", label: "数值项", publishable: true },
      { id: "ui_element", label: "界面元素", publishable: true },
      { id: "progression", label: "成长线", publishable: true },
      { id: "achievement", label: "成就", publishable: true },
      { id: "task", label: "任务", publishable: true },
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
      { id: "has_field", label: "拥有字段", direction: "source_to_target", publishable: true, autoGenerated: true },
      { id: "fk_to", label: "外键指向", direction: "source_to_target", publishable: true, autoGenerated: true }
    ],
    tableRules: {
      autoConfirmFieldIdSuffixes: ["Id", "Ids", "TableId", "ConfigId", "RewardId", "ItemId", "CostId", "ConditionId", "StateId", "ActivityId"],
      candidateFieldIdSuffixes: []
    },
    qualityRules: {
      required_wiki_sections_missing: { enabled: true, severity: "blocking", description: "Wiki 缺少该文档类型要求的必填章节。" },
      required_facts_missing: { enabled: true, severity: "blocking", description: "Wiki 缺少该文档类型要求的关键事实。" },
      source_trace_missing: { enabled: true, severity: "blocking", description: "知识结论无法追溯到 source version 或 evidence。" },
      illegal_relation_type: { enabled: true, severity: "blocking", description: "图谱关系类型不在主策划定义范围内。" },
      concept_overuse: { enabled: true, severity: "warning", description: "实体过度落入概念类型，说明类型定义或抽取质量不足。" },
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
        citationRequiredOkfTypes: ["system_rule", "activity_template", "table_schema", "ui_flow", "numerical_convention"],
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
    ["default", "默认策划立法规则", true, "", defaultRuleProfile, "system", new Date(0).toISOString()]
  );
  await adapter.query(
    `UPDATE ${p}knowledge_rule_profiles
     SET config_json = $2, hash = '', updated_at = $3
     WHERE profile_id = $1
       AND created_by = 'system'
       AND config_json #>> '{documentTypes,system_rule,id}' IS NULL`,
    ["default", defaultRuleProfile, new Date(0).toISOString()]
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
