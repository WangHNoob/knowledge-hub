import { basename, extname, parse } from "node:path";

import type { AssetComponent, AssetGroup, AssetPackage, DatabaseHandle } from "../types";
import { scanLegacyKbBuilder } from "./legacyScanner";

export interface LegacyImportResult {
  created: boolean;
  package: AssetPackage;
  importedSources: number;
  createdComponents: number;
}

export function importLegacyAsDraftPackage(db: DatabaseHandle, _dataDir: string, legacyRoot: string): LegacyImportResult {
  const scan = scanLegacyKbBuilder(legacyRoot);
  const existing = db.sqlite.prepare("SELECT * FROM asset_packages WHERE package_id = ?").get(scan.recommendedPackageId);
  if (existing) {
    return {
      created: false,
      package: mapPackage(existing as unknown as PackageRow),
      importedSources: 0,
      createdComponents: 0
    };
  }

  const legacySourcePaths = Array.from(new Set(scan.sources.files));
  const packageSlug = slug(scan.recommendedPackageId);
  const now = new Date().toISOString();
  const qualitySummary = {
    overallScore: scan.warnings.length === 0 ? 0.7 : 0.55,
    blockingCount: scan.warnings.length,
    warningCount: scan.index.files === 0 ? 1 : 0
  };

  const componentInputs = [
    ...scan.wiki.files.map((path) => componentInput(scan.recommendedPackageId, packageSlug, "wiki", path, legacySourcePaths)),
    ...scan.index.paths.map((path) => componentInput(scan.recommendedPackageId, packageSlug, "index", path, legacySourcePaths)),
    ...scan.graph.paths.map((path) => componentInput(scan.recommendedPackageId, packageSlug, "graph", path, legacySourcePaths)),
    ...scan.tables.paths.map((path) => componentInput(scan.recommendedPackageId, packageSlug, "table", path, legacySourcePaths))
  ];

  db.sqlite.exec("BEGIN");
  try {
    db.sqlite.prepare(`
      INSERT INTO asset_packages
        (package_id, name, kind, status, description, created_by_run_id, source_version_ids, legacy_paths, quality_summary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      scan.recommendedPackageId,
      `旧知识库导入：${basename(scan.root)}`,
      "legacy_import",
      "draft",
      "由旧 kb-builder data 目录扫描生成的草稿资产包。",
      `run_legacy_${Date.now()}`,
      JSON.stringify(legacySourcePaths),
      JSON.stringify(["gamedocs", "gamedata", "wiki", "wiki/_meta", "graph", "tables"]),
      JSON.stringify(qualitySummary),
      now
    );

    const stmt = db.sqlite.prepare(`
      INSERT INTO asset_components
        (component_id, package_id, artifact_id, group_name, kind, title, status, legacy_path, storage_uri, source_refs, quality)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const component of componentInputs) {
      stmt.run(
        component.componentId,
        component.packageId,
        component.artifactId,
        component.group,
        component.kind,
        component.title,
        component.status,
        component.legacyPath,
        component.storageUri,
        JSON.stringify(component.sourceRefs),
        JSON.stringify(component.quality)
      );
    }
    db.sqlite.exec("COMMIT");
  } catch (error) {
    db.sqlite.exec("ROLLBACK");
    throw error;
  }

  return {
    created: true,
    package: mapPackage(db.sqlite.prepare("SELECT * FROM asset_packages WHERE package_id = ?").get(scan.recommendedPackageId) as unknown as PackageRow),
    importedSources: legacySourcePaths.length,
    createdComponents: componentInputs.length
  };
}

function componentInput(packageId: string, packageSlug: string, group: AssetGroup, legacyPath: string, sourceRefs: string[]): AssetComponent {
  const stem = slug(parse(legacyPath).name);
  return {
    componentId: `cmp_${packageSlug}_${group}_${stem}`,
    packageId,
    artifactId: `art_${packageSlug}_${group}_${stem}`,
    group,
    kind: kindFor(group, legacyPath),
    title: titleFromPath(legacyPath),
    status: "draft",
    legacyPath,
    storageUri: `legacy://${legacyPath}`,
    sourceRefs,
    quality: {
      importedFromLegacy: true,
      evidenceCoverage: 0
    }
  };
}

function kindFor(group: AssetGroup, path: string): string {
  if (group === "wiki") return "wiki_page";
  if (group === "index") return path.includes("topic") ? "topic_index" : "index";
  if (group === "graph") return "graph_snapshot";
  if (group === "table") return extname(path).includes("json") ? "table_schema" : "table_doc";
  return group;
}

function titleFromPath(path: string): string {
  return parse(path).name.replace(/[_-]+/g, " ");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "item";
}

interface PackageRow {
  package_id: string;
  name: string;
  kind: string;
  status: AssetPackage["status"];
  description: string;
  created_by_run_id: string;
  source_version_ids: string;
  legacy_paths: string;
  quality_summary: string;
  created_at: string;
}

function mapPackage(row: PackageRow): AssetPackage {
  return {
    packageId: row.package_id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    description: row.description,
    createdByRunId: row.created_by_run_id,
    sourceVersionIds: JSON.parse(row.source_version_ids) as string[],
    legacyPaths: JSON.parse(row.legacy_paths) as string[],
    qualitySummary: JSON.parse(row.quality_summary) as Record<string, unknown>,
    createdAt: row.created_at
  };
}
