import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import bcrypt from "bcryptjs";

import type { DatabaseHandle } from "./types";

export interface CreateDatabaseOptions {
  dataDir: string;
  seed?: boolean;
}

export function createDatabase(options: CreateDatabaseOptions): DatabaseHandle {
  mkdirSync(options.dataDir, { recursive: true });
  const path = join(options.dataDir, "knowledge-hub.sqlite");
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  migrate(sqlite);
  if (options.seed) seedDemoData(sqlite);
  return {
    path,
    sqlite,
    close: () => sqlite.close()
  };
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      display_name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sources (
      source_id TEXT NOT NULL,
      source_version_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_type TEXT NOT NULL,
      status TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      storage_uri TEXT NOT NULL
    );

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
      source_version_id TEXT NOT NULL REFERENCES sources(source_version_id),
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
}

function seedDemoData(db: DatabaseSync): void {
  const existing = db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
  if (existing.count > 0) return;

  const userStmt = db.prepare(
    "INSERT INTO users (id, username, password_hash, role, display_name) VALUES (?, ?, ?, ?, ?)"
  );
  userStmt.run("usr_admin", "admin", bcrypt.hashSync("adminpw", 8), "admin", "管理员");
  userStmt.run("usr_dev", "dev", bcrypt.hashSync("devpw", 8), "developer", "主开发者");
  userStmt.run("usr_viewer", "viewer", bcrypt.hashSync("viewpw", 8), "viewer", "访客");

  const sourceStmt = db.prepare(`
    INSERT INTO sources (source_id, source_version_id, title, source_type, status, content_hash, storage_uri)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  sourceStmt.run("src_design_core", "srcv_design_core_a1", "核心玩法设计文档", "docx", "active", "sha256:a1", "storage/sources/core.docx");
  sourceStmt.run("src_tables_core", "srcv_tables_core_b2", "核心配表合集", "xlsx", "active", "sha256:b2", "storage/sources/tables.xlsx");
  sourceStmt.run("src_event", "srcv_event_c3", "活动玩法说明", "md", "active", "sha256:c3", "storage/sources/event.md");

  const packageStmt = db.prepare(`
    INSERT INTO asset_packages
      (package_id, name, kind, status, description, created_by_run_id, source_version_ids, legacy_paths, quality_summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  packageStmt.run(
    "pkg_legacy_core",
    "核心玩法旧知识库导入",
    "legacy_import",
    "reviewing",
    "从旧 kb-builder 导入的系统、目录、图谱和表结构资产包。",
    "run_legacy_001",
    json(["srcv_design_core_a1", "srcv_tables_core_b2"]),
    json(["wiki/systems", "wiki/_meta", "graph", "tables"]),
    json({ overallScore: 0.82, blockingCount: 2, warningCount: 4 }),
    "2026-06-10T00:00:00Z"
  );
  packageStmt.run(
    "pkg_event_ops",
    "活动运营知识补充包",
    "manual_curated",
    "approved",
    "活动模板、数值约定和运营查询索引。",
    "run_manual_002",
    json(["srcv_event_c3"]),
    json(["wiki/activities", "wiki/numerical"]),
    json({ overallScore: 0.91, blockingCount: 0, warningCount: 1 }),
    "2026-06-10T02:00:00Z"
  );

  const componentStmt = db.prepare(`
    INSERT INTO asset_components
      (component_id, package_id, artifact_id, group_name, kind, title, status, legacy_path, storage_uri, source_refs, quality)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const components = [
    ["cmp_wiki_equipment", "pkg_legacy_core", "art_wiki_equipment", "wiki", "system_rule", "装备系统", "reviewed", "wiki/systems/equipment.md", "storage/artifacts/equipment.md", ["srcv_design_core_a1"], { evidenceCoverage: 0.62, flags: ["missing_evidence"] }],
    ["cmp_wiki_combat", "pkg_legacy_core", "art_wiki_combat", "wiki", "combat_framework", "战斗框架", "approved", "wiki/combat/framework.md", "storage/artifacts/combat.md", ["srcv_design_core_a1"], { evidenceCoverage: 0.88, flags: [] }],
    ["cmp_index_topic", "pkg_legacy_core", "art_index_topic", "index", "topic_index", "主题索引", "reviewed", "wiki/_meta/topic_index.json", "storage/artifacts/topic_index.json", ["srcv_design_core_a1"], { coverage: 0.77, flags: ["orphan_topic"] }],
    ["cmp_index_table_ref", "pkg_legacy_core", "art_index_table_ref", "index", "table_ref_index", "表引用索引", "approved", "wiki/_meta/table_refs.json", "storage/artifacts/table_refs.json", ["srcv_tables_core_b2"], { coverage: 0.93, flags: [] }],
    ["cmp_graph_core", "pkg_legacy_core", "art_graph_core", "graph", "graph_snapshot", "核心知识图谱", "reviewed", "graph/core.json", "storage/artifacts/graph.json", ["srcv_design_core_a1"], { danglingEdges: 1, flags: ["dangling_edge"] }],
    ["cmp_table_items", "pkg_legacy_core", "art_table_items", "table", "table_schema", "道具表结构", "approved", "tables/items.schema.json", "storage/artifacts/items.schema.json", ["srcv_tables_core_b2"], { schemaScore: 0.89, flags: [] }],
    ["cmp_wiki_activity", "pkg_event_ops", "art_wiki_activity", "wiki", "activity_template", "夏季活动模板", "approved", "wiki/activities/summer.md", "storage/artifacts/summer.md", ["srcv_event_c3"], { evidenceCoverage: 0.95, flags: [] }],
    ["cmp_wiki_number", "pkg_event_ops", "art_wiki_number", "wiki", "numerical_convention", "活动数值约定", "approved", "wiki/numerical/event.md", "storage/artifacts/event_number.md", ["srcv_event_c3"], { evidenceCoverage: 0.9, flags: [] }],
    ["cmp_table_event", "pkg_event_ops", "art_table_event", "table", "table_schema", "活动表结构", "approved", "tables/event.schema.json", "storage/artifacts/event.schema.json", ["srcv_event_c3"], { schemaScore: 0.94, flags: [] }]
  ] as const;
  for (const c of components) {
    componentStmt.run(c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8], json(c[9]), json(c[10]));
  }

  const evidenceStmt = db.prepare(`
    INSERT INTO evidence_records
      (evidence_id, package_id, component_id, source_version_id, quote, note, confidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const evidenceRecords = [
    ["ev_combat_goal", "pkg_legacy_core", "cmp_wiki_combat", "srcv_design_core_a1", "战斗目标以 3 分钟单局体验为基准。", "支撑战斗框架页面的核心设计目标。", 0.88],
    ["ev_combat_loop", "pkg_legacy_core", "cmp_wiki_combat", "srcv_design_core_a1", "核心循环包含入场、技能、结算三个阶段。", "补充战斗流程证据。", 0.84],
    ["ev_table_ref", "pkg_legacy_core", "cmp_index_table_ref", "srcv_tables_core_b2", "items 表作为道具字段的主引用表。", "支撑表引用索引。", 0.91],
    ["ev_items_schema", "pkg_legacy_core", "cmp_table_items", "srcv_tables_core_b2", "item_id、quality、stack_limit 为必填字段。", "支撑道具表结构。", 0.93]
  ] as const;
  for (const record of evidenceRecords) {
    evidenceStmt.run(record[0], record[1], record[2], record[3], record[4], record[5], record[6], "2026-06-10T03:30:00Z");
  }

  const taskStmt = db.prepare(`
    INSERT INTO review_tasks
      (task_id, package_id, component_id, severity, status, title, description, suggested_action, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  taskStmt.run("tsk_evidence_equipment", "pkg_legacy_core", "cmp_wiki_equipment", "blocking", "open", "装备系统缺少证据", "页面已进入审核，但关键结论没有 evidence_refs。", "补充 source_refs 或 evidence_refs 后重新审核。", "2026-06-10T03:00:00Z");
  taskStmt.run("tsk_graph_dangling", "pkg_legacy_core", "cmp_graph_core", "blocking", "open", "知识图谱存在悬空边", "图谱快照包含 1 条找不到目标节点的关系。", "补充缺失实体或移除悬空关系后重新生成图谱。", "2026-06-10T03:10:00Z");
  taskStmt.run("tsk_topic_orphan", "pkg_legacy_core", "cmp_index_topic", "warning", "open", "主题索引存在孤儿主题", "主题索引中有条目无法映射到 Wiki 页面。", "合并同义词或补充对应 Wiki 页面。", "2026-06-10T03:20:00Z");

  db.prepare(`
    INSERT INTO releases (release_id, version, status, package_ids, published_at, quality_gate)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    "rel_2026_06_10_001",
    "2026.06.10.001",
    "published",
    json(["pkg_event_ops"]),
    "2026-06-10T04:00:00Z",
    json({ status: "passed", blockingCount: 0, warningCount: 1 })
  );

  const eventStmt = db.prepare(`
    INSERT INTO agent_events (event_id, release_id, query, hit_component_ids, quality_flags, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  eventStmt.run("evt_1", "rel_2026_06_10_001", "夏季活动怎么配奖励", json(["cmp_wiki_activity", "cmp_table_event"]), json([]), "hit", "2026-06-10T05:00:00Z");
  eventStmt.run("evt_2", "rel_2026_06_10_001", "活动数值上限", json(["cmp_wiki_number"]), json([]), "hit", "2026-06-10T05:10:00Z");
  eventStmt.run("evt_3", "rel_2026_06_10_001", "装备异化怎么解锁", json([]), json(["not_in_release"]), "miss", "2026-06-10T05:20:00Z");
  eventStmt.run("evt_4", "rel_2026_06_10_001", "活动表字段含义", json(["cmp_table_event"]), json([]), "hit", "2026-06-10T05:30:00Z");
  eventStmt.run("evt_5", "rel_2026_06_10_001", "活动模板章节", json(["cmp_wiki_activity"]), json([]), "hit", "2026-06-10T05:40:00Z");
}

function json(value: unknown): string {
  return JSON.stringify(value);
}
