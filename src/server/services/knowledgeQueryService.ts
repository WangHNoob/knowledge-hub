import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { nanoid } from "nanoid";
import xlsx from "xlsx";

import type { AssetComponent, AssetPackage, DatabaseHandle, KnowledgeEnvelope, ReleaseRecord } from "../types";
import { jsonArray, mapComponent, mapPackage } from "../db/mappers";
import type { DiagnosticLogger } from "./diagnosticService";
import { createFeedbackService, type FeedbackService } from "./feedbackService";
import { createReleaseService } from "./releaseService";
import { createSourceBundleService } from "./sourceBundleService";

export interface KnowledgeQueryContext {
  sessionId?: string;
  agentRole?: string;
  traceId?: string;
}

interface ToolResult {
  result: unknown;
  componentIds: string[];
  artifactIds?: string[];
  sourceVersionIds?: string[];
  evidenceIds?: string[];
  forceHit?: boolean;
}

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
  edge_kind?: string;
  from_doc?: string;
  field?: string;
}

interface TableSchema {
  table_name: string;
  rel_path: string;
  fields: string[];
  row_count: number;
  sheets?: string[];
}

export function createKnowledgeQueryService(db: DatabaseHandle, dataDir: string, diagnostics?: DiagnosticLogger) {
  return new KnowledgeQueryService(db, dataDir, diagnostics);
}

export class KnowledgeQueryService {
  private readonly adapter;
  private readonly releaseService;
  private readonly sourceService;
  private readonly feedback: FeedbackService;

  constructor(private readonly db: DatabaseHandle, private readonly dataDir: string, private readonly diagnostics?: DiagnosticLogger) {
    this.adapter = db.adapter;
    this.releaseService = createReleaseService(db);
    this.sourceService = createSourceBundleService(db, dataDir);
    this.feedback = createFeedbackService(db);
  }

  async runTool(toolName: string, payload: Record<string, unknown>, context: KnowledgeQueryContext = {}): Promise<KnowledgeEnvelope<any>> {
    const started = Date.now();
    const span = this.diagnostics?.startSpan({
      traceId: context.traceId,
      category: "mcp",
      message: `Knowledge MCP ${toolName}`,
      actor: context.sessionId ?? "",
      context: { toolName, agentRole: context.agentRole },
      requestPayload: payload
    });
    const release = await this.releaseService.getCurrent();
    if (!release) {
      const error = new Error("No current published release. Publish a release before using Knowledge MCP tools.");
      await span?.fail(error);
      throw error;
    }

    let status: "hit" | "miss" | "error" = "error";
    let hitComponentIds: string[] = [];
    let qualityFlags: string[] = [];
    try {
      const toolResult = await this.executeTool(release, toolName, payload);
      hitComponentIds = uniqueSorted(toolResult.componentIds);
      const evidenceIds = toolResult.evidenceIds ?? await this.evidenceIdsForComponents(hitComponentIds);
      qualityFlags = await this.qualityFlagsForComponents(hitComponentIds, evidenceIds);
      status = toolResult.forceHit || hitComponentIds.length > 0 ? "hit" : "miss";

      const envelope: KnowledgeEnvelope<any> = {
        release: releaseEnvelope(release),
        result: toolResult.result,
        qualityFlags,
        trace: {
          releaseId: release.releaseId,
          componentIds: hitComponentIds,
          artifactIds: toolResult.artifactIds ?? await this.artifactIdsForComponents(hitComponentIds),
          sourceVersionIds: uniqueSorted([...(toolResult.sourceVersionIds ?? []), ...releaseSourceVersionIds(release)]),
          evidenceIds,
        },
      };

      await this.writeAudit({
        context,
        toolName,
        releaseId: release.releaseId,
        payload,
        hitComponentIds,
        qualityFlags,
        status,
        latencyMs: Date.now() - started,
      });
      await this.feedback.applyRules({ release, toolName, payload, hitComponentIds, qualityFlags, status });
      await span?.complete({
        releaseId: release.releaseId,
        status,
        hitComponentIds,
        qualityFlags,
        latencyMs: Date.now() - started
      });
      return envelope;
    } catch (error) {
      await this.writeAudit({
        context,
        toolName,
        releaseId: release.releaseId,
        payload,
        hitComponentIds,
        qualityFlags,
        status: "error",
        latencyMs: Date.now() - started,
      });
      await span?.fail(error, { releaseId: release.releaseId, hitComponentIds, qualityFlags });
      throw error;
    }
  }

  private async executeTool(release: ReleaseRecord, toolName: string, payload: Record<string, unknown>): Promise<ToolResult> {
    switch (toolName) {
      case "kb_get_release":
        return { result: release, componentIds: [], forceHit: true };
      case "kb_search":
        return this.kbSearch(release, stringArg(payload, "query", "q"));
      case "kb_resolve_topic":
        return this.kbResolveTopic(release, stringArg(payload, "topic", "query", "q"));
      case "kb_get_page":
        return this.kbGetPage(release, stringArg(payload, "page", "title", "topic", "componentId"));
      case "kb_get_section":
        return this.kbGetSection(release, stringArg(payload, "page", "title", "topic", "componentId"), stringArg(payload, "section"));
      case "kb_list_pages":
        return this.kbListPages(release);
      case "kb_get_page_tables":
        return this.kbGetPageTables(release, stringArg(payload, "page", "title", "topic", "componentId"));
      case "kb_get_entity":
        return this.kbGetEntity(release, stringArg(payload, "entityId", "id", "name"));
      case "kb_get_neighbors":
        return this.kbGetNeighbors(release, stringArg(payload, "entityId", "id", "name"));
      case "kb_list_entities":
        return this.kbListEntities(release, optionalString(payload, "type"));
      case "kb_get_relations":
        return this.kbGetRelations(release, optionalString(payload, "source"), optionalString(payload, "target"), optionalString(payload, "relation"));
      case "kb_list_tables":
        return this.kbListTables(release);
      case "kb_get_table_schema":
        return this.kbGetTableSchema(release, stringArg(payload, "table", "tableName", "name"));
      case "kb_query_table":
        return this.kbQueryTable(release, stringArg(payload, "table", "tableName", "name"), Number(payload.limit ?? 20), objectArg(payload.where ?? payload.filters));
      case "kb_validate_table":
        return this.kbValidateTable(release, stringArg(payload, "table", "tableName", "name"));
      case "kb_check_table_value":
        return this.kbCheckTableValue(release, stringArg(payload, "table", "tableName", "name"), stringArg(payload, "field"), payload.value);
      case "kb_get_quality":
        return this.kbGetQuality(release, optionalString(payload, "componentId"));
      case "kb_get_evidence":
        return this.kbGetEvidence(release, optionalString(payload, "componentId"), optionalString(payload, "page"));
      default:
        throw new Error(`Unknown Knowledge MCP tool: ${toolName}`);
    }
  }

  private async kbSearch(release: ReleaseRecord, query: string): Promise<ToolResult> {
    const needle = query.toLowerCase();
    const pages = await this.releaseComponents(release, ["wiki_page", "table_wiki_page", "topic_index"]);
    const items = [];
    for (const component of pages) {
      const markdown = await this.readComponentText(component);
      const haystack = `${component.title}\n${component.artifactId}\n${markdown}`.toLowerCase();
      if (!needle || !haystack.includes(needle.split(/\s+/u)[0])) continue;
      const score = scoreText(haystack, needle);
      if (score <= 0) continue;
      items.push({
        componentId: component.componentId,
        title: component.title,
        artifactId: component.artifactId,
        kind: component.kind,
        snippet: snippet(markdown, needle),
        score,
      });
    }
    items.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    return {
      result: { query, items: items.slice(0, 10) },
      componentIds: items.slice(0, 10).map((item) => item.componentId),
    };
  }

  private async kbResolveTopic(release: ReleaseRecord, topic: string): Promise<ToolResult> {
    const search = await this.kbSearch(release, topic);
    const item = (search.result as { items: unknown[] }).items[0] ?? null;
    return { result: { topic, resolved: item }, componentIds: search.componentIds };
  }

  private async kbGetPage(release: ReleaseRecord, page: string): Promise<ToolResult> {
    const component = await this.findPageComponent(release, page);
    if (!component) return { result: { page, found: false }, componentIds: [] };
    const markdown = await this.readComponentText(component);
    return {
      result: { page, found: true, componentId: component.componentId, title: component.title, artifactId: component.artifactId, markdown },
      componentIds: [component.componentId],
      artifactIds: [component.artifactId],
    };
  }

  private async kbGetSection(release: ReleaseRecord, page: string, section: string): Promise<ToolResult> {
    const pageResult = await this.kbGetPage(release, page);
    if (pageResult.componentIds.length === 0) return { result: { page, section, found: false }, componentIds: [] };
    const markdown = String((pageResult.result as Record<string, unknown>).markdown ?? "");
    const extracted = extractSection(markdown, section);
    return {
      result: { page, section, found: Boolean(extracted), markdown: extracted ?? "" },
      componentIds: pageResult.componentIds,
      artifactIds: pageResult.artifactIds,
    };
  }

  private async kbListPages(release: ReleaseRecord): Promise<ToolResult> {
    const pages = await this.releaseComponents(release, ["wiki_page", "table_wiki_page", "topic_index"]);
    return {
      result: {
        pages: pages.map((component) => ({
          componentId: component.componentId,
          title: component.title,
          artifactId: component.artifactId,
          kind: component.kind,
        })),
      },
      componentIds: pages.map((component) => component.componentId),
    };
  }

  private async kbGetPageTables(release: ReleaseRecord, page: string): Promise<ToolResult> {
    const pageResult = await this.kbGetPage(release, page);
    const schemas = await this.tableSchemas(release);
    const markdown = String((pageResult.result as Record<string, unknown>).markdown ?? "");
    const tables = schemas
      .filter(({ schema }) => markdown.includes(schema.table_name))
      .map(({ schema, component }) => ({ table: schema.table_name, componentId: component.componentId, fields: schema.fields }));
    return {
      result: { page, tables },
      componentIds: uniqueSorted([...pageResult.componentIds, ...tables.map((table) => table.componentId)]),
    };
  }

  private async kbGetEntity(release: ReleaseRecord, entityId: string): Promise<ToolResult> {
    const graph = await this.graph(release);
    const node = graph.nodes.find((item) => same(item.id, entityId) || same(item.label, entityId));
    return {
      result: node ? { found: true, node } : { found: false, entityId },
      componentIds: node ? [graph.component.componentId] : [],
      artifactIds: node ? [graph.component.artifactId] : [],
    };
  }

  private async kbGetNeighbors(release: ReleaseRecord, entityId: string): Promise<ToolResult> {
    const graph = await this.graph(release);
    const node = graph.nodes.find((item) => same(item.id, entityId) || same(item.label, entityId));
    if (!node) return { result: { found: false, entityId, nodes: [], edges: [] }, componentIds: [] };
    const edges = graph.edges.filter((edge) => edge.source === node.id || edge.target === node.id);
    const ids = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
    const nodes = graph.nodes.filter((item) => ids.has(item.id));
    return { result: { found: true, node, nodes, edges }, componentIds: [graph.component.componentId], artifactIds: [graph.component.artifactId] };
  }

  private async kbListEntities(release: ReleaseRecord, type?: string): Promise<ToolResult> {
    const graph = await this.graph(release);
    const nodes = type ? graph.nodes.filter((node) => same(node.type, type)) : graph.nodes;
    return { result: { nodes }, componentIds: [graph.component.componentId], artifactIds: [graph.component.artifactId] };
  }

  private async kbGetRelations(release: ReleaseRecord, source?: string, target?: string, relation?: string): Promise<ToolResult> {
    const graph = await this.graph(release);
    const edges = graph.edges.filter((edge) =>
      (!source || same(edge.source, source)) &&
      (!target || same(edge.target, target)) &&
      (!relation || same(edge.relation, relation))
    );
    return { result: { edges }, componentIds: edges.length ? [graph.component.componentId] : [], artifactIds: edges.length ? [graph.component.artifactId] : [] };
  }

  private async kbListTables(release: ReleaseRecord): Promise<ToolResult> {
    const schemas = await this.tableSchemas(release);
    return {
      result: {
        tables: schemas.map(({ schema, component }) => ({
          table: schema.table_name,
          componentId: component.componentId,
          relPath: schema.rel_path,
          fields: schema.fields,
          rowCount: schema.row_count,
        })),
      },
      componentIds: schemas.map(({ component }) => component.componentId),
    };
  }

  private async kbGetTableSchema(release: ReleaseRecord, table: string): Promise<ToolResult> {
    const found = await this.findTableSchema(release, table);
    if (!found) return { result: { found: false, table }, componentIds: [] };
    return {
      result: { found: true, table, schema: found.schema },
      componentIds: [found.component.componentId],
      artifactIds: [found.component.artifactId],
    };
  }

  private async kbQueryTable(release: ReleaseRecord, table: string, limit: number, where: Record<string, unknown>): Promise<ToolResult> {
    const found = await this.findTableSchema(release, table);
    if (!found) return { result: { found: false, table, rows: [] }, componentIds: [] };
    const rows = await this.readTableRows(release, found.schema);
    const filtered = rows.filter((row) => Object.entries(where).every(([key, value]) => String(row[key] ?? "") === String(value)));
    return {
      result: { found: true, table: found.schema.table_name, rows: filtered.slice(0, Math.max(1, Math.min(limit || 20, 200))), totalRows: filtered.length },
      componentIds: [found.component.componentId],
      artifactIds: [found.component.artifactId],
      sourceVersionIds: releaseSourceVersionIds(release),
    };
  }

  private async kbValidateTable(release: ReleaseRecord, table: string): Promise<ToolResult> {
    const found = await this.findTableSchema(release, table);
    if (!found) return { result: { valid: false, table, errors: ["table schema not found"] }, componentIds: [] };
    const rows = await this.readTableRows(release, found.schema);
    const missingFields = found.schema.fields.filter((field) => rows.some((row) => !(field in row)));
    return {
      result: { valid: missingFields.length === 0, table: found.schema.table_name, rowCount: rows.length, missingFields },
      componentIds: [found.component.componentId],
      artifactIds: [found.component.artifactId],
    };
  }

  private async kbCheckTableValue(release: ReleaseRecord, table: string, field: string, value: unknown): Promise<ToolResult> {
    const found = await this.findTableSchema(release, table);
    if (!found) return { result: { found: false, table, matches: [] }, componentIds: [] };
    const rows = await this.readTableRows(release, found.schema);
    const matches = rows.filter((row) => String(row[field] ?? "") === String(value));
    return {
      result: { found: true, table: found.schema.table_name, field, value, matches },
      componentIds: [found.component.componentId],
      artifactIds: [found.component.artifactId],
    };
  }

  private async kbGetQuality(release: ReleaseRecord, componentId?: string): Promise<ToolResult> {
    const components = componentId
      ? (await this.releaseComponents(release)).filter((component) => component.componentId === componentId)
      : await this.releaseComponents(release);
    return {
      result: {
        releaseQuality: release.qualityGate,
        components: components.map((component) => ({
          componentId: component.componentId,
          title: component.title,
          kind: component.kind,
          quality: component.quality,
        })),
      },
      componentIds: components.map((component) => component.componentId),
    };
  }

  private async kbGetEvidence(release: ReleaseRecord, componentId?: string, page?: string): Promise<ToolResult> {
    const component = componentId
      ? (await this.releaseComponents(release)).find((item) => item.componentId === componentId)
      : page ? await this.findPageComponent(release, page) : null;
    const componentIds = component ? [component.componentId] : [];
    const records = componentIds.length ? await this.evidenceRecordsForComponents(componentIds) : [];
    return { result: { records }, componentIds, evidenceIds: records.map((record) => String(record.evidence_id)) };
  }

  private async graph(release: ReleaseRecord): Promise<{ component: AssetComponent; nodes: GraphNode[]; edges: GraphEdge[] }> {
    const component = (await this.releaseComponents(release, ["graph_snapshot"]))[0];
    if (!component) throw new Error("Current release does not contain a graph_snapshot component.");
    const graph = JSON.parse(await this.readComponentText(component)) as { nodes?: GraphNode[]; edges?: GraphEdge[] };
    return { component, nodes: graph.nodes ?? [], edges: graph.edges ?? [] };
  }

  private async tableSchemas(release: ReleaseRecord): Promise<Array<{ component: AssetComponent; schema: TableSchema }>> {
    const components = await this.releaseComponents(release, ["table_schema_json"]);
    const schemas = [];
    for (const component of components) {
      schemas.push({ component, schema: JSON.parse(await this.readComponentText(component)) as TableSchema });
    }
    return schemas;
  }

  private async findTableSchema(release: ReleaseRecord, table: string): Promise<{ component: AssetComponent; schema: TableSchema } | null> {
    const schemas = await this.tableSchemas(release);
    return schemas.find(({ schema, component }) =>
      same(schema.table_name, table) || same(component.title, table) || same(component.artifactId, table)
    ) ?? null;
  }

  private async readTableRows(release: ReleaseRecord, schema: TableSchema): Promise<Array<Record<string, unknown>>> {
    for (const versionId of releaseSourceVersionIds(release)) {
      const file = await this.sourceService.readFile(versionId, schema.rel_path);
      if (!file) continue;
      const workbook = xlsx.read(file.content, { type: "buffer" });
      const rows = [];
      for (const sheetName of workbook.SheetNames) {
        rows.push(...xlsx.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], { defval: "" }));
      }
      return rows;
    }
    throw new Error(`Source table file not found for ${schema.table_name}: ${schema.rel_path}`);
  }

  private async findPageComponent(release: ReleaseRecord, page: string): Promise<AssetComponent | null> {
    const pages = await this.releaseComponents(release, ["wiki_page", "table_wiki_page", "topic_index"]);
    const normalized = normalize(page);
    return pages.find((component) =>
      normalize(component.componentId) === normalized ||
      normalize(component.title) === normalized ||
      normalize(component.artifactId) === normalized ||
      normalize(component.artifactId.replace(/^wiki\//u, "")) === normalized
    ) ?? null;
  }

  private async releaseComponents(release: ReleaseRecord, kinds?: string[]): Promise<AssetComponent[]> {
    const componentIds = manifestComponentIds(release);
    if (componentIds.length === 0) return [];
    const placeholders = componentIds.map((_, index) => `$${index + 1}`).join(",");
    const params: unknown[] = [...componentIds];
    const kindClause = kinds?.length ? ` AND kind IN (${kinds.map((_, index) => `$${params.length + index + 1}`).join(",")})` : "";
    if (kinds?.length) params.push(...kinds);
    const { rows } = await this.adapter.query(
      `SELECT * FROM asset_components WHERE component_id IN (${placeholders})${kindClause} ORDER BY group_name, title`,
      params,
    );
    return rows.map(mapComponent);
  }

  private async releasePackages(release: ReleaseRecord): Promise<AssetPackage[]> {
    if (release.packageIds.length === 0) return [];
    const placeholders = release.packageIds.map((_, index) => `$${index + 1}`).join(",");
    const { rows } = await this.adapter.query(`SELECT * FROM asset_packages WHERE package_id IN (${placeholders})`, release.packageIds);
    return rows.map(mapPackage);
  }

  private async readComponentText(component: AssetComponent): Promise<string> {
    if (component.storageUri.startsWith("legacy://")) throw new Error(`Legacy component is not materialized locally: ${component.componentId}`);
    const packages = await this.releasePackages({ packageIds: [component.packageId] } as ReleaseRecord);
    const runId = packages[0]?.createdByRunId ?? "";
    const candidates = [
      isAbsolute(component.storageUri) ? component.storageUri : "",
      runId ? join(this.dataDir, "kb-build-runs", runId, component.storageUri) : "",
      join(this.dataDir, component.storageUri),
    ].filter(Boolean);
    const path = candidates.find((candidate) => existsSync(candidate));
    if (!path) throw new Error(`Artifact file not found for component ${component.componentId}: ${component.storageUri}`);
    return readFileSync(path, "utf8");
  }

  private async evidenceIdsForComponents(componentIds: string[]): Promise<string[]> {
    return (await this.evidenceRecordsForComponents(componentIds)).map((record) => String(record.evidence_id));
  }

  private async evidenceRecordsForComponents(componentIds: string[]): Promise<Record<string, unknown>[]> {
    if (componentIds.length === 0) return [];
    const placeholders = componentIds.map((_, index) => `$${index + 1}`).join(",");
    const { rows } = await this.adapter.query(
      `SELECT * FROM evidence_records WHERE component_id IN (${placeholders}) ORDER BY created_at DESC, evidence_id`,
      componentIds,
    );
    return rows;
  }

  private async artifactIdsForComponents(componentIds: string[]): Promise<string[]> {
    if (componentIds.length === 0) return [];
    const placeholders = componentIds.map((_, index) => `$${index + 1}`).join(",");
    const { rows } = await this.adapter.query(`SELECT artifact_id FROM asset_components WHERE component_id IN (${placeholders})`, componentIds);
    return rows.map((row) => String(row.artifact_id));
  }

  private async qualityFlagsForComponents(componentIds: string[], evidenceIds: string[]): Promise<string[]> {
    if (componentIds.length === 0) return [];
    const components = await this.componentsByIds(componentIds);
    const flags: string[] = [];
    for (const component of components) {
      const confidence = numberFromQuality(component.quality, ["confidence", "score", "overallScore"]);
      if (confidence !== null && confidence < 0.7) flags.push(`low_quality:${component.componentId}`);
    }
    if (evidenceIds.length === 0) {
      flags.push(...componentIds.map((id) => `evidence_missing:${id}`));
    }
    return uniqueSorted(flags);
  }

  private async componentsByIds(componentIds: string[]): Promise<AssetComponent[]> {
    if (componentIds.length === 0) return [];
    const placeholders = componentIds.map((_, index) => `$${index + 1}`).join(",");
    const { rows } = await this.adapter.query(`SELECT * FROM asset_components WHERE component_id IN (${placeholders})`, componentIds);
    return rows.map(mapComponent);
  }

  private async writeAudit(input: {
    context: KnowledgeQueryContext;
    toolName: string;
    releaseId: string;
    payload: Record<string, unknown>;
    hitComponentIds: string[];
    qualityFlags: string[];
    status: "hit" | "miss" | "error";
    latencyMs: number;
  }): Promise<void> {
    await this.adapter.query(
      `INSERT INTO mcp_audit
        (audit_id, session_id, agent_role, tool_name, release_id, query_payload, hit_component_ids, quality_flags, status, latency_ms, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        `audit_${Date.now()}_${nanoid(6)}`,
        input.context.sessionId ?? "",
        input.context.agentRole ?? "",
        input.toolName,
        input.releaseId,
        JSON.stringify(input.payload),
        JSON.stringify(input.hitComponentIds),
        JSON.stringify(input.qualityFlags),
        input.status,
        input.latencyMs,
        new Date().toISOString(),
      ],
    );
  }
}

function releaseEnvelope(release: ReleaseRecord) {
  return {
    releaseId: release.releaseId,
    version: release.version,
    publishedAt: release.publishedAt,
    manifestHash: release.manifestHash,
  };
}

function releaseSourceVersionIds(release: ReleaseRecord): string[] {
  const manifestSources = jsonArray((release.manifest as Record<string, unknown>).sourceVersionIds);
  const packageSources = Array.isArray((release.manifest as Record<string, unknown>).packages)
    ? ((release.manifest as Record<string, unknown>).packages as Array<Record<string, unknown>>).flatMap((pkg) => jsonArray(pkg.sourceVersionIds))
    : [];
  return uniqueSorted([...manifestSources, ...packageSources]);
}

function manifestComponentIds(release: ReleaseRecord): string[] {
  return uniqueSorted(jsonArray((release.manifest as Record<string, unknown>).componentIds));
}

function stringArg(payload: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  throw new Error(`Missing required argument: ${keys[0]}`);
}

function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function objectArg(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\\/gu, "/").replace(/\s+/gu, " ").trim();
}

function same(a: string | undefined, b: string | undefined): boolean {
  return normalize(a ?? "") === normalize(b ?? "");
}

function scoreText(haystack: string, query: string): number {
  return query.toLowerCase().split(/\s+/u).filter(Boolean).reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function snippet(markdown: string, query: string): string {
  const tokens = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const lines = markdown.split(/\r?\n/u);
  return lines.find((line) => tokens.some((token) => line.toLowerCase().includes(token)))?.slice(0, 240) ?? lines.find(Boolean)?.slice(0, 240) ?? "";
}

function extractSection(markdown: string, section: string): string | null {
  const lines = markdown.split(/\r?\n/u);
  const target = normalize(section);
  let start = -1;
  let level = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.+)$/u.exec(lines[index]);
    if (!match) continue;
    if (start >= 0 && match[1].length <= level) return lines.slice(start, index).join("\n").trim();
    if (start < 0 && normalize(match[2]) === target) {
      start = index + 1;
      level = match[1].length;
    }
  }
  return start >= 0 ? lines.slice(start).join("\n").trim() : null;
}

function numberFromQuality(quality: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = quality[key];
    if (typeof value === "number") return value;
    if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}
