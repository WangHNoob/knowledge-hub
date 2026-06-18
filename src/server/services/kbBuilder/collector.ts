import { basename, relative } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
      const sourceRefs = sourceRefsForArtifact(dataDir, rel);
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

function sourceRefsForArtifact(dataDir: string, rel: string): string[] {
  const refs = sourceRefsFromMeta(metaForArtifact(dataDir, rel));
  if (refs.length > 0) return refs;
  if (rel.startsWith("processed/parsed/") && rel.endsWith(".md")) {
    const source = sourceFromMarkdown(readText(join(dataDir, ...rel.split("/"))));
    return source ? [source] : [];
  }
  return [];
}

function metaForArtifact(dataDir: string, rel: string): Record<string, unknown> | null {
  if (rel.startsWith("wiki/_meta/") && rel.endsWith(".json")) return readJson(join(dataDir, ...rel.split("/")));
  if (rel.startsWith("wiki/") && rel.endsWith(".md") && !rel.startsWith("wiki/tables/")) {
    const slug = basename(rel, ".md");
    return readJson(join(dataDir, "wiki", "_meta", `${slug}.json`));
  }
  return null;
}

function sourceRefsFromMeta(meta: Record<string, unknown> | null): string[] {
  if (!meta) return [];
  const refs = [
    stringValue(meta.source),
    ...stringArray(meta.source_refs),
    ...stringArray(meta.sourceRefs),
  ].filter(Boolean);
  return [...new Set(refs)];
}

function sourceFromMarkdown(markdown: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(markdown);
  if (!match) return "";
  const source = /^source:\s*["']?([^"'\r\n]+)["']?\s*$/mu.exec(match[1]);
  return source?.[1]?.trim() ?? "";
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function readText(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(stringValue).filter(Boolean) : [];
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
