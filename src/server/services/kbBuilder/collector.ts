import { basename, relative } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CollectedArtifact } from "./types";

export function collectPipelineArtifacts(
  dataDir: string,
  storageRoot: string,
  qualityByPath: Record<string, Record<string, unknown>>,
): CollectedArtifact[] {
  return walkFiles(dataDir)
    .map((absolute) => {
      const rel = relative(dataDir, absolute).replace(/\\/g, "/");
      const mapped = mapArtifact(rel);
      if (!mapped) return null;
      const sourceRefs: string[] = [];
      return {
        artifactId: rel,
        group: mapped.group,
        kind: mapped.kind,
        title: basename(rel),
        legacyPath: rel,
        storageUri: relative(storageRoot, absolute).replace(/\\/g, "/"),
        sourceRefs,
        quality: qualityByPath[rel] ?? {},
      };
    })
    .filter(isCollectedArtifact);
}

function isCollectedArtifact(value: CollectedArtifact | null): value is CollectedArtifact {
  return value !== null;
}

function mapArtifact(path: string): Pick<CollectedArtifact, "group" | "kind"> | null {
  if (path.startsWith("processed/parsed/") && path.endsWith(".md")) return { group: "evidence", kind: "processed_doc" };
  if (path.startsWith("wiki/_meta/") && path.endsWith(".json")) return { group: "evidence", kind: "extract_meta" };
  if (path.startsWith("wiki/_tables/")) return { group: "table", kind: "table_registry" };
  if (path.startsWith("table_schemas/") && path.endsWith(".json")) return { group: "table", kind: "table_schema_json" };
  if (path === "wiki/graph.json") return { group: "graph", kind: "graph_snapshot" };
  if (path === "wiki/index.md") return { group: "index", kind: "topic_index" };
  if (path === "wiki/graph.html") return { group: "graph", kind: "graph_view" };
  if (path === "wiki/quality_report.json") return { group: "quality", kind: "quality_report" };
  if (path.startsWith("wiki/") && path.endsWith(".md")) return { group: "wiki", kind: path.startsWith("wiki/tables/") ? "table_wiki_page" : "wiki_page" };
  return null;
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(path));
    else out.push(path);
  }
  return out.sort();
}
