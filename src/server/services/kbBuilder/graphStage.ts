import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeRuleConfig } from "../../types";
import type { StageResult } from "./types";

interface GraphNode {
  id: string;
  label: string;
  type: string;
  wiki_page?: string;
  source?: string;
  table?: string;
}

interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  edge_kind: "semantic" | "table_field" | "fk" | "candidate";
  from_doc?: string;
  field?: string;
  candidate_reason?: string;
}

export async function runGraphStage(options: { dataDir: string; rules?: KnowledgeRuleConfig }): Promise<StageResult> {
  const metas = loadMetas(join(options.dataDir, "wiki", "_meta"));
  const schemas = readJson<Record<string, { fields?: string[] }>>(join(options.dataDir, "wiki", "_tables", "schemas.json"), {});
  const fkEdges = readJson<Array<{ source: string; target: string; field: string }>>(
    join(options.dataDir, "wiki", "_tables", "table_fk_registry.json"),
    [],
  );

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  for (const meta of metas) {
    for (const entity of Array.isArray(meta.entities) ? meta.entities : []) {
      if (!entity?.name || !entity?.type) continue;
      const current = nodes.get(entity.name);
      nodes.set(entity.name, {
        id: entity.name,
        label: entity.name,
        type: entity.type,
        wiki_page: current?.wiki_page || (entity.name === meta.title ? meta.wiki_path : ""),
        source: meta.source,
      });
    }

    for (const relationship of Array.isArray(meta.relationships) ? meta.relationships : []) {
      if (!relationship?.source || !relationship?.target || !relationship?.relation) continue;
      const candidateReason = candidateReasonForRelationship(relationship, nodes, options.rules);
      edges.push({
        source: relationship.source,
        target: relationship.target,
        relation: relationship.relation,
        from_doc: meta.source,
        edge_kind: candidateReason ? "candidate" : "semantic",
        ...(candidateReason ? { candidate_reason: candidateReason } : {}),
      });
    }
  }

  for (const [tableName, schema] of Object.entries(schemas)) {
    const tableId = `table:${tableName}`;
    nodes.set(tableId, { id: tableId, label: tableName, type: "table", source: "table_registry" });
    for (const field of schema.fields ?? []) {
      const fieldId = `field:${tableName}.${field}`;
      nodes.set(fieldId, { id: fieldId, label: field, type: "field", table: tableName });
      edges.push({ source: tableId, target: fieldId, relation: "has_field", edge_kind: "table_field" });
    }
  }

  for (const fk of fkEdges) {
    edges.push({
      source: `field:${fk.source}.${fk.field}`,
      target: `table:${fk.target}`,
      relation: "fk_to",
      field: fk.field,
      edge_kind: "fk",
    });
  }

  const graph = {
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: dedupeEdges(edges),
  };

  mkdirSync(join(options.dataDir, "wiki"), { recursive: true });
  writeFileSync(join(options.dataDir, "wiki", "graph.json"), `${JSON.stringify(graph, null, 2)}\n`);
  writeFileSync(join(options.dataDir, "wiki", "index.md"), renderIndex(graph));
  return { stage: "graph", status: "completed", outputPaths: ["wiki/graph.json", "wiki/index.md"], warnings: [] };
}

function candidateReasonForRelationship(
  relationship: { source: string; target: string; relation: string },
  nodes: Map<string, GraphNode>,
  rules?: KnowledgeRuleConfig,
): string {
  if (!rules) return "";
  const relation = rules.relationTypes.find((item) => item.id === relationship.relation);
  if (!relation || !relation.publishable) return "unknown_or_unpublishable_relation";
  const source = nodes.get(relationship.source);
  const target = nodes.get(relationship.target);
  if (!source || !target) return "unknown_endpoint";
  const publishableEntityTypes = new Set(rules.entityTypes.filter((item) => item.publishable).map((item) => item.id));
  if (!publishableEntityTypes.has(source.type) || !publishableEntityTypes.has(target.type)) return "unknown_or_unpublishable_entity_type";
  return "";
}

function loadMetas(metaDir: string): any[] {
  if (!existsSync(metaDir)) return [];
  return readdirSync(metaDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => readJson(join(metaDir, file), null))
    .filter(Boolean);
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  const out: GraphEdge[] = [];
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    const key = `${edge.source}\0${edge.relation}\0${edge.target}\0${edge.from_doc ?? ""}\0${edge.field ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  return out.sort((a, b) => `${a.source}.${a.relation}.${a.target}`.localeCompare(`${b.source}.${b.relation}.${b.target}`));
}

function renderIndex(graph: { nodes: GraphNode[]; edges: GraphEdge[] }): string {
  const byType = new Map<string, GraphNode[]>();
  for (const node of graph.nodes) {
    byType.set(node.type, [...(byType.get(node.type) ?? []), node]);
  }

  const lines = ["# Knowledge Index", ""];
  for (const [type, nodes] of [...byType.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`## ${type}`, "");
    for (const node of nodes.sort((a, b) => a.label.localeCompare(b.label))) {
      lines.push(`- ${node.wiki_page ? `[${node.label}](${node.wiki_page.replace(/^wiki\//, "")})` : node.label}`);
    }
    lines.push("");
  }
  lines.push("## Relationships", "");
  for (const edge of graph.edges) {
    lines.push(`- ${edge.source} -${edge.relation}-> ${edge.target}`);
  }
  lines.push("");
  return lines.join("\n");
}
