import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import { nanoid } from "nanoid";
import xlsx from "xlsx";

import type { AssetComponent, AssetPackage, DatabaseHandle, KnowledgeEnvelope, ReleaseRecord, TrustScore } from "../types";
import { jsonArray, mapComponent, mapPackage } from "../db/mappers";
import type { DiagnosticLogger } from "./diagnosticService";
import { createFeedbackService, type FeedbackService } from "./feedbackService";
import { createReleaseService } from "./releaseService";
import { createSourceBundleService } from "./sourceBundleService";
import { scoreFromQuality, trustFromQuality } from "./trustScore";

const EVIDENCE_REQUIRED_COMPONENT_KINDS = new Set(["wiki_page"]);

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

interface KnowledgeAssetRef {
  componentId: string;
  artifactId: string;
  title?: string;
  trust?: TrustScore | null;
}

interface OkfGraphAsset {
  componentId: string;
  artifactId: string;
  trust?: TrustScore | null;
  nodes?: GraphNode[];
  edges?: GraphEdge[];
}

interface OkfTableSchemaEntry {
  componentId: string;
  artifactId: string;
  trust?: TrustScore | null;
  sourceVersionIds?: string[];
  schema: TableSchema;
}

interface OkfPage {
  okfPath: string;
  markdown: string;
  body: string;
  title: string;
  type: string;
  componentId: string;
  packageId: string;
  artifactId: string;
  kind: string;
  trust: TrustScore | null;
  citations: OkfCitation[];
}

interface OkfCitation {
  evidenceId: string;
  componentId: string;
  sourceVersionId: string;
  quote: string;
  note: string;
  confidence: number | null;
  okfPath: string;
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
      const okfEvidenceRecords = this.okfEvidenceRecordsForComponents(release, hitComponentIds);
      const dbEvidenceRecords = await this.evidenceRecordsForComponents(hitComponentIds);
      const trust = await this.trustSummaryForComponents(release, hitComponentIds);
      const evidenceIds = toolResult.evidenceIds ?? uniqueSorted([
        ...okfEvidenceRecords.map((record) => record.evidenceId),
        ...dbEvidenceRecords.map((record) => String(record.evidence_id)),
      ]);
      qualityFlags = await this.qualityFlagsForComponents(hitComponentIds, dbEvidenceRecords, new Set(okfEvidenceRecords.map((record) => record.componentId)), new Map(trust.components.map((component) => [component.componentId, component.trust] as const)));
      status = toolResult.forceHit || hitComponentIds.length > 0 ? "hit" : "miss";

      const envelope: KnowledgeEnvelope<any> = {
        release: releaseEnvelope(release),
        result: toolResult.result,
        qualityFlags,
        trust,
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
        return this.kbGetEvidence(release, optionalString(payload, "componentId"), optionalString(payload, "page"), optionalString(payload, "query", "q", "topic"));
      default:
        throw new Error(`Unknown Knowledge MCP tool: ${toolName}`);
    }
  }

  private async kbSearch(release: ReleaseRecord, query: string): Promise<ToolResult> {
    const needle = query.toLowerCase();
    const pages = this.readOkfPages(release);
    const items = [];
    for (const page of pages) {
      const haystack = `${page.title}\n${page.okfPath}\n${page.artifactId}\n${page.markdown}`.toLowerCase();
      if (!needle || !haystack.includes(needle.split(/\s+/u)[0])) continue;
      const score = scoreText(haystack, needle);
      if (score <= 0) continue;
      items.push({
        componentId: page.componentId,
        title: page.title,
        artifactId: page.artifactId,
        okfPath: page.okfPath,
        kind: page.kind,
        type: page.type,
        trust: page.trust,
        snippet: snippet(page.body, needle),
        score,
      });
    }
    items.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    return {
      result: { query, items: items.slice(0, 10) },
      componentIds: items.slice(0, 10).map((item) => item.componentId),
      artifactIds: items.slice(0, 10).map((item) => item.artifactId),
    };
  }

  private async kbResolveTopic(release: ReleaseRecord, topic: string): Promise<ToolResult> {
    const search = await this.kbSearch(release, topic);
    const item = (search.result as { items: unknown[] }).items[0] ?? null;
    return { result: { topic, resolved: item }, componentIds: search.componentIds };
  }

  private async kbGetPage(release: ReleaseRecord, page: string): Promise<ToolResult> {
    const okfPage = this.findOkfPage(release, page);
    if (!okfPage) return { result: { page, found: false }, componentIds: [] };
    return {
      result: {
        page,
        found: true,
        componentId: okfPage.componentId,
        title: okfPage.title,
        artifactId: okfPage.artifactId,
        okfPath: okfPage.okfPath,
        type: okfPage.type,
        trust: okfPage.trust,
        markdown: okfPage.markdown,
      },
      componentIds: [okfPage.componentId],
      artifactIds: [okfPage.artifactId],
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
    const pages = this.readOkfPages(release);
    return {
      result: {
        pages: pages.map((page) => ({
          componentId: page.componentId,
          title: page.title,
          artifactId: page.artifactId,
          okfPath: page.okfPath,
          kind: page.kind,
          type: page.type,
          trust: page.trust,
        })),
      },
      componentIds: pages.map((page) => page.componentId),
      artifactIds: pages.map((page) => page.artifactId),
    };
  }

  private async kbGetPageTables(release: ReleaseRecord, page: string): Promise<ToolResult> {
    const pageResult = await this.kbGetPage(release, page);
    const title = String((pageResult.result as Record<string, unknown>).title ?? page);
    const schemas = await this.tableSchemas(release);
    const markdown = String((pageResult.result as Record<string, unknown>).markdown ?? "");
    const graphTables = await this.pageConfiguredTables(release, title);
    const tables = schemas
      .filter(({ schema }) => markdown.includes(schema.table_name) || graphTables.has(schema.table_name) || graphTables.has(`table:${schema.table_name}`))
      .map(({ schema, component }) => ({ table: schema.table_name, componentId: component.componentId, fields: schema.fields, trust: component.trust ?? null }));
    return {
      result: { page, tables },
      componentIds: uniqueSorted([...pageResult.componentIds, ...tables.map((table) => table.componentId)]),
    };
  }

  private async pageConfiguredTables(release: ReleaseRecord, pageTitle: string): Promise<Set<string>> {
    try {
      const graph = await this.graph(release);
      const pageNode = graph.nodes.find((node) => same(node.label, pageTitle) || same(node.id, pageTitle));
      const sourceIds = new Set([pageTitle, pageNode?.id].filter((value): value is string => Boolean(value)));
      return new Set(graph.edges
        .filter((edge) => sourceIds.has(edge.source) && edge.relation === "configured_in")
        .flatMap((edge) => [edge.target, edge.target.replace(/^table:/u, "")]));
    } catch {
      return new Set();
    }
  }

  private async kbGetEntity(release: ReleaseRecord, entityId: string): Promise<ToolResult> {
    const graph = await this.graph(release);
    const node = graph.nodes.find((item) => same(item.id, entityId) || same(item.label, entityId));
    return {
      result: node ? { found: true, node, trust: graph.component.trust ?? null } : { found: false, entityId },
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
    return { result: { found: true, node, nodes, edges, trust: graph.component.trust ?? null }, componentIds: [graph.component.componentId], artifactIds: [graph.component.artifactId] };
  }

  private async kbListEntities(release: ReleaseRecord, type?: string): Promise<ToolResult> {
    const graph = await this.graph(release);
    const nodes = type ? graph.nodes.filter((node) => same(node.type, type)) : graph.nodes;
    return { result: { nodes, trust: graph.component.trust ?? null }, componentIds: [graph.component.componentId], artifactIds: [graph.component.artifactId] };
  }

  private async kbGetRelations(release: ReleaseRecord, source?: string, target?: string, relation?: string): Promise<ToolResult> {
    const graph = await this.graph(release);
    const edges = graph.edges.filter((edge) =>
      (!source || same(edge.source, source)) &&
      (!target || same(edge.target, target)) &&
      (!relation || same(edge.relation, relation))
    );
    return { result: { edges, trust: edges.length ? graph.component.trust ?? null : null }, componentIds: edges.length ? [graph.component.componentId] : [], artifactIds: edges.length ? [graph.component.artifactId] : [] };
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
          trust: component.trust ?? null,
        })),
      },
      componentIds: schemas.map(({ component }) => component.componentId),
    };
  }

  private async kbGetTableSchema(release: ReleaseRecord, table: string): Promise<ToolResult> {
    const found = await this.findTableSchema(release, table);
    if (!found) return { result: { found: false, table }, componentIds: [] };
    return {
      result: { found: true, table, schema: found.schema, trust: found.component.trust ?? null },
      componentIds: [found.component.componentId],
      artifactIds: [found.component.artifactId],
    };
  }

  private async kbQueryTable(release: ReleaseRecord, table: string, limit: number, where: Record<string, unknown>): Promise<ToolResult> {
    const found = await this.findTableSchema(release, table);
    if (!found) return { result: { found: false, table, rows: [] }, componentIds: [] };
    const rows = await this.readTableRows(release, found.schema, found.sourceVersionIds);
    const filtered = rows.filter((row) => Object.entries(where).every(([key, value]) => String(row[key] ?? "") === String(value)));
    return {
      result: { found: true, table: found.schema.table_name, rows: filtered.slice(0, Math.max(1, Math.min(limit || 20, 200))), totalRows: filtered.length, trust: found.component.trust ?? null },
      componentIds: [found.component.componentId],
      artifactIds: [found.component.artifactId],
      sourceVersionIds: releaseSourceVersionIds(release),
    };
  }

  private async kbValidateTable(release: ReleaseRecord, table: string): Promise<ToolResult> {
    const found = await this.findTableSchema(release, table);
    if (!found) return { result: { valid: false, table, errors: ["table schema not found"] }, componentIds: [] };
    const rows = await this.readTableRows(release, found.schema, found.sourceVersionIds);
    const missingFields = found.schema.fields.filter((field) => rows.some((row) => !(field in row)));
    return {
      result: { valid: missingFields.length === 0, table: found.schema.table_name, rowCount: rows.length, missingFields, trust: found.component.trust ?? null },
      componentIds: [found.component.componentId],
      artifactIds: [found.component.artifactId],
    };
  }

  private async kbCheckTableValue(release: ReleaseRecord, table: string, field: string, value: unknown): Promise<ToolResult> {
    const found = await this.findTableSchema(release, table);
    if (!found) return { result: { found: false, table, matches: [] }, componentIds: [] };
    const rows = await this.readTableRows(release, found.schema, found.sourceVersionIds);
    const matches = rows.filter((row) => String(row[field] ?? "") === String(value));
    return {
      result: { found: true, table: found.schema.table_name, field, value, matches, trust: found.component.trust ?? null },
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

  private async kbGetEvidence(release: ReleaseRecord, componentId?: string, page?: string, query?: string): Promise<ToolResult> {
    const component = componentId
      ? (await this.releaseComponents(release)).find((item) => item.componentId === componentId)
      : null;
    const okfPage = !component && page ? this.findOkfPage(release, page) : null;
    const componentIds = component
      ? [component.componentId]
      : okfPage ? [okfPage.componentId]
        : query ? (await this.kbSearch(release, query)).componentIds : [];
    const okfRecords = this.okfEvidenceRecordsForComponents(release, componentIds);
    const dbRecords = componentIds.length ? await this.evidenceRecordsForComponents(componentIds) : [];
    const records = okfRecords.length ? okfRecords : dbRecords;
    return {
      result: { componentIds, records, source: okfRecords.length ? "okf_bundle" : "database" },
      componentIds,
      evidenceIds: records.map((record) => String("evidenceId" in record ? record.evidenceId : record.evidence_id)),
    };
  }

  private async graph(release: ReleaseRecord): Promise<{ component: KnowledgeAssetRef; nodes: GraphNode[]; edges: GraphEdge[] }> {
    const okfGraph = this.readOkfGraph(release);
    if (okfGraph) {
      return {
        component: { componentId: okfGraph.componentId, artifactId: okfGraph.artifactId, trust: okfGraph.trust ?? null },
        nodes: okfGraph.nodes ?? [],
        edges: okfGraph.edges ?? [],
      };
    }
    const component = (await this.releaseComponents(release, ["graph_snapshot"]))[0];
    if (!component) throw new Error("Current release does not contain a graph_snapshot component.");
    const graph = JSON.parse(await this.readComponentText(component)) as { nodes?: GraphNode[]; edges?: GraphEdge[] };
    return { component: { ...component, trust: trustFromQuality(component.quality) }, nodes: graph.nodes ?? [], edges: graph.edges ?? [] };
  }

  private async tableSchemas(release: ReleaseRecord): Promise<Array<{ component: KnowledgeAssetRef; schema: TableSchema; sourceVersionIds?: string[] }>> {
    const okfSchemas = this.readOkfTableSchemas(release);
    if (okfSchemas.length > 0) {
      return okfSchemas.map((entry) => ({
        component: { componentId: entry.componentId, artifactId: entry.artifactId, trust: entry.trust ?? null },
        schema: entry.schema,
        sourceVersionIds: entry.sourceVersionIds,
      }));
    }
    const components = await this.releaseComponents(release, ["table_schema_json"]);
    const schemas = [];
    for (const component of components) {
      schemas.push({ component: { ...component, trust: trustFromQuality(component.quality) }, schema: JSON.parse(await this.readComponentText(component)) as TableSchema });
    }
    return schemas;
  }

  private readOkfPages(release: ReleaseRecord): OkfPage[] {
    const bundleDir = this.okfBundleDir(release);
    return walkMarkdown(bundleDir)
      .map((absolute) => {
        const rel = relative(bundleDir, absolute).replace(/\\/g, "/");
        if (rel === "index.md" || rel === "log.md") return null;
        return parseOkfPage(`/${rel}`, readFileSync(absolute, "utf8"));
      })
      .filter((page): page is OkfPage => Boolean(page?.componentId));
  }

  private findOkfPage(release: ReleaseRecord, page: string): OkfPage | null {
    const normalized = normalize(page);
    return this.readOkfPages(release).find((item) =>
      normalize(item.componentId) === normalized ||
      normalize(item.title) === normalized ||
      normalize(item.artifactId) === normalized ||
      normalize(item.artifactId.replace(/^wiki\//u, "")) === normalized ||
      normalize(item.okfPath) === normalized ||
      normalize(item.okfPath.replace(/^\//u, "")) === normalized
    ) ?? null;
  }

  private okfEvidenceRecordsForComponents(release: ReleaseRecord, componentIds: string[]): OkfCitation[] {
    if (componentIds.length === 0) return [];
    const wanted = new Set(componentIds);
    return this.readOkfPages(release).flatMap((page) => wanted.has(page.componentId) ? page.citations : []);
  }

  private readOkfGraph(release: ReleaseRecord): OkfGraphAsset | null {
    return this.readOkfJsonAsset<OkfGraphAsset>(release, "graphUri", "graph/graph.json");
  }

  private readOkfTableSchemas(release: ReleaseRecord): OkfTableSchemaEntry[] {
    const manifest = this.readOkfJsonAsset<{ tables?: OkfTableSchemaEntry[] }>(release, "tableSchemasUri", "tables/schemas.json");
    return Array.isArray(manifest?.tables) ? manifest.tables.filter((entry) => Boolean(entry.componentId && entry.schema?.table_name)) : [];
  }

  private readOkfJsonAsset<T>(release: ReleaseRecord, manifestKey: string, fallbackUri: string): T | null {
    const okf = objectArg((release.manifest as Record<string, unknown>).okf);
    const uri = typeof okf[manifestKey] === "string" && String(okf[manifestKey]).trim() ? String(okf[manifestKey]) : fallbackUri;
    const full = this.okfBundleFile(release, uri);
    if (!existsSync(full)) return null;
    return JSON.parse(readFileSync(full, "utf8")) as T;
  }

  private okfBundleDir(release: ReleaseRecord): string {
    const okf = objectArg((release.manifest as Record<string, unknown>).okf);
    const bundleUri = typeof okf.bundleUri === "string" && okf.bundleUri.trim() ? okf.bundleUri : `releases/${release.releaseId}/okf_bundle`;
    const bundleDir = isAbsolute(bundleUri) ? bundleUri : join(this.dataDir, ...bundleUri.split(/[\\/]/u));
    const contained = (() => {
      const rel = relative(this.dataDir, bundleDir);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    })();
    if (!contained) throw new Error(`Refusing to read OKF bundle outside data dir: ${bundleUri}`);
    if (!existsSync(bundleDir)) throw new Error(`Current release OKF bundle not found: ${bundleUri}`);
    return bundleDir;
  }

  private okfBundleFile(release: ReleaseRecord, uri: string): string {
    const bundleDir = this.okfBundleDir(release);
    const full = join(bundleDir, ...uri.replace(/^\/+/u, "").split(/[\\/]/u));
    const rel = relative(bundleDir, full);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Refusing to read OKF asset outside bundle: ${uri}`);
    return full;
  }

  private async findTableSchema(release: ReleaseRecord, table: string): Promise<{ component: KnowledgeAssetRef; schema: TableSchema; sourceVersionIds?: string[] } | null> {
    const schemas = await this.tableSchemas(release);
    return schemas.find(({ schema, component }) =>
      same(schema.table_name, table) || same(component.title, table) || same(component.artifactId, table)
    ) ?? null;
  }

  private async readTableRows(release: ReleaseRecord, schema: TableSchema, sourceVersionIds?: string[]): Promise<Array<Record<string, unknown>>> {
    for (const versionId of (sourceVersionIds?.length ? sourceVersionIds : releaseSourceVersionIds(release))) {
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

  async getComponentFile(packageId: string, componentId: string): Promise<{
    componentId: string;
    kind: string;
    legacyPath: string;
    storageUri: string;
    content: string;
    truncated: boolean;
  }> {
    const { rows } = await this.adapter.query(
      "SELECT * FROM asset_components WHERE component_id = $1 AND package_id = $2",
      [componentId, packageId],
    );
    if (rows.length === 0) throw new Error(`Component not found in package: ${componentId}`);
    const component = mapComponent(rows[0]);
    if (component.storageUri.startsWith("legacy://")) {
      throw new Error(`Legacy component is not materialized locally: ${componentId}`);
    }

    const packages = await this.releasePackages({ packageIds: [component.packageId] } as ReleaseRecord);
    const runId = packages[0]?.createdByRunId ?? "";
    const runRoot = runId ? join(this.dataDir, "kb-build-runs", runId) : "";
    const candidates = [
      isAbsolute(component.storageUri) ? component.storageUri : "",
      runRoot ? join(runRoot, component.storageUri) : "",
      join(this.dataDir, component.storageUri),
    ].filter(Boolean);

    const resolved = candidates.find((candidate) => existsSync(candidate));
    if (!resolved) throw new Error(`Artifact file not found for component ${componentId}: ${component.storageUri}`);

    // Path-containment guard: resolved file must stay under the run workspace or the data dir.
    const allowedRoots = [runRoot, this.dataDir].filter(Boolean);
    const contained = allowedRoots.some((root) => {
      const rel = relative(root, resolved);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
    if (!contained) throw new Error(`Refusing to read file outside allowed roots: ${componentId}`);

    const MAX_BYTES = 512 * 1024;
    const raw = readFileSync(resolved, "utf8");
    const truncated = raw.length > MAX_BYTES;
    return {
      componentId: component.componentId,
      kind: component.kind,
      legacyPath: component.legacyPath,
      storageUri: component.storageUri,
      content: truncated ? `${raw.slice(0, MAX_BYTES)}\n\n…[truncated ${raw.length - MAX_BYTES} chars]` : raw,
      truncated,
    };
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

  private async trustSummaryForComponents(release: ReleaseRecord, componentIds: string[]): Promise<KnowledgeEnvelope["trust"]> {
    if (componentIds.length === 0) return { averageScore: null, minScore: null, components: [] };
    const components = await this.componentsByIds(componentIds);
    const okfTrust = this.okfTrustByComponent(release, componentIds);
    const out = components.map((component) => ({
      componentId: component.componentId,
      artifactId: component.artifactId,
      title: component.title,
      kind: component.kind,
      trust: okfTrust.get(component.componentId) ?? trustFromQuality(component.quality),
    }));
    const scores = out.map((component) => component.trust?.score).filter((score): score is number => typeof score === "number" && Number.isFinite(score));
    return {
      averageScore: scores.length ? round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : null,
      minScore: scores.length ? Math.min(...scores) : null,
      components: out,
    };
  }

  private okfTrustByComponent(release: ReleaseRecord, componentIds: string[]): Map<string, TrustScore | null> {
    const wanted = new Set(componentIds);
    const out = new Map<string, TrustScore | null>();
    for (const page of this.readOkfPages(release)) {
      if (wanted.has(page.componentId)) out.set(page.componentId, page.trust);
    }
    const graph = this.readOkfGraph(release);
    if (graph && wanted.has(graph.componentId)) out.set(graph.componentId, graph.trust ?? null);
    for (const entry of this.readOkfTableSchemas(release)) {
      if (wanted.has(entry.componentId)) out.set(entry.componentId, entry.trust ?? null);
    }
    return out;
  }

  private async qualityFlagsForComponents(componentIds: string[], evidenceRecords: Record<string, unknown>[], okfEvidenceComponentIds = new Set<string>(), trustByComponent = new Map<string, TrustScore | null>()): Promise<string[]> {
    if (componentIds.length === 0) return [];
    const components = await this.componentsByIds(componentIds);
    const componentsWithEvidence = new Set(evidenceRecords.map((record) => String(record.component_id)));
    const flags: string[] = [];
    for (const component of components) {
      const trustScore = trustByComponent.get(component.componentId)?.score ?? scoreFromQuality(component.quality);
      if (trustScore !== null && trustScore < 0.7) flags.push(`low_trust:${component.componentId}`);
      if (EVIDENCE_REQUIRED_COMPONENT_KINDS.has(component.kind) && !componentsWithEvidence.has(component.componentId) && !okfEvidenceComponentIds.has(component.componentId)) {
        flags.push(`evidence_missing:${component.componentId}`);
      }
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

function optionalString(payload: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
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

function walkMarkdown(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out.sort();
}

function parseOkfPage(okfPath: string, markdown: string): OkfPage | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(markdown);
  if (!match) return null;
  const frontmatter = match[1];
  const body = match[2];
  const componentId = yamlScalar(frontmatter, "componentId");
  const artifactId = yamlScalar(frontmatter, "artifactId") || okfPath.replace(/^\//u, "");
  return {
    okfPath,
    markdown,
    body,
    title: yamlScalar(frontmatter, "title") || okfPath.split("/").pop()?.replace(/\.md$/u, "") || okfPath,
    type: yamlScalar(frontmatter, "type") || "knowledge_note",
    componentId,
    packageId: yamlScalar(frontmatter, "packageId"),
    artifactId,
    kind: okfKind(frontmatter, artifactId),
    trust: parseOkfTrust(frontmatter),
    citations: parseOkfCitations(body, componentId, okfPath),
  };
}

function parseOkfTrust(frontmatter: string): TrustScore | null {
  const score = numberScalar(frontmatter, "score");
  const version = yamlScalar(frontmatter, "version");
  if (score === null || version !== "v2-lite") return null;
  return {
    version: "v2-lite",
    score,
    status: statusScalar(yamlScalar(frontmatter, "status")),
    breakdown: {
      evidence: numberScalar(frontmatter, "evidence") ?? 0,
      completeness: numberScalar(frontmatter, "completeness") ?? 0,
      auditFreshness: numberScalar(frontmatter, "auditFreshness") ?? 0,
      consistency: numberScalar(frontmatter, "consistency") ?? 0,
    },
    caps: [],
    reasons: [],
    lastTrustedAuditAt: yamlScalar(frontmatter, "lastTrustedAuditAt") || null,
    auditHalfLifeDays: 180,
    evidenceRequired: true,
  };
}

function parseOkfCitations(body: string, componentId: string, okfPath: string): OkfCitation[] {
  const lines = body.split(/\r?\n/u);
  const headingIndex = lines.findIndex((line) => /^#\s+(Citations|引用|证据)\s*$/iu.test(line.trim()));
  if (headingIndex < 0) return [];
  const out: OkfCitation[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (/^#\s+\S/u.test(line)) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^\d+\.\s+(.+?)(?:\s+\((.+)\))?$/u.exec(trimmed);
    if (!match) continue;
    const meta = match[2] ?? "";
    const idMatch = /(^|;\s*)([^;()\s]+)(?=;|$)/u.exec(meta);
    const sourceMatch = /source\s+([^;()\s]+)/iu.exec(meta);
    const confidenceMatch = /confidence\s+([0-9.]+)/iu.exec(meta);
    out.push({
      evidenceId: idMatch?.[2] ?? `okf:${componentId}:${out.length + 1}`,
      componentId,
      sourceVersionId: sourceMatch?.[1] ?? "",
      quote: match[1].trim(),
      note: "OKF citation",
      confidence: confidenceMatch ? Number(confidenceMatch[1]) : null,
      okfPath,
    });
  }
  return out;
}

function yamlScalar(frontmatter: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^(?:${escaped}|\\s+${escaped}):\\s*(.+?)\\s*$`, "mu").exec(frontmatter);
  if (!match) return "";
  const raw = match[1].trim();
  try {
    return String(JSON.parse(raw));
  } catch {
    return raw.replace(/^["']|["']$/gu, "");
  }
}

function numberScalar(frontmatter: string, key: string): number | null {
  const value = yamlScalar(frontmatter, key);
  return value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
}

function statusScalar(value: string): TrustScore["status"] {
  return value === "trusted" || value === "usable_with_risk" || value === "needs_review" || value === "blocked" ? value : "needs_review";
}

function okfKind(frontmatter: string, artifactId: string): string {
  const tags = yamlScalar(frontmatter, "tags");
  for (const kind of ["wiki_page", "table_wiki_page"]) {
    if (tags.includes(kind)) return kind;
  }
  if (artifactId.startsWith("wiki/tables/")) return "table_wiki_page";
  return "wiki_page";
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

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}
