import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export interface LegacyScanSummary {
  root: string;
  recommendedPackageId: string;
  sources: { total: number; files: string[] };
  wiki: { pages: number; files: string[] };
  index: { files: number; paths: string[] };
  graph: { files: number; paths: string[] };
  tables: { files: number; paths: string[] };
  warnings: string[];
}

const SOURCE_EXTENSIONS = new Set([".docx", ".xlsx", ".xls", ".md", ".markdown", ".csv", ".json", ".txt"]);

export function scanLegacyKbBuilder(rootPath: string): LegacyScanSummary {
  const root = resolve(rootPath);
  const warnings: string[] = [];

  const gamedocs = join(root, "gamedocs");
  const gamedata = join(root, "gamedata");
  const sourceFiles = [
    ...listFiles(gamedocs, SOURCE_EXTENSIONS),
    ...listFiles(gamedata, SOURCE_EXTENSIONS)
  ];
  if (!existsSync(gamedocs) && !existsSync(gamedata)) {
    warnings.push("缺少 gamedocs/ 或 gamedata/，无法发现原始资料。");
  }

  const wikiRoot = join(root, "wiki");
  const wikiFiles = listFiles(wikiRoot, new Set([".md", ".markdown"]))
    .filter((path) => !relative(root, path).includes("/_meta/"));
  if (!existsSync(wikiRoot)) {
    warnings.push("缺少 wiki/，无法发现 Wiki 页面。");
  }

  const metaRoot = join(wikiRoot, "_meta");
  const indexFiles = listFiles(metaRoot, new Set([".json", ".md", ".markdown"]));
  if (!existsSync(metaRoot)) {
    warnings.push("缺少 wiki/_meta/，无法发现旧索引资产。");
  }

  const graphFiles = [
    ...listFiles(join(root, "graph"), new Set([".json", ".graphml", ".gexf"])),
    ...listFiles(join(root, "wiki", "_graph"), new Set([".json", ".graphml", ".gexf"]))
  ];

  const tableFiles = [
    ...listFiles(join(root, "tables"), new Set([".json", ".md", ".xlsx", ".csv"])),
    ...listFiles(join(root, "wiki", "tables"), new Set([".md", ".markdown", ".json"]))
  ];

  return {
    root,
    recommendedPackageId: `pkg_legacy_${slug(basename(root))}`,
    sources: {
      total: sourceFiles.length,
      files: sourceFiles.map((path) => relative(root, path))
    },
    wiki: {
      pages: wikiFiles.length,
      files: wikiFiles.map((path) => relative(root, path))
    },
    index: {
      files: indexFiles.length,
      paths: indexFiles.map((path) => relative(root, path))
    },
    graph: {
      files: graphFiles.length,
      paths: graphFiles.map((path) => relative(root, path))
    },
    tables: {
      files: tableFiles.length,
      paths: tableFiles.map((path) => relative(root, path))
    },
    warnings
  };
}

function listFiles(root: string, extensions: Set<string>): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      out.push(...listFiles(path, extensions));
      continue;
    }
    const dot = entry.lastIndexOf(".");
    const ext = dot >= 0 ? entry.slice(dot).toLowerCase() : "";
    if (extensions.has(ext)) out.push(path);
  }
  return out.sort();
}

function relative(root: string, path: string): string {
  return path.replace(resolve(root), "").replace(/^[/\\]/, "").replaceAll("\\", "/");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "import";
}
