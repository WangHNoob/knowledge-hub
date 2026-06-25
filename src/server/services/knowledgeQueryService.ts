import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import { nanoid } from "nanoid";
import xlsx from "xlsx";

import type { AssetComponent, AssetPackage, DatabaseHandle, KnowledgeEnvelope, ReleaseRecord, TrustScore } from "../types";
import { jsonArray, mapComponent, mapPackage } from "../db/mappers";
import type { DiagnosticLogger } from "./diagnosticService";
import { createFeedbackService, type FeedbackService, type FeedbackType } from "./feedbackService";
import { createReleaseService } from "./releaseService";
import { createSourceBundleService } from "./sourceBundleService";
import { searchOkfIndex, type OkfSearchIndex, type OkfSearchResultItem } from "./okf/searchIndex";
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

type TableSchemaEntry = { component: KnowledgeAssetRef; schema: TableSchema; sourceVersionIds?: string[] };

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

interface OkfTableAliasEntry {
  table?: string;
  canonical?: string;
  canonicalName?: string;
  aliases?: string[];
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
        return this.kbSearch(release, stringArg(payload, "query", "q"), numberArg(payload, 10, "limit", "topK", "top_k"));
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
        return this.kbListTables(release, optionalString(payload, "query", "q", "group"), numberArg(payload, 50, "limit", "topK", "top_k"));
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
      case "kb_report_gap":
        return this.kbReportFeedback(release, "kb_report_gap", payload, "knowledge_gap");
      case "kb_report_bad_hit":
        return this.kbReportFeedback(release, "kb_report_bad_hit", payload, "bad_hit");
      case "kb_report_stale":
        return this.kbReportFeedback(release, "kb_report_stale", payload, "stale_knowledge");
      default:
        throw new Error(`Unknown Knowledge MCP tool: ${toolName}`);
    }
  }

  private async kbSearch(release: ReleaseRecord, query: string, limit = 10): Promise<ToolResult> {
    const boundedLimit = boundedLimitArg(limit, 10, 50);
    const indexItems = await this.kbSearchIndex(release, query, boundedLimit);
    if (indexItems.length > 0) {
      return {
        result: await this.searchResultPayload(release, query, indexItems),
        componentIds: indexItems.map((item) => item.componentId),
        artifactIds: indexItems.map((item) => item.artifactId),
      };
    }
    return this.kbSearchMarkdownFallback(release, query, boundedLimit);
  }

  private async kbSearchIndex(release: ReleaseRecord, query: string, limit: number): Promise<OkfSearchResultItem[]> {
    const index = this.readOkfSearchIndex(release);
    if (!index) return [];
    return this.alignSearchItemsWithPageTables(release, searchOkfIndex(index, query, limit));
  }

  private async kbSearchMarkdownFallback(release: ReleaseRecord, query: string, limit: number): Promise<ToolResult> {
    const needle = query.toLowerCase();
    const pages = this.readOkfPages(release);
    const items: OkfSearchResultItem[] = [];
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
        matchedTerms: query.toLowerCase().split(/\s+/u).filter(Boolean),
        matchedFields: ["body"],
        why: ["兼容模式：Markdown 正文关键词命中"],
        tableDependencies: [],
      });
    }
    items.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    const limited = await this.alignSearchItemsWithPageTables(release, items.slice(0, limit));
    return {
      result: await this.searchResultPayload(release, query, limited),
      componentIds: limited.map((item) => item.componentId),
      artifactIds: limited.map((item) => item.artifactId),
    };
  }

  private async searchResultPayload(release: ReleaseRecord, query: string, items: OkfSearchResultItem[]): Promise<Record<string, unknown>> {
    const evidenceCounts = await this.evidenceCountsForComponents(release, items.map((item) => item.componentId));
    return {
      query,
      total: items.length,
      items,
      cards: items.map((item, index) => searchCard(item, index, evidenceCounts.get(item.componentId) ?? 0)),
      guidance: searchGuidance(query, items, evidenceCounts),
    };
  }

  private async kbResolveTopic(release: ReleaseRecord, topic: string): Promise<ToolResult> {
    const search = await this.kbSearch(release, topic);
    const items = ((search.result as { items?: unknown[] }).items ?? []) as Array<Record<string, unknown>>;
    const table = await this.findTableSchema(release, topic);
    const entity = this.findGraphNodeSafe(release, topic);
    const page = items[0] ?? null;
    const targets = [
      ...(table ? [{
        type: "table",
        id: table.schema.table_name,
        title: table.schema.table_name,
        componentId: table.component.componentId,
        suggestedTools: ["kb_get_table_schema", "kb_query_table", "kb_validate_table"],
        why: [`表名/别名解析到 ${table.schema.table_name}`],
      }] : []),
      ...(entity ? [{
        type: "entity",
        id: entity.node.id,
        title: entity.node.label,
        componentId: entity.componentId,
        suggestedTools: ["kb_get_entity", "kb_get_neighbors", "kb_get_relations"],
        why: [`图谱实体命中 ${entity.node.label}`],
      }] : []),
      ...items.slice(0, 5).map((item) => ({
        type: "page",
        id: String(item.componentId ?? ""),
        title: String(item.title ?? ""),
        componentId: String(item.componentId ?? ""),
        okfPath: String(item.okfPath ?? ""),
        suggestedTools: pageSuggestedTools(item),
        why: Array.isArray(item.why) ? item.why : [],
        trust: item.trust ?? null,
      })),
    ];
    const resolved = targets[0] ?? page;
    return {
      result: {
        topic,
        resolved,
        resolvedType: targets[0]?.type ?? (page ? "page" : "none"),
        targets,
        suggestedTools: uniqueSorted(targets.flatMap((target) => target.suggestedTools)),
        nextStep: targets[0] ? nextStepForTarget(targets[0]) : "kb_search returned no target; add aliases or source material, then rebuild and publish.",
      },
      componentIds: uniqueSorted([...search.componentIds, ...targets.map((target) => String(target.componentId ?? ""))]),
      artifactIds: search.artifactIds,
    };
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
    const foundPage = pageResult.componentIds.length > 0;
    const schemas = await this.tableSchemas(release);
    const pageInfo = pageResult.result as Record<string, unknown>;
    const resolved = foundPage
      ? await this.resolvePageTables(release, {
        pageTitle: String(pageInfo.title ?? page),
        artifactId: String(pageInfo.artifactId ?? ""),
        markdown: String(pageInfo.markdown ?? ""),
        schemas,
      })
      : { tables: [], unresolved: [], source: "not_found" as const };
    return {
      result: {
        page,
        found: foundPage,
        source: resolved.source,
        tables: resolved.tables.map(({ schema, component }) => ({
          table: schema.table_name,
          componentId: component.componentId,
          fields: schema.fields,
          rowCount: schema.row_count,
          trust: component.trust ?? null,
        })),
        unresolvedDependencies: resolved.unresolved,
        unresolvedDependencyHints: resolved.unresolved.map(dependencyHint),
      },
      componentIds: uniqueSorted([...pageResult.componentIds, ...resolved.tables.map((table) => table.component.componentId)]),
    };
  }

  private async alignSearchItemsWithPageTables(release: ReleaseRecord, items: OkfSearchResultItem[]): Promise<OkfSearchResultItem[]> {
    if (items.length === 0) return items;
    const schemas = await this.tableSchemas(release);
    const pagesByComponent = new Map(this.readOkfPages(release).map((page) => [page.componentId, page] as const));
    const aligned: OkfSearchResultItem[] = [];
    for (const item of items) {
      const page = pagesByComponent.get(item.componentId);
      if (!page) {
        aligned.push(item);
        continue;
      }
      const resolved = await this.resolvePageTables(release, {
        pageTitle: page.title,
        artifactId: page.artifactId,
        markdown: page.markdown,
        schemas,
      });
      const tableDependencies = resolved.tables.map(({ schema }) => schema.table_name);
      const matchedFields = tableDependencies.length > 0 ? item.matchedFields : item.matchedFields.filter((field) => field !== "tables");
      const whyBase = tableDependencies.length > 0
        ? item.why
        : item.why.filter((line) => !line.startsWith("tables 命中") && !line.startsWith("配置表意图命中结构化表依赖"));
      aligned.push({
        ...item,
        matchedFields,
        tableDependencies,
        why: resolved.unresolved.length
          ? uniqueOrdered([...whyBase, `未解析为具体表：${resolved.unresolved.slice(0, 5).join(", ")}`]).slice(0, 9)
          : whyBase,
      });
    }
    return aligned;
  }

  private async resolvePageTables(
    release: ReleaseRecord,
    input: {
      pageTitle: string;
      artifactId: string;
      markdown: string;
      schemas: TableSchemaEntry[];
    },
  ): Promise<{
    tables: TableSchemaEntry[];
    unresolved: string[];
    source: "explicit_dependencies" | "graph" | "not_found";
  }> {
    const schemasByName = new Map(input.schemas.map((entry) => [aliasKey(entry.schema.table_name), entry] as const));
    const aliases = this.actionableTableAliases(release, schemasByName);
    const explicit = extractDependencyText(input.markdown);
    const explicitLines = dependencyLines(explicit.text);
    const candidates = dependencyCandidates(explicit.text);
    const explicitTables = candidates.flatMap((candidate) => resolveCandidateTables(candidate, schemasByName, aliases));
    const unresolved = uniqueSorted(explicitLines.filter((candidate) =>
      looksLikeDependencyToken(candidate) &&
      dependencyCandidates(candidate).every((part) => resolveCandidateTables(part, schemasByName, aliases).length === 0)
    ));
    if (explicit.hasDependencySection) {
      return {
        tables: uniqueTableEntries(explicitTables),
        unresolved,
        source: "explicit_dependencies",
      };
    }

    const graphTables = await this.pageConfiguredTables(release, input.pageTitle, input.artifactId);
    const tables = [...graphTables].flatMap((table) => resolveCandidateTables(table, schemasByName, aliases));
    return {
      tables: uniqueTableEntries(tables),
      unresolved: [],
      source: tables.length ? "graph" : "not_found",
    };
  }

  private actionableTableAliases(
    release: ReleaseRecord,
    schemasByName: Map<string, TableSchemaEntry>,
  ): Map<string, TableSchemaEntry[]> {
    const aliases = new Map<string, TableSchemaEntry[]>();
    for (const row of this.readOkfTableAliases(release)) {
      const table = row.table ?? row.canonical ?? row.canonicalName ?? "";
      const schema = schemasByName.get(aliasKey(table));
      if (!schema) continue;
      for (const value of uniqueSorted([table, ...(row.aliases ?? [])])) {
        const key = aliasKey(value);
        if (!key) continue;
        aliases.set(key, uniqueTableEntries([...(aliases.get(key) ?? []), schema]));
      }
    }
    return aliases;
  }

  private async pageConfiguredTables(release: ReleaseRecord, pageTitle: string, artifactId?: string): Promise<Set<string>> {
    try {
      const graph = await this.graph(release);
      const artifactWithoutWiki = artifactId?.replace(/^wiki\//u, "");
      const pageNode = graph.nodes.find((node) =>
        same(node.label, pageTitle) ||
        same(node.id, pageTitle) ||
        same(node.wiki_page, artifactId) ||
        same(node.wiki_page, artifactWithoutWiki)
      );
      const sourceIds = new Set([pageTitle, artifactId, artifactWithoutWiki, pageNode?.id].filter((value): value is string => Boolean(value)));
      return new Set(graph.edges
        .filter((edge) => sourceIds.has(edge.source) && edge.relation === "configured_in")
        .flatMap((edge) => [edge.target, edge.target.replace(/^table:/u, "")]));
    } catch {
      return new Set();
    }
  }

  private findGraphNodeSafe(release: ReleaseRecord, entityId: string): { componentId: string; node: GraphNode } | null {
    try {
      const graph = this.readOkfGraph(release);
      if (!graph) return null;
      const node = (graph.nodes ?? []).find((item) => same(item.id, entityId) || same(item.label, entityId));
      return node ? { componentId: graph.componentId, node } : null;
    } catch {
      return null;
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

  private async kbListTables(release: ReleaseRecord, query?: string, limit = 50): Promise<ToolResult> {
    const schemas = await this.tableSchemas(release);
    const normalizedQuery = query ? aliasKey(query) : "";
    const schemasByName = new Map(schemas.map((entry) => [aliasKey(entry.schema.table_name), entry] as const));
    const aliases = normalizedQuery ? this.actionableTableAliases(release, schemasByName) : new Map<string, TableSchemaEntry[]>();
    const matched = schemas
      .filter(({ schema }) =>
        !normalizedQuery ||
        [schema.table_name, schema.rel_path, ...(schema.fields ?? [])].some((value) => aliasKey(String(value)).includes(normalizedQuery)) ||
        [...aliases.entries()].some(([alias, entries]) =>
          entries.some((entry) => entry.schema.table_name === schema.table_name) &&
          (alias.includes(normalizedQuery) || normalizedQuery.includes(alias))
        )
      )
      .sort((a, b) => a.schema.table_name.localeCompare(b.schema.table_name));
    const rows = matched.slice(0, boundedLimitArg(limit, 50, 200));
    return {
      result: {
        query: query ?? null,
        totalMatched: matched.length,
        tables: rows.map(({ schema, component }) => ({
          table: schema.table_name,
          componentId: component.componentId,
          relPath: schema.rel_path,
          fields: schema.fields,
          rowCount: schema.row_count,
          trust: component.trust ?? null,
        })),
      },
      componentIds: rows.map(({ component }) => component.componentId),
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

  private async kbReportFeedback(release: ReleaseRecord, toolName: string, payload: Record<string, unknown>, feedbackType: FeedbackType): Promise<ToolResult> {
    const hitComponentIds = await this.feedbackComponentIds(release, payload);
    const result = await this.feedback.recordExplicitFeedback({
      release,
      toolName,
      payload,
      feedbackType,
      hitComponentIds,
      qualityFlags: feedbackType === "knowledge_gap" ? [] : [`agent_reported:${feedbackType}`],
    });
    return {
      result: {
        ...result,
        message: result.recorded
          ? "Feedback recorded and routed to review center."
          : "Feedback accepted but no target component/package was available for review routing.",
        nextStep: result.recorded
          ? "Review center can now triage this Agent feedback; rebuild and republish after fixing."
          : "Publish at least one package before routing Agent feedback into review tasks.",
      },
      componentIds: hitComponentIds,
      forceHit: true,
    };
  }

  private async feedbackComponentIds(release: ReleaseRecord, payload: Record<string, unknown>): Promise<string[]> {
    const direct = [
      optionalString(payload, "componentId"),
      ...jsonArray(payload.componentIds).map(String),
    ].filter((value): value is string => Boolean(value));
    if (direct.length > 0) return uniqueSorted(direct);
    const page = optionalString(payload, "page", "title");
    if (page) {
      const pageResult = await this.kbGetPage(release, page);
      if (pageResult.componentIds.length > 0) return pageResult.componentIds;
    }
    const query = optionalString(payload, "query", "q", "topic");
    if (query) {
      const search = await this.kbSearch(release, query, 3);
      return search.componentIds.slice(0, 3);
    }
    return [];
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

  private readOkfTableAliases(release: ReleaseRecord): OkfTableAliasEntry[] {
    const manifest = this.readOkfJsonAsset<{ aliases?: OkfTableAliasEntry[] }>(release, "tableAliasesUri", "tables/aliases.json");
    return Array.isArray(manifest?.aliases) ? manifest.aliases : [];
  }

  private readOkfSearchIndex(release: ReleaseRecord): OkfSearchIndex | null {
    const index = this.readOkfJsonAsset<OkfSearchIndex>(release, "searchIndexUri", "search/index.json");
    return index?.okfAssetType === "search_index" && Array.isArray(index.pages) ? index : null;
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
    const canonical = this.resolveTableAlias(release, table) ?? table;
    return schemas.find(({ schema, component }) =>
      same(schema.table_name, canonical) || same(component.title, canonical) || same(component.artifactId, canonical)
    ) ?? null;
  }

  private resolveTableAlias(release: ReleaseRecord, value: string): string | null {
    const normalized = aliasKey(value);
    for (const row of this.readOkfTableAliases(release)) {
      const table = row.table ?? row.canonical ?? row.canonicalName ?? "";
      if (!table) continue;
      if (aliasKey(table) === normalized) return table;
      if ((row.aliases ?? []).some((alias) => aliasKey(alias) === normalized)) return table;
    }
    return null;
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

  private async evidenceCountsForComponents(release: ReleaseRecord, componentIds: string[]): Promise<Map<string, number>> {
    const idsByComponent = new Map<string, Set<string>>();
    if (componentIds.length === 0) return new Map();
    for (const record of this.okfEvidenceRecordsForComponents(release, componentIds)) {
      const bucket = idsByComponent.get(record.componentId) ?? new Set<string>();
      bucket.add(record.evidenceId);
      idsByComponent.set(record.componentId, bucket);
    }
    for (const record of await this.evidenceRecordsForComponents(componentIds)) {
      const componentId = String(record.component_id ?? "");
      if (!componentId) continue;
      const bucket = idsByComponent.get(componentId) ?? new Set<string>();
      bucket.add(String(record.evidence_id ?? `${componentId}:${bucket.size + 1}`));
      idsByComponent.set(componentId, bucket);
    }
    return new Map([...idsByComponent.entries()].map(([componentId, ids]) => [componentId, ids.size] as const));
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

function numberArg(payload: Record<string, unknown>, fallback: number, ...keys: string[]): number {
  for (const key of keys) {
    const value = payload[key];
    const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
    if (Number.isFinite(numeric)) return numeric;
  }
  return fallback;
}

function boundedLimitArg(value: number, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.min(Math.floor(value), max));
}

function objectArg(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function searchCard(item: OkfSearchResultItem, index: number, evidenceCount: number): Record<string, unknown> {
  const unresolvedDependencies = unresolvedFromWhy(item.why);
  return {
    rank: index + 1,
    title: item.title,
    componentId: item.componentId,
    okfPath: item.okfPath,
    artifactId: item.artifactId,
    kind: item.kind,
    type: item.type,
    snippet: item.snippet,
    score: item.score,
    trust: item.trust,
    evidence: {
      count: evidenceCount,
      traceable: evidenceCount > 0,
      suggestedTool: "kb_get_evidence",
    },
    tableDependencies: item.tableDependencies,
    unresolvedDependencies,
    qualitySignals: {
      matchedFields: item.matchedFields,
      matchedTerms: item.matchedTerms.slice(0, 12),
      why: item.why,
    },
    suggestedNextTools: pageSuggestedTools(item),
    nextStep: nextStepForSearchItem(item, evidenceCount, unresolvedDependencies),
  };
}

function searchGuidance(query: string, items: OkfSearchResultItem[], evidenceCounts: Map<string, number>): Record<string, unknown> {
  const top = items[0];
  if (!top) {
    return {
      status: "miss",
      nextStep: `No published knowledge matched "${query}". Report a knowledge gap or import/build source material, then publish again.`,
      suggestedNextTools: ["kb_resolve_topic"],
    };
  }
  return {
    status: "hit",
    topComponentId: top.componentId,
    nextStep: nextStepForSearchItem(top, evidenceCounts.get(top.componentId) ?? 0, unresolvedFromWhy(top.why)),
    suggestedNextTools: pageSuggestedTools(top),
  };
}

function unresolvedFromWhy(why: string[]): string[] {
  const prefix = "未解析为具体表：";
  const line = why.find((item) => item.startsWith(prefix));
  return line ? line.slice(prefix.length).split(/,\s*/u).map((item) => item.trim()).filter(Boolean) : [];
}

function nextStepForSearchItem(item: OkfSearchResultItem, evidenceCount: number, unresolvedDependencies: string[]): string {
  if (unresolvedDependencies.length > 0) return "Call kb_get_page_tables to inspect resolved and unresolved table dependencies before using table data.";
  if (item.tableDependencies.length > 0) return "Call kb_get_page_tables, then kb_get_table_schema or kb_query_table for structured values.";
  if (evidenceCount === 0) return "Call kb_get_evidence; if no records return, treat the answer as lower-traceability and report a gap.";
  return "Call kb_get_page for full context, and kb_get_evidence when citing this knowledge.";
}

function pageSuggestedTools(item: { matchedFields?: unknown; tableDependencies?: unknown }): string[] {
  const fields = Array.isArray(item.matchedFields) ? item.matchedFields.map(String) : [];
  const tools = ["kb_get_page", "kb_get_evidence", "kb_get_quality"];
  if (fields.includes("tables") || fields.includes("dataDependencies") || (Array.isArray(item.tableDependencies) && item.tableDependencies.length > 0)) {
    tools.push("kb_get_page_tables");
  }
  return tools;
}

function nextStepForTarget(target: { type?: unknown; title?: unknown; id?: unknown }): string {
  const title = String(target.title ?? target.id ?? "");
  if (target.type === "table") return `Use kb_get_table_schema for ${title}, then kb_query_table if row data is needed.`;
  if (target.type === "entity") return `Use kb_get_entity for ${title}, then kb_get_neighbors to inspect related pages and tables.`;
  if (target.type === "page") return `Use kb_get_page for ${title}; call kb_get_page_tables when tableDependencies are present.`;
  return "Use kb_search with a more specific topic.";
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\\/gu, "/").replace(/\s+/gu, " ").trim();
}

function aliasKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/[\s_\-()[\]（）【】{}《》:：,，.。/\\]+/gu, "");
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

function extractDependencyText(markdown: string): { text: string; hasDependencySection: boolean } {
  const sections = parseMarkdownSections(markdown);
  const dependencySections = sections.filter((section) => dependencyHeading(section.heading));
  return {
    text: dependencySections.map((section) => section.content).join("\n"),
    hasDependencySection: dependencySections.length > 0,
  };
}

function parseMarkdownSections(markdown: string): Array<{ heading: string; content: string }> {
  const lines = markdown.split(/\r?\n/u);
  const out: Array<{ heading: string; content: string }> = [];
  let current: { heading: string; lines: string[] } | null = null;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) {
      if (current) out.push({ heading: current.heading, content: current.lines.join("\n").trim() });
      current = { heading: heading[2].trim(), lines: [] };
      continue;
    }
    current?.lines.push(line);
  }
  if (current) out.push({ heading: current.heading, content: current.lines.join("\n").trim() });
  return out;
}

function dependencyHeading(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "data dependencies" || ["配置表依赖", "关联配置表", "数据依赖", "表依赖"].includes(normalized);
}

function dependencyCandidates(text: string): string[] {
  const out = new Set<string>();
  for (const cleanedLine of dependencyLines(text)) {
    out.add(cleanedLine);
    for (const match of cleanedLine.matchAll(/[A-Za-z][A-Za-z0-9_/-]*/gu)) out.add(match[0]);
    for (const match of cleanedLine.matchAll(/[\p{Script=Han}]{2,}/gu)) out.add(match[0]);
    for (const match of cleanedLine.matchAll(/[（(]([A-Za-z][A-Za-z0-9_/-]*)[）)]/gu)) out.add(match[1]);
  }
  return uniqueSorted([...out]);
}

function dependencyLines(text: string): string[] {
  if (!text.trim()) return [];
  const out: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    let cleanedLine = line.replace(/\|/gu, " ").trim();
    while (/^(?:[-*+]|\d+[.)、])\s+/u.test(cleanedLine)) {
      cleanedLine = cleanedLine.replace(/^(?:[-*+]|\d+[.)、])\s+/u, "").trim();
    }
    if (!cleanedLine || /^无[。.]?$/u.test(cleanedLine)) continue;
    if (/^\d+\s*[-~–—]\s*\d+.*[:：]/u.test(cleanedLine)) continue;
    out.push(cleanedLine);
  }
  return uniqueSorted(out);
}

function resolveCandidateTables(candidate: string, schemasByName: Map<string, TableSchemaEntry>, aliases: Map<string, TableSchemaEntry[]>): TableSchemaEntry[] {
  const key = aliasKey(candidate);
  if (!key) return [];
  const exact = schemasByName.get(key);
  if (exact) return [exact];
  const aliased = aliases.get(key);
  if (aliased?.length) return aliased;
  const containedSchemas = [...schemasByName.entries()]
    .filter(([tableKey]) => tableKey.length >= 4 && key.includes(tableKey))
    .map(([, entry]) => entry);
  if (containedSchemas.length) return uniqueTableEntries(containedSchemas);
  const containedAliases = [...aliases.entries()]
    .filter(([alias]) => alias.length >= 4 && key.includes(alias))
    .flatMap(([, entries]) => entries);
  return uniqueTableEntries(containedAliases);
}

function looksLikeDependencyToken(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /^无[。.]?$/u.test(trimmed)) return false;
  if (trimmed.length > 80) return false;
  return /[A-Za-z\p{Script=Han}]/u.test(trimmed);
}

function dependencyHint(dependency: string): { dependency: string; kind: string; suggestedAction: string } {
  const key = aliasKey(dependency);
  if (key.includes("config") || key.includes("配置")) {
    return {
      dependency,
      kind: "generic_config",
      suggestedAction: "补充具体配置表名或维护别名映射后重新构建发布。",
    };
  }
  if (key.includes("fight") || key.includes("战斗")) {
    return {
      dependency,
      kind: "runtime_or_domain_data",
      suggestedAction: "确认这是运行时数据、图谱实体还是具体表；如需查表请补具体 schema 名。",
    };
  }
  if (key.includes("task") || key.includes("任务")) {
    return {
      dependency,
      kind: "generic_task",
      suggestedAction: "补充具体任务配置表名或维护任务类表别名。",
    };
  }
  if (/^[a-z][a-z0-9_/.-]*$/iu.test(dependency.trim())) {
    return {
      dependency,
      kind: "missing_schema_or_alias",
      suggestedAction: "该名称未解析到当前发布的表 schema；检查表是否进入 OKF bundle 或补充别名。",
    };
  }
  return {
    dependency,
    kind: "concept_dependency",
    suggestedAction: "作为概念依赖使用；需要 Agent 查表时应补充具体表名。",
  };
}

function uniqueTableEntries(values: TableSchemaEntry[]): TableSchemaEntry[] {
  const seen = new Set<string>();
  const out: TableSchemaEntry[] = [];
  for (const value of values) {
    if (seen.has(value.schema.table_name)) continue;
    seen.add(value.schema.table_name);
    out.push(value);
  }
  return out.sort((a, b) => a.schema.table_name.localeCompare(b.schema.table_name));
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

function uniqueOrdered(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
