import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import { nanoid } from "nanoid";
import xlsx from "xlsx";

import type { AssetComponent, AssetPackage, DatabaseHandle, KnowledgeEnvelope, KnowledgeEnvelopeTrustScore, KnowledgeTrace, ReleaseRecord, TrustScore } from "../types";
import { jsonArray, jsonObject, mapComponent, mapPackage } from "../db/mappers";
import { createAttributionAuditService } from "./attributionAuditService";
import type { DiagnosticLogger } from "./diagnosticService";
import { createFeedbackService, type FeedbackService, type FeedbackType } from "./feedbackService";
import { AutoPublishEligibilityError, createReleaseService, type AutoPublishCheck } from "./releaseService";
import { createKbBuilderPipelineService } from "./kbBuilderService";
import { createLintRemediationService } from "./lintRemediationService";
import { createGovernanceProfileService, type GovernanceProfileService } from "./governanceProfileService";
import { emitKnowledgeEvent } from "./eventService";
import { createSourceBundleService } from "./sourceBundleService";
import { createProjectService } from "./projectService";
import { createKnowledgeService } from "./knowledgeService";
import { createFlywheelService, type FlywheelService } from "./flywheelService";
import { searchOkfIndex, tokenizeSearchText, type OkfSearchIndex, type OkfSearchResultItem } from "./okf/searchIndex";
import { scoreFromQuality, trustFromQuality } from "./trustScore";

const EVIDENCE_REQUIRED_COMPONENT_KINDS = new Set(["wiki_page"]);
const GRAPH_TOOLS = new Set(["kb_get_entity", "kb_get_neighbors", "kb_list_entities", "kb_get_relations"]);
const TABLE_TOOLS = new Set(["kb_get_page_tables", "kb_list_tables", "kb_get_table_schema", "kb_query_table", "kb_get_table_raw", "kb_validate_table", "kb_check_table_value"]);
const REPORT_TOOLS = new Set(["kb_report_gap", "kb_report_bad_hit", "kb_report_stale"]);
const GOVERNANCE_TOOLS = new Set([
  "kb_list_projects",
  "kb_get_flywheel_status",
  "kb_run_health_check",
  "kb_submit_correction",
  "kb_apply_correction",
  "kb_start_incremental_check",
  "kb_publish_if_ready",
  "kb_get_correction_status",
  "kb_govern_flywheel",
  "kb_submit_attribution",
  "kb_list_feedback_clusters",
]);
const MCP_ENVELOPE_DETAIL_LIMIT = 20;

export interface KnowledgeQueryContext {
  sessionId?: string;
  agentRole?: string;
  traceId?: string;
  projectId?: string;
}

interface ToolResult {
  result: unknown;
  componentIds: string[];
  artifactIds?: string[];
  sourceVersionIds?: string[];
  evidenceIds?: string[];
  qualityFlags?: string[];
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

interface TableFieldMapping {
  rawKey: string;
  columnIndex: number;
  headerValue: string;
  matchMethod: "header" | "schema_order";
}

interface TableMappedRow extends Record<string, unknown> {
  row: Record<string, unknown>;
  rawRow: Record<string, unknown>;
  fieldMap: Record<string, TableFieldMapping>;
}

interface TableReadResult {
  sheet: string;
  rows: TableMappedRow[];
  fieldMap: Record<string, TableFieldMapping>;
  mappedFields: string[];
  missingFields: string[];
  unmappedRawColumns: string[];
  headerRowGuess: number;
  dataStartRow: number;
  rowCount: { schema: number; data: number };
  diagnostics: string[];
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
  description: string;
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

interface SourceCorrectionView {
  correctionId: string;
  projectId: string;
  bundleId: string;
  sourcePath: string;
  ruleId: string;
  pageType: string;
  factKey: string | null;
  boundSourceHash: string;
  state: string;
  correctValue: Record<string, unknown>;
  componentId: string | null;
  packageId: string | null;
  exampleId: string;
  taskId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

type CorrectionAnchorMatchMethod = "componentId" | "knowledgePath" | "sourcePath_unique" | "component_fallback";

interface CorrectionAnchorExplanation {
  componentId: string;
  sourcePath: string;
  matchMethod: CorrectionAnchorMatchMethod;
  candidates: Array<Record<string, unknown>>;
  confidence: "high" | "medium" | "low";
}

interface CorrectionTarget {
  component: AssetComponent;
  sourcePath: string;
  anchor: CorrectionAnchorExplanation;
}

interface SearchMatchClassification {
  status: "hit" | "near_miss" | "low_confidence_hit";
  qualityFlags: string[];
  coreTerms: string[];
  matchedCoreTerms: string[];
  missingCoreTerms: string[];
}

interface PublishTarget {
  runId: string;
  packageId: string;
  only: string;
  componentIds: string[];
}

interface HealthComponentSummary {
  componentId: string;
  artifactId: string;
  title: string;
  kind: string;
  score: number | null;
  status: string;
  lastTrustedAuditAt: string | null;
}

interface HealthCorrectionSummary {
  correctionId: string;
  state: string;
  componentId: string;
  packageId: string;
  sourcePath: string;
  ruleId: string;
  factKey: string | null;
  updatedAt: string;
}

export function createKnowledgeQueryService(db: DatabaseHandle, dataDir: string, diagnostics?: DiagnosticLogger, governanceProfileService?: GovernanceProfileService) {
  return new KnowledgeQueryService(db, dataDir, diagnostics, governanceProfileService);
}

export class KnowledgeQueryService {
  private readonly adapter;
  private readonly releaseService;
  private readonly sourceService;
  private readonly feedback: FeedbackService;
  private readonly builderService;
  private readonly lintRemediationService;
  private readonly governanceProfileService;
  private readonly attributionAuditService;
  private flywheelService: FlywheelService | null = null;

  constructor(
    private readonly db: DatabaseHandle,
    private readonly dataDir: string,
    private readonly diagnostics?: DiagnosticLogger,
    governanceProfileService?: GovernanceProfileService,
  ) {
    this.adapter = db.adapter;
    this.governanceProfileService = governanceProfileService ?? createGovernanceProfileService(db);
    this.releaseService = createReleaseService(db, dataDir, diagnostics, this.governanceProfileService);
    this.sourceService = createSourceBundleService(db, dataDir);
    this.feedback = createFeedbackService(db);
    this.builderService = createKbBuilderPipelineService(db, dataDir, diagnostics);
    this.lintRemediationService = createLintRemediationService(db);
    this.attributionAuditService = createAttributionAuditService(db);
  }

  private flywheel(): FlywheelService {
    if (this.flywheelService) return this.flywheelService;
    this.flywheelService = createFlywheelService({
      db: this.db,
      knowledgeService: createKnowledgeService(this.db),
      bundleService: this.sourceService,
      kbBuilderService: this.builderService,
      releaseService: this.releaseService,
      projectService: createProjectService(this.db),
      lintRemediationService: this.lintRemediationService,
      governanceProfileService: this.governanceProfileService,
      diagnostics: this.diagnostics,
    });
    return this.flywheelService;
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
    const projectId = optionalString(payload, "projectId") || context.projectId || "default_project";
    if (GOVERNANCE_TOOLS.has(toolName)) {
      return this.runGovernanceTool(toolName, payload, context, projectId, started, span);
    }
    const release = await this.releaseService.getCurrent(projectId);
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
      qualityFlags = uniqueSorted([
        ...(toolResult.qualityFlags ?? []),
        ...await this.qualityFlagsForComponents(hitComponentIds, dbEvidenceRecords, new Set(okfEvidenceRecords.map((record) => record.componentId)), new Map(trust.components.map((component) => [component.componentId, component.trust] as const))),
      ]);
      status = toolResult.forceHit || hitComponentIds.length > 0 ? "hit" : "miss";

      const envelope: KnowledgeEnvelope<any> = {
        contract: envelopeContract(toolName, evidenceIds),
        release: releaseEnvelope(release),
        result: toolResult.result,
        qualityFlags,
        trust: slimTrustEnvelope(trust),
        trace: {
          releaseId: release.releaseId,
          ...slimTraceArrays({
            componentIds: hitComponentIds,
            artifactIds: toolResult.artifactIds ?? await this.artifactIdsForComponents(hitComponentIds),
            sourceVersionIds: uniqueSorted([...(toolResult.sourceVersionIds ?? []), ...releaseSourceVersionIds(release)]),
            evidenceIds,
          }),
        },
      };

      await this.writeAudit({
        context,
        projectId,
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
        projectId,
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

  private async runGovernanceTool(
    toolName: string,
    payload: Record<string, unknown>,
    context: KnowledgeQueryContext,
    projectId: string,
    started: number,
    span: ReturnType<NonNullable<DiagnosticLogger["startSpan"]>> | undefined,
  ): Promise<KnowledgeEnvelope<any>> {
    const release = await this.releaseService.getCurrent(projectId);
    let status: "hit" | "miss" | "error" = "error";
    let hitComponentIds: string[] = [];
    try {
      const toolResult = await this.executeGovernanceTool(projectId, toolName, payload, context);
      hitComponentIds = uniqueSorted(toolResult.componentIds);
      status = toolResult.forceHit || hitComponentIds.length > 0 ? "hit" : "miss";
      const envelope = await this.governanceEnvelope(toolName, release, toolResult.result, hitComponentIds, toolResult.artifactIds ?? []);
      await this.writeAudit({
        context,
        projectId,
        toolName,
        releaseId: release?.releaseId ?? "",
        payload,
        hitComponentIds,
        qualityFlags: [],
        status,
        latencyMs: Date.now() - started,
      });
      await span?.complete({ releaseId: release?.releaseId ?? "", status, hitComponentIds, latencyMs: Date.now() - started });
      return envelope;
    } catch (error) {
      await this.writeAudit({
        context,
        projectId,
        toolName,
        releaseId: release?.releaseId ?? "",
        payload,
        hitComponentIds,
        qualityFlags: [],
        status: "error",
        latencyMs: Date.now() - started,
      });
      await span?.fail(error, { releaseId: release?.releaseId ?? "", hitComponentIds });
      throw error;
    }
  }

  private async executeGovernanceTool(projectId: string, toolName: string, payload: Record<string, unknown>, context: KnowledgeQueryContext): Promise<ToolResult> {
    switch (toolName) {
      case "kb_list_projects":
        return this.kbListProjects(projectId);
      case "kb_get_flywheel_status":
        return this.kbGetFlywheelStatus(projectId);
      case "kb_run_health_check":
        return this.kbRunHealthCheck(projectId, payload, context);
      case "kb_submit_correction":
        return this.kbSubmitCorrection(projectId, payload, context);
      case "kb_apply_correction":
        return this.kbApplyCorrection(projectId, stringArg(payload, "correctionId"), context, optionalString(payload, "note"));
      case "kb_start_incremental_check":
        return this.kbStartIncrementalCheck(projectId, payload, context);
      case "kb_publish_if_ready":
        return this.kbPublishIfReady(projectId, payload, context);
      case "kb_get_correction_status":
        return this.kbGetCorrectionStatus(projectId, stringArg(payload, "correctionId"));
      case "kb_govern_flywheel":
        return this.kbGovernFlywheel(projectId, payload, context);
      case "kb_submit_attribution":
        return this.kbSubmitAttribution(projectId, payload, context);
      case "kb_list_feedback_clusters":
        return this.kbListFeedbackClusters(projectId);
      default:
        throw new Error(`Unknown Knowledge MCP governance tool: ${toolName}`);
    }
  }

  private async executeTool(release: ReleaseRecord, toolName: string, payload: Record<string, unknown>): Promise<ToolResult> {
    switch (toolName) {
      case "kb_get_release":
        return { result: releaseSummary(release, booleanArg(payload, false, "includeManifest", "manifest"), numberArg(payload, 30, "manifestLimit", "limit")), componentIds: [], forceHit: true };
      case "kb_search":
        return this.kbSearch(release, stringArg(payload, "query", "q"), numberArg(payload, 10, "limit", "topK", "top_k"));
      case "kb_resolve_topic":
        return this.kbResolveTopic(release, stringArg(payload, "topic", "query", "q"));
      case "kb_get_page":
        return this.kbGetPage(release, stringArg(payload, "componentId", "page", "title", "topic"));
      case "kb_get_section":
        return this.kbGetSection(release, stringArg(payload, "componentId", "page", "title", "topic"), stringArg(payload, "section"));
      case "kb_list_pages":
        return this.kbListPages(release);
      case "kb_get_page_tables":
        return this.kbGetPageTables(release, stringArg(payload, "componentId", "page", "title", "topic"));
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
      case "kb_get_table_raw":
        return this.kbGetTableRaw(release, stringArg(payload, "table", "tableName", "name"), Number(payload.headerRows ?? 0));
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
      const match = classifySearchMatch(query, indexItems);
      return {
        result: await this.searchResultPayload(release, query, indexItems),
        componentIds: indexItems.map((item) => item.componentId),
        artifactIds: indexItems.map((item) => item.artifactId),
        qualityFlags: match.qualityFlags,
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
    const match = classifySearchMatch(query, limited);
    return {
      result: await this.searchResultPayload(release, query, limited),
      componentIds: limited.map((item) => item.componentId),
      artifactIds: limited.map((item) => item.artifactId),
      qualityFlags: match.qualityFlags,
    };
  }

  private async searchResultPayload(release: ReleaseRecord, query: string, items: OkfSearchResultItem[]): Promise<Record<string, unknown>> {
    const evidenceCounts = await this.evidenceCountsForComponents(release, items.map((item) => item.componentId));
    const match = classifySearchMatch(query, items);
    return {
      query,
      total: items.length,
      items,
      match,
      cards: items.map((item, index) => searchCard(item, index, evidenceCounts.get(item.componentId) ?? 0, match)),
      guidance: searchGuidance(query, items, evidenceCounts, match),
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
    const okfPage = await this.findOkfPage(release, page);
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
      const schemas = schemaEntriesForAliasTarget(table, schemasByName);
      if (schemas.length === 0) continue;
      for (const value of uniqueSorted([table, ...(row.aliases ?? [])])) {
        const key = aliasKey(value);
        if (!key) continue;
        aliases.set(key, uniqueTableEntries([...(aliases.get(key) ?? []), ...schemas]));
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
    const tableData = await this.readMappedTableRows(release, found.schema, found.sourceVersionIds);
    const filtered = tableData.rows.filter((row) => Object.entries(where).every(([key, value]) => String(row.row[key] ?? row[key] ?? "") === String(value)));
    return {
      result: {
        found: true,
        table: found.schema.table_name,
        rows: filtered.slice(0, Math.max(1, Math.min(limit || 20, 200))),
        totalRows: filtered.length,
        fieldMap: tableData.fieldMap,
        mappedFields: tableData.mappedFields,
        missingFields: tableData.missingFields,
        unmappedRawColumns: tableData.unmappedRawColumns,
        headerRowGuess: tableData.headerRowGuess,
        diagnostics: tableData.diagnostics,
        trust: found.component.trust ?? null,
      },
      componentIds: [found.component.componentId],
      artifactIds: [found.component.artifactId],
      sourceVersionIds: releaseSourceVersionIds(release),
    };
  }

  private async kbValidateTable(release: ReleaseRecord, table: string): Promise<ToolResult> {
    const found = await this.findTableSchema(release, table);
    if (!found) return { result: { valid: false, table, errors: ["table schema not found"] }, componentIds: [] };
    const tableData = await this.readMappedTableRows(release, found.schema, found.sourceVersionIds);
    return {
      result: {
        valid: tableData.missingFields.length === 0,
        table: found.schema.table_name,
        mappedFields: tableData.mappedFields,
        missingFields: tableData.missingFields,
        unmappedRawColumns: tableData.unmappedRawColumns,
        headerRowGuess: tableData.headerRowGuess,
        rowCount: tableData.rowCount,
        diagnostics: tableData.diagnostics,
        trust: found.component.trust ?? null,
      },
      componentIds: [found.component.componentId],
      artifactIds: [found.component.artifactId],
    };
  }

  private async kbCheckTableValue(release: ReleaseRecord, table: string, field: string, value: unknown): Promise<ToolResult> {
    const found = await this.findTableSchema(release, table);
    if (!found) return { result: { found: false, table, matches: [] }, componentIds: [] };
    const tableData = await this.readMappedTableRows(release, found.schema, found.sourceVersionIds);
    const matches = tableData.rows.filter((row) => String(row.row[field] ?? row[field] ?? "") === String(value));
    return {
      result: {
        found: true,
        table: found.schema.table_name,
        field,
        value,
        matches,
        fieldMap: tableData.fieldMap,
        mappedFields: tableData.mappedFields,
        missingFields: tableData.missingFields,
        diagnostics: tableData.diagnostics,
        trust: found.component.trust ?? null,
      },
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
    const okfPage = !component && page ? await this.findOkfPage(release, page) : null;
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

  private async findOkfPage(release: ReleaseRecord, page: string): Promise<OkfPage | null> {
    const normalized = normalize(page);
    const pages = this.readOkfPages(release);
    const exact = pages.find((item) => pageLookupKeys(item).some((key) => normalize(key) === normalized));
    if (exact) return exact;
    const search = await this.kbSearchIndex(release, page, 1);
    const hit = search[0];
    if (!hit) return null;
    if (hit.score < 1 || hit.why.some((line) => line.startsWith("缺少核心词"))) return null;
    return pages.find((item) => item.componentId === hit.componentId) ?? null;
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

  /**
   * 读取源表的**原始网格**（array-of-arrays），保留列顺序与空列——
   * 不同于 readTableRows 的对象模式（会丢列序/空列）。用于忠实重建配表格式。
   */
  private async readTableGrid(release: ReleaseRecord, schema: TableSchema, sourceVersionIds?: string[]): Promise<{ sheet: string; grid: unknown[][] }> {
    for (const versionId of (sourceVersionIds?.length ? sourceVersionIds : releaseSourceVersionIds(release))) {
      const file = await this.sourceService.readFile(versionId, schema.rel_path);
      if (!file) continue;
      const workbook = xlsx.read(file.content, { type: "buffer" });
      const sheetName = workbook.SheetNames[0];
      const grid = xlsx.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1, defval: "", blankrows: true });
      return { sheet: sheetName, grid };
    }
    throw new Error(`Source table file not found for ${schema.table_name}: ${schema.rel_path}`);
  }

  private async readMappedTableRows(release: ReleaseRecord, schema: TableSchema, sourceVersionIds?: string[]): Promise<TableReadResult> {
    const { sheet, grid } = await this.readTableGrid(release, schema, sourceVersionIds);
    const mapping = inferTableFieldMapping(schema, grid);
    const rows: TableMappedRow[] = [];
    for (const gridRow of grid.slice(mapping.dataStartIndex)) {
      if (!gridRow.some((value) => normalizeCellValue(value) !== "")) continue;
      const rawRow = rawRowFromGridRow(gridRow, mapping.rawKeys);
      const canonical: Record<string, unknown> = {};
      for (const [field, fieldMap] of Object.entries(mapping.fieldMap)) {
        canonical[field] = gridRow[fieldMap.columnIndex] ?? "";
      }
      rows.push({ ...canonical, row: canonical, rawRow, fieldMap: mapping.fieldMap });
    }
    return {
      sheet,
      rows,
      fieldMap: mapping.fieldMap,
      mappedFields: Object.keys(mapping.fieldMap),
      missingFields: (schema.fields ?? []).filter((field) => !(field in mapping.fieldMap)),
      unmappedRawColumns: mapping.unmappedRawColumns,
      headerRowGuess: mapping.headerRowIndex + 1,
      dataStartRow: mapping.dataStartIndex + 1,
      rowCount: { schema: schema.row_count ?? 0, data: rows.length },
      diagnostics: mapping.diagnostics,
    };
  }

  private async kbGetTableRaw(release: ReleaseRecord, table: string, headerRows: number): Promise<ToolResult> {
    const found = await this.findTableSchema(release, table);
    if (!found) return { result: { found: false, table }, componentIds: [] };
    const { sheet, grid } = await this.readTableGrid(release, found.schema, found.sourceVersionIds);
    const hdr = Math.max(0, Math.min(headerRows || 0, grid.length));
    return {
      result: {
        found: true,
        table: found.schema.table_name,
        relPath: found.schema.rel_path,
        sheet,
        totalRows: grid.length,
        ncols: grid.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0),
        headerRows: hdr,
        header: hdr > 0 ? grid.slice(0, hdr) : [],
        rows: grid,
        note: "原始网格(array-of-arrays)，保留列序与空列；第0行通常为列ID。headerRows 由调用方指定则拆分 header/数据，仅作提示，rows 始终为完整网格。",
        trust: found.component.trust ?? null,
      },
      componentIds: [found.component.componentId],
      artifactIds: [found.component.artifactId],
      sourceVersionIds: releaseSourceVersionIds(release),
    };
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

  private async kbListProjects(currentProjectId: string): Promise<ToolResult> {
    const projects = await createProjectService(this.db).listProjects();
    return {
      result: {
        currentProjectId,
        projects: projects.map((project) => ({
          projectId: project.projectId,
          name: project.name,
          description: project.description,
          status: project.status,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        })),
      },
      componentIds: [],
      forceHit: true,
    };
  }

  private async kbGetFlywheelStatus(projectId: string): Promise<ToolResult> {
    const [release, latestBuild, corrections, blockingTasks, pendingReviewTasks, negativeFeedback, lintSummary, latestFeedback, latestPublishSkip, governanceProfile] = await Promise.all([
      this.releaseService.getCurrent(projectId),
      this.latestBuild(projectId),
      this.listCorrections(projectId, 10),
      this.countOpenBlockingTasks(projectId),
      this.countOpenReviewTasks(projectId),
      this.countNegativeFeedback(projectId),
      this.lintRemediationService.summary(projectId),
      this.latestAgentFeedback(projectId),
      this.latestKnowledgeEvent(projectId, "publish.skipped"),
      this.governanceProfileService.resolve(projectId),
    ]);
    const pendingCorrections = corrections.filter((item) => item.state === "pending_review").length;
    const failedLintRemediations = lintSummary.failed + lintSummary.needsHuman;
    const canAttemptPublish = Boolean(latestBuild?.packageId) &&
      blockingTasks === 0 &&
      pendingCorrections === 0 &&
      lintSummary.pending === 0 &&
      lintSummary.failed === 0 &&
      lintSummary.needsHuman === 0;
    const gateReasons = flywheelGateReasons({
      latestBuild,
      blockingTasks,
      pendingReviewTasks,
      pendingCorrections,
      lintSummary,
    });
    return {
      result: {
        projectId,
        currentRelease: release ? releaseEnvelope(release) : null,
        latestBuild,
        exceptions: {
          blockingTasks,
          pendingReviewTasks,
          negativeFeedback,
          pendingCorrections,
          failedLintRemediations,
        },
        recentActivity: {
          latestBuild,
          latestCorrection: corrections[0] ?? null,
          latestFeedback,
          latestPublishSkip,
        },
        corrections: {
          pendingReview: pendingCorrections,
          active: corrections.filter((item) => item.state === "active").length,
          recent: corrections,
        },
        gates: {
          blockingTasks,
          pendingReviewTasks,
          negativeFeedback,
          pendingCorrections,
          lintRemediation: lintSummary,
          policy: {
            source: governanceProfile.source,
            release: governanceProfile.release,
            lint: governanceProfile.lint,
            trust: governanceProfile.trust,
          },
          canAttemptPublish,
          reasons: gateReasons,
        },
      },
      componentIds: corrections.map((item) => item.componentId).filter(Boolean) as string[],
      forceHit: true,
    };
  }

  private async kbRunHealthCheck(projectId: string, payload: Record<string, unknown>, context: KnowledgeQueryContext): Promise<ToolResult> {
    const maxAuditAgeDays = boundedLimitArg(numberArg(payload, 180, "maxAuditAgeDays", "auditHalfLifeDays"), 180, 3650);
    const trustThreshold = boundedScoreArg(payload, 0.7, "minTrustScore", "trustThreshold");
    const [release, latestBuild, blockingTasks, pendingReviewTasks, negativeFeedback, lintSummary, corrections, governanceProfile] = await Promise.all([
      this.releaseService.getCurrent(projectId),
      this.latestBuild(projectId),
      this.countOpenBlockingTasks(projectId),
      this.countOpenReviewTasks(projectId),
      this.countNegativeFeedback(projectId),
      this.lintRemediationService.summary(projectId),
      this.listCorrections(projectId, 50),
      this.governanceProfileService.resolve(projectId),
    ]);
    if (!release) {
      const result = {
        projectId,
        status: "needs_attention",
        consumption: "blocked",
        summary: "当前项目没有已发布知识，Agent 暂无可消费版本。",
        checks: {
          release: { status: "failed", reason: "no_current_release" },
        },
        policy: {
          source: governanceProfile.source,
          release: governanceProfile.release,
          lint: governanceProfile.lint,
          trust: governanceProfile.trust,
        },
        recommendations: [
          { action: "upload_or_build", tool: "kb_get_flywheel_status", reason: "先确认资料库、构建和发布状态。", payload: { projectId } },
        ],
      };
      await emitKnowledgeEvent(this.db, {
        eventType: "knowledge_lint.health_checked",
        entityType: "project",
        entityId: projectId,
        payload: {
          projectId,
          status: result.status,
          consumption: result.consumption,
          policy: {
            source: governanceProfile.source,
            autoPublishRevisions: governanceProfile.release.autoPublishRevisions,
            lintAutoGovernanceEnabled: governanceProfile.lint.autoGovernanceEnabled,
            minAutoPublishScore: governanceProfile.trust.minAutoPublishScore,
          },
          actor: context.sessionId ?? "mcp-agent",
        },
      });
      return { result, componentIds: [], forceHit: true };
    }

    const componentIds = manifestComponentIds(release);
    const trust = await this.trustSummaryForComponents(release, componentIds);
    const lowTrust = trust.components
      .filter((component) => typeof component.trust?.score === "number" && component.trust.score < trustThreshold)
      .map((component) => healthComponent(component));
    const staleAudit = trust.components
      .filter((component) => auditIsStale(component.trust?.lastTrustedAuditAt ?? null, maxAuditAgeDays))
      .map((component) => healthComponent(component));
    const pendingCorrectionSamples = corrections.filter((item) => item.state === "pending_review").map(healthCorrection);
    const activeCorrectionSamples = corrections.filter((item) => item.state === "active").map(healthCorrection);
    const pendingCorrections = pendingCorrectionSamples.length;
    const activeCorrections = activeCorrectionSamples.length;
    const lintIssues = lintSummary.failed + lintSummary.needsHuman + lintSummary.pending;
    const blockingReasons = healthBlockingReasons({
      blockingTasks,
      pendingCorrections,
      lintSummary,
    });
    const warningReasons = healthWarningReasons({
      pendingReviewTasks,
      negativeFeedback,
      lowTrustCount: lowTrust.length,
      staleAuditCount: staleAudit.length,
      activeCorrections,
      lintSummary,
    });
    const reasons = [...blockingReasons, ...warningReasons];
    const status = blockingReasons.length > 0 ? "needs_attention" : warningReasons.length > 0 ? "warning" : "passed";
    const consumption = status === "needs_attention" ? "use_with_care" : "ready";
    const recommendations = healthRecommendations(projectId, blockingReasons, warningReasons, {
      pendingCorrections: pendingCorrectionSamples,
      activeCorrections: activeCorrectionSamples,
      lowTrust,
      staleAudit,
    });
    const result = {
      projectId,
      checkedAt: new Date().toISOString(),
      status,
      consumption,
      summary: healthSummary(status, release.version, blockingReasons.length, warningReasons.length),
      thresholds: {
        minTrustScore: trustThreshold,
        maxAuditAgeDays,
      },
      release: releaseEnvelope(release),
      latestBuild,
      policy: {
        source: governanceProfile.source,
        release: governanceProfile.release,
        lint: governanceProfile.lint,
        trust: governanceProfile.trust,
      },
      checks: {
        release: { status: "passed", componentCount: componentIds.length },
        lint: {
          status: lintIssues > 0 ? "warning" : "passed",
          remediation: lintSummary,
        },
        trust: {
          status: lowTrust.length > 0 ? "warning" : "passed",
          averageScore: trust.averageScore,
          minScore: trust.minScore,
          lowTrustCount: lowTrust.length,
          lowTrustSample: lowTrust.slice(0, 10),
        },
        auditFreshness: {
          status: staleAudit.length > 0 ? "warning" : "passed",
          staleCount: staleAudit.length,
          staleSample: staleAudit.slice(0, 10),
        },
        governance: {
          status: blockingReasons.length > 0 ? "failed" : warningReasons.length > 0 ? "warning" : "passed",
          blockingTasks,
          pendingReviewTasks,
          pendingCorrections,
          activeCorrections,
          negativeFeedback,
        },
        corrections: {
          status: pendingCorrections > 0 ? "failed" : activeCorrections > 0 ? "warning" : "passed",
          pendingReviewCount: pendingCorrections,
          activeCount: activeCorrections,
          pendingReviewSample: pendingCorrectionSamples.slice(0, 10),
          activeSample: activeCorrectionSamples.slice(0, 10),
        },
      },
      reasons,
      recommendations,
    };
    await emitKnowledgeEvent(this.db, {
      eventType: "knowledge_lint.health_checked",
      entityType: "release",
      entityId: release.releaseId,
      payload: {
        projectId,
        releaseId: release.releaseId,
        status,
        consumption,
        thresholds: { minTrustScore: trustThreshold, maxAuditAgeDays },
        policy: {
          source: governanceProfile.source,
          autoPublishRevisions: governanceProfile.release.autoPublishRevisions,
          lintAutoGovernanceEnabled: governanceProfile.lint.autoGovernanceEnabled,
          minAutoPublishScore: governanceProfile.trust.minAutoPublishScore,
        },
        reasons,
        recommendations: recommendations.map((item) => ({
          action: item.action,
          tool: item.tool,
          payload: item.payload ?? {},
        })),
        actor: context.sessionId ?? "mcp-agent",
      },
    });
    return {
      result,
      componentIds: uniqueSorted([...lowTrust.map((item) => item.componentId), ...staleAudit.map((item) => item.componentId)]),
      forceHit: true,
    };
  }

  /**
   * 供后台周期调度器（registerHealthSweepScheduler）调用的知识健康巡检入口。
   * 对某项目运行一次 lint / trust / 过期审计（auditIsStale 是时间相关的，只有定期触发才能
   * 及时发现「知识过期」）检查，结果落 knowledge_lint.health_checked 事件进入自动化历史，可审阅。
   * 复用 kbRunHealthCheck 的全部逻辑与事件发射，仅在 actor 与调用场景上区别于 MCP 手动调用。
   */
  async runScheduledHealthCheck(projectId: string, actor = "health-sweep-scheduler"): Promise<{ projectId: string; status: string }> {
    const outcome = await this.kbRunHealthCheck(projectId, {}, { sessionId: actor });
    const status = typeof (outcome.result as { status?: unknown })?.status === "string"
      ? String((outcome.result as { status?: unknown }).status)
      : "unknown";
    return { projectId, status };
  }

  private async kbSubmitCorrection(projectId: string, payload: Record<string, unknown>, context: KnowledgeQueryContext): Promise<ToolResult> {
    const target = await this.resolveCorrectionTarget(projectId, payload);
    if (!target) throw new Error("kb_submit_correction requires componentId, knowledgePath, or an unambiguous sourcePath that resolves to a staged asset component.");
    const { component, sourcePath, anchor: anchorExplanation } = target;
    const anchor = await this.resolveSourceCorrectionAnchor(component.packageId, sourcePath);
    const suggestion = normalizeCorrectionValue(payload.suggestion);
    const factKey = optionalString(payload, "factKey") || sourceCorrectionFactKey(suggestion);
    const ruleId = optionalString(payload, "ruleId") || "mcp.agent_correction";
    const pageType = optionalString(payload, "pageType") || component.kind;
    const now = new Date().toISOString();
    const correctionId = `corr_mcp_${slug(sourcePath)}_${slug(ruleId)}_${nanoid(6)}`;
    const correctValue = {
      ...suggestion,
      factKey: factKey || suggestion.factKey,
      issue: stringArg(payload, "issue"),
      sourceContext: optionalString(payload, "sourceContext"),
      queryContext: optionalString(payload, "queryContext"),
      confidence: optionalNumber(payload, "confidence"),
    };
    await this.adapter.query(
      `UPDATE source_corrections
       SET state = 'retired', updated_at = $7
       WHERE project_id = $1
         AND bundle_id = $2
         AND source_path = $3
         AND rule_id = $4
         AND page_type = $5
         AND COALESCE(fact_key, '') = COALESCE($6, '')
         AND state <> 'retired'`,
      [projectId, anchor.bundleId, sourcePath, ruleId, pageType, factKey, now],
    );
    await this.adapter.query(
      `INSERT INTO source_corrections (
         correction_id, project_id, bundle_id, source_path, rule_id, page_type, fact_key,
         bound_source_hash, state, correct_value, component_id, package_id,
         example_id, task_id, created_by, created_at, updated_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending_review',$9,$10,$11,'','',$12,$13,$13)`,
      [
        correctionId,
        projectId,
        anchor.bundleId,
        sourcePath,
        ruleId,
        pageType,
        factKey || null,
        anchor.contentHash,
        JSON.stringify(correctValue),
        component.componentId,
        component.packageId,
        context.sessionId ?? "mcp-agent",
        now,
      ],
    );
    await emitKnowledgeEvent(this.db, {
      eventType: "correction.submitted",
      entityType: "source_correction",
      entityId: correctionId,
      payload: { projectId, correctionId, componentId: component.componentId, packageId: component.packageId, sourcePath, ruleId, anchor: anchorExplanation, actor: context.sessionId ?? "mcp-agent" },
    });
    await emitKnowledgeEvent(this.db, {
      eventType: "source_correction.created",
      entityType: "source_correction",
      entityId: correctionId,
      payload: { projectId, correctionId, componentId: component.componentId, packageId: component.packageId, sourcePath, ruleId, state: "pending_review", anchor: anchorExplanation },
    });
    return {
      result: {
        correctionId,
        state: "pending_review",
        message: "已提交修正建议；尚未改写发布知识。可继续调用 kb_apply_correction 激活后再做 scoped rebuild。",
        component: componentSummary(component),
        sourcePath,
        anchor: anchorExplanation,
        ruleId,
        pageType,
        factKey: factKey || null,
      },
      componentIds: [component.componentId],
      artifactIds: [component.artifactId],
      forceHit: true,
    };
  }

  private async kbApplyCorrection(projectId: string, correctionId: string, context: KnowledgeQueryContext, note = ""): Promise<ToolResult> {
    const correction = await this.getCorrection(projectId, correctionId);
    if (!correction) throw new Error(`Unknown correction in project ${projectId}: ${correctionId}`);
    if (correction.state === "retired") throw new Error("Retired corrections cannot be applied.");
    const componentLevel = correction.sourcePath.startsWith("component:")
      || Boolean(correction.componentId && !sourceRefLooksLikeSource(correction.sourcePath));
    const currentHash = componentLevel ? correction.boundSourceHash : await this.findLatestSourceHash(correction.bundleId, correction.sourcePath);
    if (!componentLevel && !currentHash) throw new Error("当前资料版本中未找到该源文件，无法应用修正。");
    const now = new Date().toISOString();
    const { rows } = await this.adapter.query(
      `UPDATE source_corrections
       SET state = 'active', bound_source_hash = $3, updated_at = $4
       WHERE project_id = $1 AND correction_id = $2
       RETURNING *`,
      [projectId, correctionId, currentHash, now],
    );
    const updated = sourceCorrectionRecord(rows[0]);
    await emitKnowledgeEvent(this.db, {
      eventType: "correction.applied",
      entityType: "source_correction",
      entityId: correctionId,
      payload: { projectId, correctionId, componentId: updated.componentId, packageId: updated.packageId, sourcePath: updated.sourcePath, actor: context.sessionId ?? "mcp-agent", note },
    });
    await emitKnowledgeEvent(this.db, {
      eventType: "source_correction.confirmed",
      entityType: "source_correction",
      entityId: correctionId,
      payload: { projectId, correctionId, componentId: updated.componentId, sourcePath: updated.sourcePath, boundSourceHash: updated.boundSourceHash, actor: context.sessionId ?? "mcp-agent", note },
    });
    return { result: { correction: updated, message: "修正已激活为确定性覆盖；下一次 scoped rebuild 会把它注入中间态资产。" }, componentIds: updated.componentId ? [updated.componentId] : [], forceHit: true };
  }

  private async kbStartIncrementalCheck(projectId: string, payload: Record<string, unknown>, context: KnowledgeQueryContext): Promise<ToolResult> {
    if (booleanArg(payload, false, "runPendingLintRemediations", "pendingLint", "lintPending")) {
      const releaseId = optionalString(payload, "releaseId") || (await this.releaseService.getCurrent(projectId))?.releaseId;
      const remediations = await this.lintRemediationService.executePending({
        projectId,
        releaseId,
        requestedBy: context.sessionId ?? "mcp-agent",
        kbBuilderService: this.builderService,
        limit: boundedLimitArg(numberArg(payload, 10, "limit"), 10, 50),
      });
      const componentIds = uniqueSorted(remediations.map((item) => item.targetComponentId).filter(Boolean));
      await emitKnowledgeEvent(this.db, {
        eventType: "lint.checked",
        entityType: "project",
        entityId: projectId,
        payload: {
          projectId,
          releaseId: releaseId ?? "",
          mode: "pending_lint_remediations",
          count: remediations.length,
          componentIds,
          status: remediations.length > 0 ? "started" : "empty",
          actor: context.sessionId ?? "mcp-agent",
        },
      });
      return {
        result: {
          status: remediations.length > 0 ? "started" : "empty",
          mode: "pending_lint_remediations",
          releaseId: releaseId ?? "",
          remediations,
          count: remediations.length,
          message: remediations.length > 0
            ? "已启动 pending Knowledge Lint 自动治理队列；每个可治理项会触发 scoped rebuild 并重新计算证据、依赖和 trust。"
            : "当前没有 pending Knowledge Lint 自动治理项。",
        },
        componentIds,
        forceHit: true,
      };
    }
    const correctionId = optionalString(payload, "correctionId");
    const correction = correctionId ? await this.getCorrection(projectId, correctionId) : null;
    const componentId = correction?.componentId || optionalString(payload, "componentId");
    if (!componentId) throw new Error("kb_start_incremental_check requires correctionId or componentId.");
    const rawSourcePath = normalizeSourcePath(optionalString(payload, "sourcePath") || correction?.sourcePath || "");
    const sourcePath = sourceRefLooksLikeSource(rawSourcePath) ? rawSourcePath : "";
    const run = await this.builderService.startScopedRebuildForComponent({
      componentId,
      sourcePath,
      requestedBy: context.sessionId ?? "mcp-agent",
      traceId: context.traceId,
      rebuildTaskId: correctionId ? `mcp:${correctionId}` : undefined,
    });
    await emitKnowledgeEvent(this.db, {
      eventType: "lint.checked",
      entityType: "build_run",
      entityId: run.runId,
      payload: { projectId, correctionId: correctionId || "", componentId, sourcePath, runId: run.runId, status: "started" },
    });
    return {
      result: {
        status: "started",
        run,
        correctionId: correctionId || "",
        componentId,
        sourcePath,
        message: "已启动目标组件 scoped rebuild；构建完成后会重新计算 lint、证据、依赖和 trust。",
      },
      componentIds: [componentId],
      forceHit: true,
    };
  }

  private async kbPublishIfReady(projectId: string, payload: Record<string, unknown>, context: KnowledgeQueryContext): Promise<ToolResult> {
    const target = await this.resolvePublishTarget(projectId, optionalString(payload, "packageId"), optionalString(payload, "runId"));
    if (!target) {
      const result = await this.publishSkipped(projectId, "no_completed_build", [], context, { packageId: optionalString(payload, "packageId"), runId: optionalString(payload, "runId") });
      return { result, componentIds: [], forceHit: true };
    }
    let release: ReleaseRecord | null = null;
    try {
      if (target.only) {
        const revision = await this.releaseService.proposeRevisionDraftFromBuild({
          packageId: target.packageId,
          runId: target.runId,
          requestedBy: context.sessionId ?? "mcp-agent",
          only: target.only,
        });
        if (!revision.release) {
          const result = await this.publishSkipped(projectId, revision.reason, [], context, publishTargetSummary(target));
          return { result, componentIds: target.componentIds, forceHit: true };
        }
        release = revision.release;
      } else {
        release = await this.releaseService.createDraft({
          version: await this.nextMcpReleaseVersion(projectId),
          packageIds: [target.packageId],
          projectId,
          requestedBy: context.sessionId ?? "mcp-agent",
          note: `MCP 自动发布检查：${target.runId}`,
        });
      }
      const published = await this.releaseService.publish(release.releaseId, context.sessionId ?? "mcp-agent", { autoMode: Boolean(release.parentReleaseId) });
      await emitKnowledgeEvent(this.db, {
        eventType: "release.auto_publish_succeeded",
        entityType: "release",
        entityId: published.releaseId,
        payload: { projectId, releaseId: published.releaseId, runId: target.runId, packageId: target.packageId, mode: "mcp_publish_if_ready" },
      });
      return {
        result: {
          status: "published",
          release: releaseSummary(published, false),
          target: publishTargetSummary(target),
        },
        componentIds: target.componentIds,
        forceHit: true,
      };
    } catch (error) {
      const check = error instanceof AutoPublishEligibilityError ? error.check : null;
      const result = await this.publishSkipped(projectId, error instanceof Error ? error.message : String(error), check?.reasonDetails ?? [], context, {
        ...publishTargetSummary(target),
        releaseId: release?.releaseId ?? "",
        autoPublishCheck: check ? slimAutoPublishCheck(check) : null,
      });
      return { result, componentIds: target.componentIds, forceHit: true };
    }
  }

  private async kbGetCorrectionStatus(projectId: string, correctionId: string): Promise<ToolResult> {
    const correction = await this.getCorrection(projectId, correctionId);
    if (!correction) throw new Error(`Unknown correction in project ${projectId}: ${correctionId}`);
    const { rows } = await this.adapter.query(
      `SELECT event_id, event_type, entity_type, entity_id, payload_json, created_at
       FROM knowledge_events
       WHERE project_id = $1
         AND (entity_id = $2 OR payload_json->>'correctionId' = $2)
       ORDER BY created_at ASC`,
      [projectId, correctionId],
    );
    const buildRunIds = rows.map((row) => String(jsonObject(row.payload_json).runId ?? "")).filter(Boolean);
    return {
      result: {
        correction,
        lifecycle: rows.map((row) => ({
          eventId: String(row.event_id ?? ""),
          type: String(row.event_type ?? ""),
          entityType: String(row.entity_type ?? ""),
          entityId: String(row.entity_id ?? ""),
          payload: jsonObject(row.payload_json),
          createdAt: String(row.created_at ?? ""),
        })),
        buildRunIds: uniqueSorted(buildRunIds),
      },
      componentIds: correction.componentId ? [correction.componentId] : [],
      forceHit: true,
    };
  }

  private async kbGovernFlywheel(projectId: string, payload: Record<string, unknown>, context: KnowledgeQueryContext): Promise<ToolResult> {
    const steps: Array<{ name: string; status: "completed" | "skipped"; result?: unknown; reason?: string }> = [];
    const componentIds: string[] = [];
    const artifactIds: string[] = [];
    let correctionId = optionalString(payload, "correctionId");
    let runId = optionalString(payload, "runId");

    if (!correctionId) {
      const submitted = await this.kbSubmitCorrection(projectId, payload, context);
      correctionId = String((submitted.result as Record<string, unknown>).correctionId ?? "");
      componentIds.push(...submitted.componentIds);
      artifactIds.push(...(submitted.artifactIds ?? []));
      steps.push({ name: "submit_correction", status: "completed", result: submitted.result });
    } else {
      const correction = await this.getCorrection(projectId, correctionId);
      if (!correction) throw new Error(`Unknown correction in project ${projectId}: ${correctionId}`);
      if (correction.componentId) componentIds.push(correction.componentId);
      steps.push({ name: "submit_correction", status: "skipped", reason: "correctionId was provided" });
    }

    if (payload.apply === false) {
      steps.push({ name: "apply_correction", status: "skipped", reason: "apply=false" });
    } else {
      const applied = await this.kbApplyCorrection(projectId, correctionId, context, optionalString(payload, "note") ?? "kb_govern_flywheel");
      componentIds.push(...applied.componentIds);
      artifactIds.push(...(applied.artifactIds ?? []));
      steps.push({ name: "apply_correction", status: "completed", result: applied.result });
    }

    if (payload.check === false) {
      steps.push({ name: "incremental_check", status: "skipped", reason: "check=false" });
    } else {
      const checked = await this.kbStartIncrementalCheck(projectId, { ...payload, correctionId }, context);
      componentIds.push(...checked.componentIds);
      artifactIds.push(...(checked.artifactIds ?? []));
      runId = String(((checked.result as Record<string, unknown>).run as Record<string, unknown> | undefined)?.runId ?? runId ?? "");
      steps.push({ name: "incremental_check", status: "completed", result: checked.result });
    }

    let finalStatus = "checked";
    if (payload.publish === false) {
      steps.push({ name: "publish_if_ready", status: "skipped", reason: "publish=false" });
      finalStatus = "publish_skipped_by_request";
    } else {
      const published = await this.kbPublishIfReady(projectId, { ...payload, correctionId, runId }, context);
      componentIds.push(...published.componentIds);
      steps.push({ name: "publish_if_ready", status: "completed", result: published.result });
      finalStatus = String((published.result as Record<string, unknown>).status ?? "publish_checked");
    }

    const result = {
      status: finalStatus,
      projectId,
      correctionId,
      runId,
      steps,
      boundary: {
        stagedOnly: true,
        publishedAssetsImmutable: true,
        releaseChannelDirectWrite: false,
      },
      message: "飞轮治理已按统一 MCP 权限执行；发布只会在服务端门禁通过时生成新 revision。",
    };
    await emitKnowledgeEvent(this.db, {
      eventType: "flywheel.governed",
      entityType: "source_correction",
      entityId: correctionId,
      payload: { projectId, correctionId, runId, status: finalStatus, componentIds: uniqueSorted(componentIds), actor: context.sessionId ?? "mcp-agent" },
    });

    return {
      result,
      componentIds: uniqueSorted(componentIds),
      artifactIds: uniqueSorted(artifactIds),
      forceHit: true,
    };
  }

  private async kbSubmitAttribution(projectId: string, payload: Record<string, unknown>, context: KnowledgeQueryContext): Promise<ToolResult> {
    const releaseId = optionalString(payload, "releaseId")
      ?? (await this.releaseService.getCurrent(projectId))?.releaseId
      ?? "";
    if (!releaseId) throw new Error("kb_submit_attribution requires releaseId or a current published release.");
    const title = optionalString(payload, "title") ?? `Agent attribution ${new Date().toISOString()}`;
    const segmentsRaw = payload.segments;
    if (!Array.isArray(segmentsRaw) || segmentsRaw.length === 0) {
      throw new Error("kb_submit_attribution requires a non-empty segments array.");
    }
    const segments = segmentsRaw.map((item) => {
      const row = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
      const text = typeof row.text === "string" ? row.text.trim() : "";
      if (!text) throw new Error("Each attribution segment requires non-empty text.");
      const traceRaw = row.trace && typeof row.trace === "object" && !Array.isArray(row.trace)
        ? row.trace as Record<string, unknown>
        : {};
      const derivedFrom = Array.isArray(row.derivedFrom) ? row.derivedFrom.map(String) : [];
      return {
        text,
        derivedFrom,
        trace: {
          releaseId: typeof traceRaw.releaseId === "string" ? traceRaw.releaseId : releaseId,
          componentIds: Array.isArray(traceRaw.componentIds)
            ? traceRaw.componentIds.map(String)
            : Array.isArray(payload.componentIds) ? payload.componentIds.map(String) : [],
          artifactIds: Array.isArray(traceRaw.artifactIds) ? traceRaw.artifactIds.map(String) : [],
          sourceVersionIds: Array.isArray(traceRaw.sourceVersionIds) ? traceRaw.sourceVersionIds.map(String) : [],
          evidenceIds: Array.isArray(traceRaw.evidenceIds)
            ? traceRaw.evidenceIds.map(String)
            : Array.isArray(payload.evidenceIds) ? payload.evidenceIds.map(String) : [],
        },
      };
    });
    const audit = await this.attributionAuditService.createAudit({
      releaseId,
      title,
      createdBy: context.sessionId || context.agentRole || "mcp-agent",
      segments,
    });
    return {
      result: {
        projectId,
        audit,
        message: "归因审计已写入；不修改已发布 OKF。",
      },
      componentIds: uniqueSorted(segments.flatMap((segment) => segment.trace.componentIds ?? [])),
      forceHit: true,
    };
  }

  private async kbListFeedbackClusters(projectId: string): Promise<ToolResult> {
    const clusters = await this.flywheel().listFeedbackClusters(projectId);
    return {
      result: {
        projectId,
        count: clusters.length,
        clusters,
      },
      componentIds: uniqueSorted(clusters.flatMap((cluster) => cluster.affectedComponents.map((item) => item.componentId))),
      forceHit: true,
    };
  }

  private async resolveCorrectionComponent(projectId: string, componentId?: string, knowledgePath?: string): Promise<AssetComponent | null> {
    const params: unknown[] = [projectId];
    const where = ["p.project_id = $1"];
    if (componentId) {
      params.push(componentId);
      where.push(`c.component_id = $${params.length}`);
    } else if (knowledgePath) {
      const normalized = normalize(knowledgePath);
      params.push(knowledgePath, normalized, `%${knowledgePath}%`);
      where.push(`(
        c.component_id = $${params.length - 2}
        OR c.legacy_path = $${params.length - 2}
        OR c.artifact_id = $${params.length - 2}
        OR c.title = $${params.length - 2}
        OR lower(c.component_id) = $${params.length - 1}
        OR lower(c.legacy_path) = $${params.length - 1}
        OR lower(c.artifact_id) = $${params.length - 1}
        OR lower(c.title) = $${params.length - 1}
        OR c.legacy_path ILIKE $${params.length}
        OR c.artifact_id ILIKE $${params.length}
        OR c.title ILIKE $${params.length}
      )`);
    } else {
      return null;
    }
    const { rows } = await this.adapter.query(
      `SELECT c.*
       FROM asset_components c
       JOIN asset_packages p ON p.package_id = c.package_id
       WHERE ${where.join(" AND ")}
       ORDER BY p.created_at DESC, c.component_id
       LIMIT 1`,
      params,
    );
    return rows.length ? mapComponent(rows[0]) : null;
  }

  private async resolveCorrectionTarget(projectId: string, payload: Record<string, unknown>): Promise<CorrectionTarget | null> {
    const componentId = optionalString(payload, "componentId");
    const knowledgePath = optionalString(payload, "knowledgePath");
    const requestedSourcePath = normalizeSourcePath(optionalString(payload, "sourcePath") || "");

    if (componentId) {
      const component = await this.resolveCorrectionComponent(projectId, componentId, undefined);
      if (!component) return null;
      return correctionTargetForComponent(component, requestedSourcePath, "componentId");
    }

    if (knowledgePath) {
      const component = await this.resolveCorrectionComponent(projectId, undefined, knowledgePath);
      if (!component) return null;
      return correctionTargetForComponent(component, requestedSourcePath, "knowledgePath");
    }

    if (requestedSourcePath) {
      const candidates = await this.findCorrectionComponentsBySourcePath(projectId, requestedSourcePath);
      if (candidates.length === 1) {
        return correctionTargetForComponent(candidates[0], requestedSourcePath, "sourcePath_unique");
      }
      if (candidates.length > 1) {
        throw new Error(`sourcePath ${requestedSourcePath} is referenced by multiple components; provide componentId or knowledgePath. Candidates: ${candidates.map((component) => `${component.componentId} (${component.title || component.artifactId})`).join(", ")}`);
      }
    }

    return null;
  }

  private async findCorrectionComponentsBySourcePath(projectId: string, sourcePath: string): Promise<AssetComponent[]> {
    const like = `%${sourcePath}%`;
    const { rows } = await this.adapter.query(
      `SELECT c.*
       FROM asset_components c
       JOIN asset_packages p ON p.package_id = c.package_id
       WHERE p.project_id = $1
         AND (c.source_refs ? $2 OR c.source_refs::text ILIKE $3)
       ORDER BY p.created_at DESC, c.component_id`,
      [projectId, sourcePath, like],
    );
    return rows.map(mapComponent);
  }

  private async resolveSourceCorrectionAnchor(packageId: string, sourcePath: string): Promise<{ bundleId: string; contentHash: string }> {
    const { rows: packageRows } = await this.adapter.query("SELECT source_version_ids FROM asset_packages WHERE package_id = $1", [packageId]);
    const versionIds = packageRows.length ? jsonArray(packageRows[0].source_version_ids) : [];
    if (versionIds.length === 0) return { bundleId: "default", contentHash: "" };
    const placeholders = versionIds.map((_, index) => `$${index + 2}`).join(",");
    const { rows } = await this.adapter.query(
      `SELECT v.bundle_id, COALESCE(sf.content_hash, '') AS content_hash
       FROM source_bundle_versions v
       LEFT JOIN source_files sf ON sf.version_id = v.version_id AND sf.logical_path = $1
       WHERE v.version_id IN (${placeholders})
       ORDER BY v.created_at DESC, v.version_id DESC
       LIMIT 1`,
      [sourcePath, ...versionIds],
    );
    if (!rows.length) return { bundleId: "default", contentHash: "" };
    return { bundleId: String(rows[0].bundle_id ?? "default"), contentHash: String(rows[0].content_hash ?? "") };
  }

  private async findLatestSourceHash(bundleId: string, sourcePath: string): Promise<string> {
    const { rows } = await this.adapter.query(
      `SELECT sf.content_hash
       FROM source_bundle_versions v
       JOIN source_files sf ON sf.version_id = v.version_id
       WHERE v.bundle_id = $1 AND sf.logical_path = $2
       ORDER BY v.created_at DESC, v.version_id DESC
       LIMIT 1`,
      [bundleId, sourcePath],
    );
    return rows.length ? String(rows[0].content_hash ?? "") : "";
  }

  private async getCorrection(projectId: string, correctionId: string): Promise<SourceCorrectionView | null> {
    const { rows } = await this.adapter.query("SELECT * FROM source_corrections WHERE project_id = $1 AND correction_id = $2", [projectId, correctionId]);
    return rows.length ? sourceCorrectionRecord(rows[0]) : null;
  }

  private async listCorrections(projectId: string, limit: number): Promise<SourceCorrectionView[]> {
    const { rows } = await this.adapter.query(
      `SELECT *
       FROM source_corrections
       WHERE project_id = $1
       ORDER BY updated_at DESC, created_at DESC
       LIMIT $2`,
      [projectId, limit],
    );
    return rows.map(sourceCorrectionRecord);
  }

  private async latestBuild(projectId: string): Promise<Record<string, unknown> | null> {
    const { rows } = await this.adapter.query(
      `SELECT run_id, project_id, source_version_id, package_id, status, current_stage, completed_stages, started_at, finished_at, error, config_json
       FROM knowledge_build_runs
       WHERE project_id = $1
       ORDER BY started_at DESC, run_id DESC
       LIMIT 1`,
      [projectId],
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
      runId: String(row.run_id ?? ""),
      projectId: String(row.project_id ?? ""),
      sourceVersionId: String(row.source_version_id ?? ""),
      packageId: row.package_id ? String(row.package_id) : null,
      status: String(row.status ?? ""),
      currentStage: String(row.current_stage ?? ""),
      completedStages: jsonArray(row.completed_stages),
      startedAt: String(row.started_at ?? ""),
      finishedAt: row.finished_at ? String(row.finished_at) : null,
      error: String(row.error ?? ""),
      config: jsonObject(row.config_json),
    };
  }

  private async countOpenBlockingTasks(projectId: string): Promise<number> {
    const { rows } = await this.adapter.query(
      `SELECT COUNT(*)::int AS c
       FROM review_tasks
       WHERE project_id = $1 AND status = 'open' AND severity = 'blocking'`,
      [projectId],
    );
    return Number(rows[0]?.c ?? 0);
  }

  private async countOpenReviewTasks(projectId: string): Promise<number> {
    const { rows } = await this.adapter.query(
      `SELECT COUNT(*)::int AS c
       FROM review_tasks
       WHERE project_id = $1 AND status = 'open'`,
      [projectId],
    );
    return Number(rows[0]?.c ?? 0);
  }

  private async countNegativeFeedback(projectId: string): Promise<number> {
    const { rows } = await this.adapter.query(
      `SELECT COUNT(*)::int AS c
       FROM agent_events
       WHERE project_id = $1
         AND feedback_type <> 'hit'`,
      [projectId],
    );
    return Number(rows[0]?.c ?? 0);
  }

  private async latestAgentFeedback(projectId: string): Promise<Record<string, unknown> | null> {
    const { rows } = await this.adapter.query(
      `SELECT event_id, release_id, query, hit_component_ids, quality_flags, status, feedback_type, suggested_action, task_id, created_at
       FROM agent_events
       WHERE project_id = $1
       ORDER BY created_at DESC, event_id DESC
       LIMIT 1`,
      [projectId],
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
      eventId: String(row.event_id ?? ""),
      releaseId: String(row.release_id ?? ""),
      query: String(row.query ?? ""),
      hitComponentIds: jsonArray(row.hit_component_ids),
      qualityFlags: jsonArray(row.quality_flags),
      status: String(row.status ?? ""),
      feedbackType: String(row.feedback_type ?? ""),
      suggestedAction: String(row.suggested_action ?? ""),
      taskId: String(row.task_id ?? ""),
      createdAt: String(row.created_at ?? ""),
    };
  }

  private async latestKnowledgeEvent(projectId: string, eventType: string): Promise<Record<string, unknown> | null> {
    const { rows } = await this.adapter.query(
      `SELECT event_id, event_type, entity_type, entity_id, payload_json, created_at
       FROM knowledge_events
       WHERE project_id = $1 AND event_type = $2
       ORDER BY created_at DESC, event_id DESC
       LIMIT 1`,
      [projectId, eventType],
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
      eventId: String(row.event_id ?? ""),
      type: String(row.event_type ?? ""),
      entityType: String(row.entity_type ?? ""),
      entityId: String(row.entity_id ?? ""),
      payload: jsonObject(row.payload_json),
      createdAt: String(row.created_at ?? ""),
    };
  }

  private async resolvePublishTarget(projectId: string, packageId?: string, runId?: string): Promise<PublishTarget | null> {
    const params: unknown[] = [projectId];
    const where = ["r.project_id = $1", "r.status = 'completed'", "r.package_id IS NOT NULL"];
    if (packageId) {
      params.push(packageId);
      where.push(`r.package_id = $${params.length}`);
    }
    if (runId) {
      params.push(runId);
      where.push(`r.run_id = $${params.length}`);
    }
    const { rows } = await this.adapter.query(
      `SELECT r.run_id, r.package_id, r.config_json, p.source_version_ids
       FROM knowledge_build_runs r
       JOIN asset_packages p ON p.package_id = r.package_id
       WHERE ${where.join(" AND ")}
       ORDER BY r.finished_at DESC NULLS LAST, r.started_at DESC
       LIMIT 1`,
      params,
    );
    if (!rows.length) return null;
    const row = rows[0];
    const pkgId = String(row.package_id ?? "");
    const { rows: components } = await this.adapter.query("SELECT component_id FROM asset_components WHERE package_id = $1 ORDER BY component_id", [pkgId]);
    return {
      runId: String(row.run_id ?? ""),
      packageId: pkgId,
      only: String(jsonObject(row.config_json).only ?? ""),
      componentIds: components.map((component) => String(component.component_id ?? "")).filter(Boolean),
    };
  }

  private async publishSkipped(
    projectId: string,
    reason: string,
    reasonDetails: unknown[],
    context: KnowledgeQueryContext,
    target: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await emitKnowledgeEvent(this.db, {
      eventType: "publish.skipped",
      entityType: "release",
      entityId: String(target.releaseId ?? target.runId ?? ""),
      payload: { projectId, reason, reasonDetails, target, actor: context.sessionId ?? "mcp-agent", mode: "mcp_publish_if_ready" },
    });
    await emitKnowledgeEvent(this.db, {
      eventType: "release.auto_publish_skipped",
      entityType: "release",
      entityId: String(target.releaseId ?? target.runId ?? ""),
      payload: { projectId, reason, reasonDetails, ...target, mode: "mcp_publish_if_ready" },
    });
    return { status: "skipped", reason, reasonDetails, target: slimPublishTarget(target) };
  }

  private async nextMcpReleaseVersion(projectId: string): Promise<string> {
    const prefix = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/gu, ".");
    const { rows } = await this.adapter.query(
      "SELECT COUNT(*)::int AS c FROM releases WHERE project_id = $1 AND version LIKE $2",
      [projectId, `${prefix}.mcp.%`],
    );
    return `${prefix}.mcp.${String(Number(rows[0]?.c ?? 0) + 1).padStart(3, "0")}`;
  }

  private async governanceEnvelope<T>(
    toolName: string,
    release: ReleaseRecord | null,
    result: T,
    componentIds: string[],
    artifactIds: string[],
  ): Promise<KnowledgeEnvelope<T>> {
    const trust = release ? await this.trustSummaryForComponents(release, componentIds) : { averageScore: null, minScore: null, summary: emptyTrustSummary(null), components: [] };
    return {
      contract: envelopeContract(toolName, []),
      release: release ? releaseEnvelope(release) : { releaseId: "", version: "", publishedAt: null, manifestHash: "" },
      result,
      qualityFlags: [],
      trust: slimTrustEnvelope(trust),
      trace: {
        releaseId: release?.releaseId ?? "",
        ...slimTraceArrays({
          componentIds,
          artifactIds,
          sourceVersionIds: release ? releaseSourceVersionIds(release) : [],
          evidenceIds: [],
        }),
      },
    };
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

  private async negativeFeedbackCountForComponents(projectId: string, componentIds: string[]): Promise<number> {
    if (componentIds.length === 0) return 0;
    const { rows } = await this.adapter.query(
      `SELECT COUNT(*)::int AS c
       FROM agent_events
       WHERE project_id = $1
         AND feedback_type IN ('low_quality_hit', 'evidence_insufficient', 'bad_hit', 'stale_knowledge', 'knowledge_gap')
         AND hit_component_ids ?| $2::text[]`,
      [projectId, componentIds],
    );
    return Number(rows[0]?.c ?? 0);
  }

  private async correctionStatusForComponents(projectId: string, componentIds: string[]): Promise<"none" | "pending" | "applied" | "published"> {
    if (componentIds.length === 0) return "none";
    const placeholders = componentIds.map((_, index) => `$${index + 2}`).join(",");
    const { rows } = await this.adapter.query(
      `SELECT state, COUNT(*)::int AS c
       FROM source_corrections
       WHERE project_id = $1
         AND component_id IN (${placeholders})
         AND state <> 'retired'
       GROUP BY state`,
      [projectId, ...componentIds],
    );
    const states = new Set(rows.map((row) => String(row.state ?? "")));
    if (states.has("pending_review")) return "pending";
    if (states.has("active")) return "applied";
    return "none";
  }

  private async artifactIdsForComponents(componentIds: string[]): Promise<string[]> {
    if (componentIds.length === 0) return [];
    const placeholders = componentIds.map((_, index) => `$${index + 1}`).join(",");
    const { rows } = await this.adapter.query(`SELECT artifact_id FROM asset_components WHERE component_id IN (${placeholders})`, componentIds);
    return rows.map((row) => String(row.artifact_id));
  }

  private async trustSummaryForComponents(release: ReleaseRecord, componentIds: string[]): Promise<KnowledgeEnvelope["trust"]> {
    if (componentIds.length === 0) {
      return {
        averageScore: null,
        minScore: null,
        summary: emptyTrustSummary(release),
        components: [],
      };
    }
    const components = await this.componentsByIds(componentIds);
    const okfTrust = this.okfTrustByComponent(release, componentIds);
    const evidenceCounts = await this.evidenceCountsForComponents(release, componentIds);
    const [negativeFeedbackCount, correctionStatus] = await Promise.all([
      this.negativeFeedbackCountForComponents(release.projectId, componentIds),
      this.correctionStatusForComponents(release.projectId, componentIds),
    ]);
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
      summary: {
        level: trustLevel(scores.length ? Math.min(...scores) : null),
        evidenceCount: [...evidenceCounts.values()].reduce((sum, count) => sum + count, 0),
        sourceRefs: uniqueSorted(components.flatMap((component) => component.sourceRefs)),
        lastReviewedAt: latestIso(out.map((component) => component.trust?.lastTrustedAuditAt ?? "")),
        lastPublishedAt: release.publishedAt,
        negativeFeedbackCount,
        lintStatus: lintStatusFromTrust(out.map((component) => component.trust ?? null)),
        correctionStatus,
        ruleProfileHash: ruleProfileHashFromRelease(release),
      },
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

  private async qualityFlagsForComponents(componentIds: string[], evidenceRecords: Record<string, unknown>[], okfEvidenceComponentIds = new Set<string>(), trustByComponent = new Map<string, { score?: number | null } | null>()): Promise<string[]> {
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
    projectId: string;
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
        (audit_id, project_id, session_id, agent_role, tool_name, release_id, query_payload, hit_component_ids, quality_flags, status, latency_ms, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        `audit_${Date.now()}_${nanoid(6)}`,
        input.projectId,
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

function slimTrustEnvelope(trust: KnowledgeEnvelope["trust"], limit = MCP_ENVELOPE_DETAIL_LIMIT): KnowledgeEnvelope["trust"] {
  const components = trust.components ?? [];
  return {
    ...trust,
    components: components.slice(0, limit).map((component) => ({
      ...component,
      trust: slimEnvelopeTrustScore(component.trust),
    })),
    componentsSummary: {
      count: components.length,
      sampleComponentIds: components.slice(0, limit).map((component) => component.componentId),
      truncated: components.length > limit,
    },
  };
}

function slimEnvelopeTrustScore(trust: TrustScore | KnowledgeEnvelopeTrustScore | null): KnowledgeEnvelopeTrustScore | null {
  if (!trust) return null;
  return {
    version: trust.version,
    score: trust.score,
    status: trust.status,
    lastTrustedAuditAt: trust.lastTrustedAuditAt,
    evidenceRequired: trust.evidenceRequired,
  };
}

function slimTraceArrays(trace: Omit<KnowledgeTrace, "releaseId">, limit = MCP_ENVELOPE_DETAIL_LIMIT): Omit<KnowledgeTrace, "releaseId"> {
  return {
    componentIds: trace.componentIds.slice(0, limit),
    artifactIds: trace.artifactIds.slice(0, limit),
    sourceVersionIds: trace.sourceVersionIds.slice(0, limit),
    evidenceIds: trace.evidenceIds.slice(0, limit),
    componentIdSummary: sampleArray(trace.componentIds, limit),
    artifactIdSummary: sampleArray(trace.artifactIds, limit),
    sourceVersionIdSummary: sampleArray(trace.sourceVersionIds, limit),
    evidenceIdSummary: sampleArray(trace.evidenceIds, limit),
  };
}

function releaseSummary(release: ReleaseRecord, includeManifest: boolean, manifestLimit = 30): Record<string, unknown> {
  const manifest = release.manifest as Record<string, unknown>;
  const okf = jsonObject(manifest.okf);
  return {
    releaseId: release.releaseId,
    projectId: release.projectId,
    parentReleaseId: release.parentReleaseId,
    version: release.version,
    status: release.status,
    publishedAt: release.publishedAt,
    publishedBy: release.publishedBy,
    manifestHash: release.manifestHash,
    packageIds: release.packageIds,
    quality: release.qualityGate,
    okf: {
      bundleUri: okf.bundleUri ?? "",
      reportUri: okf.reportUri ?? "",
      reportMarkdownUri: okf.reportMarkdownUri ?? "",
      graphUri: okf.graphUri ?? "",
      tableSchemasUri: okf.tableSchemasUri ?? "",
      tableAliasesUri: okf.tableAliasesUri ?? "",
      evidenceUri: okf.evidenceUri ?? "",
      searchIndexUri: okf.searchIndexUri ?? "",
      logUri: okf.logUri ?? "",
      lintUri: okf.lintUri ?? "",
      okfVersion: okf.okfVersion ?? "",
      bundleHash: okf.bundleHash ?? "",
      summary: okf.summary ?? null,
      linkSummary: okf.linkSummary ?? null,
      citationSummary: okf.citationSummary ?? null,
      lintSummary: okf.lintSummary ?? null,
    },
    componentCount: jsonArray(manifest.componentIds).length,
    sourceVersionIds: releaseSourceVersionIds(release),
    manifest: includeManifest ? manifestPreview(manifest, manifestLimit) : undefined,
    manifestTruncated: includeManifest ? true : undefined,
    manifestAccess: includeManifest ? {
      mode: "preview",
      reason: "Full release manifests can exceed MCP response limits. Use okf.bundleUri and related OKF URIs to consume the frozen bundle files.",
      limit: boundedLimitArg(manifestLimit, 30, 200),
    } : undefined,
  };
}

function manifestPreview(manifest: Record<string, unknown>, limit: number): Record<string, unknown> {
  const boundedLimit = boundedLimitArg(limit, 30, 200);
  const componentIds = jsonArray(manifest.componentIds);
  const packageIds = jsonArray(manifest.packageIds);
  const sourceVersionIds = jsonArray(manifest.sourceVersionIds);
  const components = arraySample(manifest.components, boundedLimit);
  return {
    releaseId: String(manifest.releaseId ?? ""),
    projectId: String(manifest.projectId ?? ""),
    version: String(manifest.version ?? ""),
    status: String(manifest.status ?? ""),
    publishedAt: manifest.publishedAt ?? null,
    manifestHash: String(manifest.manifestHash ?? ""),
    okf: jsonObject(manifest.okf),
    qualityGate: jsonObject(manifest.qualityGate),
    auditSummary: jsonObject(manifest.auditSummary),
    revision: slimRevision(jsonObject(manifest.revision), boundedLimit),
    autoPublish: slimAutoPublishPreview(jsonObject(manifest.autoPublish), boundedLimit),
    packageIds: sampleArray(packageIds, boundedLimit),
    sourceVersionIds: sampleArray(sourceVersionIds, boundedLimit),
    componentIds: sampleArray(componentIds, boundedLimit),
    components: {
      count: components.count,
      sample: components.sample.map((component) => slimManifestComponent(jsonObject(component))),
      truncated: components.truncated,
    },
  };
}

function slimRevision(revision: Record<string, unknown>, limit: number): Record<string, unknown> {
  if (Object.keys(revision).length === 0) return {};
  const diff = jsonObject(revision.diff);
  const packageIds = jsonObject(diff.packageIds);
  const componentIds = jsonObject(diff.componentIds);
  const sourceVersionIds = jsonObject(diff.sourceVersionIds);
  return {
    parentReleaseId: revision.parentReleaseId ?? null,
    mode: String(revision.mode ?? ""),
    summary: jsonObject(revision.summary),
    diff: {
      packageIds: slimDiffBucket(packageIds, limit),
      componentIds: slimDiffBucket(componentIds, limit),
      sourceVersionIds: slimDiffBucket(sourceVersionIds, limit),
      changedComponents: sampleArray(jsonArray(diff.changedComponents), limit),
      unchangedComponents: sampleArray(jsonArray(diff.unchangedComponents), limit),
    },
  };
}

function slimDiffBucket(bucket: Record<string, unknown>, limit: number): Record<string, unknown> {
  return {
    added: sampleArray(jsonArray(bucket.added), limit),
    removed: sampleArray(jsonArray(bucket.removed), limit),
    unchanged: sampleArray(jsonArray(bucket.unchanged), limit),
  };
}

function slimAutoPublishPreview(autoPublish: Record<string, unknown>, limit: number): Record<string, unknown> {
  if (Object.keys(autoPublish).length === 0) return {};
  const trustDeclines = arraySample(autoPublish.trustDeclines, limit);
  const pendingSourceCorrections = arraySample(autoPublish.pendingSourceCorrections, limit);
  return {
    eligible: Boolean(autoPublish.eligible),
    mode: String(autoPublish.mode ?? ""),
    reasons: jsonArray(autoPublish.reasons),
    reasonDetails: Array.isArray(autoPublish.reasonDetails) ? autoPublish.reasonDetails : [],
    changedComponents: sampleArray(jsonArray(autoPublish.changedComponentIds), limit),
    blockingTasks: sampleArray(jsonArray(autoPublish.blockingTaskIds), limit),
    trustDeclines: {
      count: trustDeclines.count,
      sample: trustDeclines.sample,
      truncated: trustDeclines.truncated,
    },
    pendingSourceCorrections: {
      count: pendingSourceCorrections.count,
      sample: pendingSourceCorrections.sample,
      truncated: pendingSourceCorrections.truncated,
    },
    lintRemediation: jsonObject(autoPublish.lintRemediation),
  };
}

function slimManifestComponent(component: Record<string, unknown>): Record<string, unknown> {
  return {
    componentId: String(component.componentId ?? ""),
    packageId: String(component.packageId ?? ""),
    artifactId: String(component.artifactId ?? ""),
    title: String(component.title ?? ""),
    kind: String(component.kind ?? ""),
    groupName: String(component.groupName ?? component.group_name ?? ""),
    trust: component.trust ?? null,
  };
}

function publishTargetSummary(target: PublishTarget, limit = 20): Record<string, unknown> {
  return {
    runId: target.runId,
    packageId: target.packageId,
    only: target.only,
    componentCount: target.componentIds.length,
    componentIdSample: target.componentIds.slice(0, limit),
    componentIdsTruncated: target.componentIds.length > limit,
  };
}

function slimAutoPublishCheck(check: AutoPublishCheck, limit = 20): Record<string, unknown> {
  return {
    eligible: check.eligible,
    mode: check.mode,
    reasons: check.reasons,
    reasonDetails: check.reasonDetails,
    changedComponents: sampleArray(check.changedComponentIds, limit),
    blockingTasks: sampleArray(check.blockingTaskIds, limit),
    trustDeclines: {
      count: check.trustDeclines.length,
      sample: check.trustDeclines.slice(0, limit),
      truncated: check.trustDeclines.length > limit,
    },
    pendingSourceCorrections: {
      count: check.pendingSourceCorrections.length,
      sample: check.pendingSourceCorrections.slice(0, limit),
      truncated: check.pendingSourceCorrections.length > limit,
    },
    lintRemediation: check.lintRemediation,
  };
}

function slimPublishTarget(target: Record<string, unknown>): Record<string, unknown> {
  const componentIds = jsonArray(target.componentIds);
  if (componentIds.length === 0) return target;
  const rest = { ...target };
  delete rest.componentIds;
  return {
    ...rest,
    componentCount: Number(target.componentCount ?? componentIds.length),
    componentIdSample: jsonArray(target.componentIdSample).length ? jsonArray(target.componentIdSample) : componentIds.slice(0, 20),
    componentIdsTruncated: Boolean(target.componentIdsTruncated ?? componentIds.length > 20),
  };
}

function sampleArray(values: string[], limit: number): { count: number; sample: string[]; truncated: boolean } {
  return {
    count: values.length,
    sample: values.slice(0, limit),
    truncated: values.length > limit,
  };
}

function arraySample(value: unknown, limit: number): { count: number; sample: unknown[]; truncated: boolean } {
  const values = Array.isArray(value) ? value : [];
  return {
    count: values.length,
    sample: values.slice(0, limit),
    truncated: values.length > limit,
  };
}

function emptyTrustSummary(release: ReleaseRecord | null): NonNullable<KnowledgeEnvelope["trust"]["summary"]> {
  return {
    level: "unknown",
    evidenceCount: 0,
    sourceRefs: [],
    lastReviewedAt: null,
    lastPublishedAt: release?.publishedAt ?? null,
    negativeFeedbackCount: 0,
    lintStatus: "unknown",
    correctionStatus: "none",
    ruleProfileHash: release ? ruleProfileHashFromRelease(release) : "",
  };
}

function trustLevel(minScore: number | null): "high" | "medium" | "low" | "unknown" {
  if (minScore === null) return "unknown";
  if (minScore >= 0.8) return "high";
  if (minScore >= 0.6) return "medium";
  return "low";
}

function lintStatusFromTrust(trustScores: Array<TrustScore | null>): "passed" | "warning" | "failed" | "unknown" {
  const known = trustScores.filter((score): score is TrustScore => Boolean(score));
  if (known.length === 0) return "unknown";
  if (known.some((score) => score.status === "blocked")) return "failed";
  if (known.some((score) => score.status === "needs_review" || score.status === "usable_with_risk")) return "warning";
  return "passed";
}

function latestIso(values: string[]): string | null {
  const sorted = values.filter(Boolean).sort();
  return sorted.length ? sorted[sorted.length - 1] : null;
}

function ruleProfileHashFromRelease(release: ReleaseRecord): string {
  const manifest = release.manifest as Record<string, unknown>;
  const qualityGate = release.qualityGate as Record<string, unknown>;
  return String(
    manifest.activeRuleProfileHash
      ?? manifest.legislationProfileHash
      ?? qualityGate.legislationProfileHash
      ?? "",
  );
}

function envelopeContract(toolName: string, evidenceIds: string[]): KnowledgeEnvelope["contract"] {
  return {
    schemaVersion: "knowledge-envelope/v1",
    toolName,
    stableFields: ["contract", "release", "result", "qualityFlags", "trust", "trace"],
    capabilities: {
      trust: "included",
      evidence: evidenceIds.length > 0 ? "linked" : "none",
      graph: GRAPH_TOOLS.has(toolName) ? "available" : "not_applicable",
      tables: TABLE_TOOLS.has(toolName) ? "available" : "not_applicable",
      feedback: REPORT_TOOLS.has(toolName) ? "explicit_report" : "auto_recorded",
    },
  };
}

function releaseSourceVersionIds(release: ReleaseRecord): string[] {
  const manifestSources = jsonArray((release.manifest as Record<string, unknown>).sourceVersionIds);
  const packageSources = Array.isArray((release.manifest as Record<string, unknown>).packages)
    ? ((release.manifest as Record<string, unknown>).packages as Array<Record<string, unknown>>).flatMap((pkg) => jsonArray(pkg.sourceVersionIds))
    : [];
  return uniqueSorted([...manifestSources, ...packageSources]);
}

function flywheelGateReasons(input: {
  latestBuild: Record<string, unknown> | null;
  blockingTasks: number;
  pendingReviewTasks: number;
  pendingCorrections: number;
  lintSummary: { pending: number; failed: number; needsHuman: number };
}): string[] {
  const reasons: string[] = [];
  if (!input.latestBuild?.packageId) reasons.push("no_completed_build_package");
  if (input.blockingTasks > 0) reasons.push("blocking_tasks");
  if (input.pendingReviewTasks > 0) reasons.push("pending_review_tasks");
  if (input.pendingCorrections > 0) reasons.push("pending_corrections");
  if (input.lintSummary.pending > 0) reasons.push("lint_pending");
  if (input.lintSummary.failed > 0) reasons.push("lint_failed");
  if (input.lintSummary.needsHuman > 0) reasons.push("lint_needs_human");
  return reasons;
}

function healthBlockingReasons(input: {
  blockingTasks: number;
  pendingCorrections: number;
  lintSummary: { pending: number; failed: number; needsHuman: number };
}): string[] {
  const reasons: string[] = [];
  if (input.blockingTasks > 0) reasons.push("blocking_tasks");
  if (input.pendingCorrections > 0) reasons.push("pending_corrections");
  if (input.lintSummary.failed > 0) reasons.push("lint_failed");
  if (input.lintSummary.needsHuman > 0) reasons.push("lint_needs_human");
  return reasons;
}

function healthWarningReasons(input: {
  pendingReviewTasks: number;
  negativeFeedback: number;
  lowTrustCount: number;
  staleAuditCount: number;
  activeCorrections: number;
  lintSummary: { pending: number; failed: number; needsHuman: number };
}): string[] {
  const reasons: string[] = [];
  if (input.pendingReviewTasks > 0) reasons.push("pending_review_tasks");
  if (input.negativeFeedback > 0) reasons.push("negative_feedback");
  if (input.lowTrustCount > 0) reasons.push("low_trust_components");
  if (input.staleAuditCount > 0) reasons.push("stale_audit_components");
  if (input.activeCorrections > 0) reasons.push("active_corrections_waiting_rebuild");
  if (input.lintSummary.pending > 0) reasons.push("lint_pending");
  return reasons;
}

function healthSummary(status: string, version: string, blockingCount: number, warningCount: number): string {
  if (status === "passed") return `发布 ${version} 当前可供 Agent 消费，未发现阻断项。`;
  if (status === "needs_attention") return `发布 ${version} 存在 ${blockingCount} 类阻断项，Agent 可查询但应谨慎采纳。`;
  return `发布 ${version} 可消费，但存在 ${warningCount} 类风险，建议 Agent 按推荐动作继续治理。`;
}

function healthRecommendations(
  projectId: string,
  blockingReasons: string[],
  warningReasons: string[],
  samples: {
    pendingCorrections: HealthCorrectionSummary[];
    activeCorrections: HealthCorrectionSummary[];
    lowTrust: HealthComponentSummary[];
    staleAudit: HealthComponentSummary[];
  } = { pendingCorrections: [], activeCorrections: [], lowTrust: [], staleAudit: [] },
): Array<{ action: string; tool: string; reason: string; payload?: Record<string, unknown> }> {
  const reasons = new Set([...blockingReasons, ...warningReasons]);
  const out: Array<{ action: string; tool: string; reason: string; payload?: Record<string, unknown> }> = [];
  const pending = samples.pendingCorrections[0];
  if (reasons.has("pending_corrections") && pending) {
    out.push({
      action: "govern_pending_correction",
      tool: "kb_govern_flywheel",
      reason: "存在待应用修正；使用一键治理让服务端按顺序激活修正、增量检查并尝试门禁发布。",
      payload: { projectId, correctionId: pending.correctionId },
    });
  }
  const active = samples.activeCorrections[0];
  if (reasons.has("active_corrections_waiting_rebuild") && active) {
    out.push({
      action: "govern_active_correction",
      tool: "kb_govern_flywheel",
      reason: "存在已激活修正；跳过重复应用，继续 scoped rebuild/check 与发布门禁判断。",
      payload: { projectId, correctionId: active.correctionId, apply: false, componentId: active.componentId || undefined },
    });
  }
  if (reasons.has("lint_pending")) {
    out.push({
      action: "run_pending_lint_remediations",
      tool: "kb_start_incremental_check",
      reason: "存在待自动治理的 Knowledge Lint 项；让服务端按治理队列启动 scoped rebuild。",
      payload: { projectId, runPendingLintRemediations: true },
    });
  }
  if (reasons.has("lint_failed") || reasons.has("lint_needs_human")) {
    out.push({ action: "inspect_exceptions", tool: "kb_get_flywheel_status", reason: "Knowledge Lint 治理项需要先处理，自动发布门禁不会绕过。", payload: { projectId } });
  }
  const weak = samples.lowTrust[0] ?? samples.staleAudit[0];
  if (reasons.has("low_trust_components") || reasons.has("stale_audit_components") || reasons.has("negative_feedback")) {
    out.push({
      action: "submit_correction_or_feedback",
      tool: "kb_govern_flywheel",
      reason: "低可信、审计过期或负反馈应由 Agent 提交修正并触发增量检查。",
      payload: { projectId, ...(weak ? { componentId: weak.componentId } : {}) },
    });
  }
  if (out.length === 0) out.push({ action: "publish_if_ready", tool: "kb_publish_if_ready", reason: "未发现阻断项，可请求系统按门禁判断是否发布修订。", payload: { projectId } });
  return out;
}

function healthComponent(component: { componentId: string; artifactId: string; title: string; kind: string; trust: TrustScore | KnowledgeEnvelopeTrustScore | null }): HealthComponentSummary {
  return {
    componentId: component.componentId,
    artifactId: component.artifactId,
    title: component.title,
    kind: component.kind,
    score: component.trust?.score ?? null,
    status: component.trust?.status ?? "unknown",
    lastTrustedAuditAt: component.trust?.lastTrustedAuditAt ?? null,
  };
}

function healthCorrection(correction: SourceCorrectionView): HealthCorrectionSummary {
  return {
    correctionId: correction.correctionId,
    state: correction.state,
    componentId: correction.componentId ?? "",
    packageId: correction.packageId ?? "",
    sourcePath: correction.sourcePath,
    ruleId: correction.ruleId,
    factKey: correction.factKey,
    updatedAt: correction.updatedAt,
  };
}

function auditIsStale(lastTrustedAuditAt: string | null, maxAuditAgeDays: number): boolean {
  if (!lastTrustedAuditAt) return true;
  const at = Date.parse(lastTrustedAuditAt);
  if (!Number.isFinite(at)) return true;
  return Date.now() - at > maxAuditAgeDays * 24 * 60 * 60 * 1000;
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

function optionalNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(numeric) ? numeric : null;
}

function numberArg(payload: Record<string, unknown>, fallback: number, ...keys: string[]): number {
  for (const key of keys) {
    const value = payload[key];
    const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
    if (Number.isFinite(numeric)) return numeric;
  }
  return fallback;
}

function boundedScoreArg(payload: Record<string, unknown>, fallback: number, ...keys: string[]): number {
  const value = numberArg(payload, fallback, ...keys);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function booleanArg(payload: Record<string, unknown>, fallback: boolean, ...keys: string[]): boolean {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes"].includes(normalized)) return true;
      if (["false", "0", "no"].includes(normalized)) return false;
    }
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

function normalizeCorrectionValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { value };
}

function normalizeSourcePath(value: string): string {
  return value.trim().replace(/\\/gu, "/").replace(/^processed\/parsed\//u, "");
}

function sourceCorrectionFactKey(value: Record<string, unknown>): string | null {
  const direct = String(value.factKey ?? value.fact_key ?? value.field ?? value.key ?? "").trim();
  return direct || null;
}

function sourceCorrectionRecord(row: Record<string, unknown>): SourceCorrectionView {
  return {
    correctionId: String(row.correction_id ?? ""),
    projectId: String(row.project_id ?? "default_project"),
    bundleId: String(row.bundle_id ?? ""),
    sourcePath: String(row.source_path ?? ""),
    ruleId: String(row.rule_id ?? ""),
    pageType: String(row.page_type ?? ""),
    factKey: row.fact_key ? String(row.fact_key) : null,
    boundSourceHash: String(row.bound_source_hash ?? ""),
    state: String(row.state ?? ""),
    correctValue: jsonObject(row.correct_value),
    componentId: row.component_id ? String(row.component_id) : null,
    packageId: row.package_id ? String(row.package_id) : null,
    exampleId: String(row.example_id ?? ""),
    taskId: String(row.task_id ?? ""),
    createdBy: String(row.created_by ?? ""),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

function componentSummary(component: AssetComponent): Record<string, unknown> {
  return {
    componentId: component.componentId,
    packageId: component.packageId,
    artifactId: component.artifactId,
    title: component.title,
    kind: component.kind,
    legacyPath: component.legacyPath,
    sourceRefs: component.sourceRefs,
  };
}

function correctionTargetForComponent(component: AssetComponent, requestedSourcePath: string, matchMethod: CorrectionAnchorMatchMethod): CorrectionTarget {
  const componentSourcePath = normalizeSourcePath(
    component.sourceRefs.find((ref) => sourceRefLooksLikeSource(ref)) ??
    "",
  );
  const normalizedRequestedSourcePath = normalizeSourcePath(requestedSourcePath);
  const usableRequestedSourcePath = sourceRefLooksLikeSource(normalizedRequestedSourcePath) ? normalizedRequestedSourcePath : "";
  const sourcePath = usableRequestedSourcePath || componentSourcePath || `component:${component.componentId}`;
  const fallback = sourcePath.startsWith("component:");
  return {
    component,
    sourcePath,
    anchor: {
      componentId: component.componentId,
      sourcePath,
      matchMethod: fallback ? "component_fallback" : matchMethod,
      candidates: [],
      confidence: fallback ? "low" : matchMethod === "sourcePath_unique" ? "medium" : "high",
    },
  };
}

function sourceRefLooksLikeSource(value: string): boolean {
  const normalized = normalizeSourcePath(value);
  return normalized.startsWith("gamedocs/") || normalized.startsWith("gamedata/");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "") || "item";
}

function searchCard(item: OkfSearchResultItem, index: number, evidenceCount: number, match: SearchMatchClassification): Record<string, unknown> {
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
      matchStatus: index === 0 ? match.status : "supporting_hit",
      missingCoreTerms: index === 0 ? match.missingCoreTerms : [],
      qualityFlags: index === 0 ? match.qualityFlags : [],
      why: item.why,
    },
    suggestedNextTools: pageSuggestedTools(item),
    nextStep: nextStepForSearchItem(item, evidenceCount, unresolvedDependencies),
  };
}

function searchGuidance(query: string, items: OkfSearchResultItem[], evidenceCounts: Map<string, number>, match: SearchMatchClassification): Record<string, unknown> {
  const top = items[0];
  if (!top) {
    return {
      status: "miss",
      nextStep: `No published knowledge matched "${query}". Report a knowledge gap or import/build source material, then publish again.`,
      suggestedNextTools: ["kb_resolve_topic"],
    };
  }
  if (match.status !== "hit") {
    return {
      status: match.status,
      topComponentId: top.componentId,
      qualityFlags: match.qualityFlags,
      missingCoreTerms: match.missingCoreTerms,
      nextStep: `Only weak/partial matches were found for "${query}". Treat this as insufficient for final answers; call kb_report_gap if the missing topic matters, or refine the query.`,
      suggestedNextTools: ["kb_get_page", "kb_get_evidence", "kb_report_gap"],
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

const GENERIC_SEARCH_TERMS = new Set([
  "系统", "流程", "结构", "活动", "玩法", "规则", "配置", "配置表", "表", "字段", "数据", "资料", "知识",
  "system", "flow", "process", "structure", "activity", "config", "table", "field", "data", "rule",
]);

function classifySearchMatch(query: string, items: OkfSearchResultItem[]): SearchMatchClassification {
  const top = items[0];
  const coreTerms = tokenizeSearchText(query)
    .filter((term) => term.length >= 2)
    .filter((term) => !GENERIC_SEARCH_TERMS.has(term))
    .slice(0, 20);
  const matched = new Set((top?.matchedTerms ?? []).map(String));
  const matchedCoreTerms = uniqueSorted(coreTerms.filter((term) => matched.has(term)));
  const missingCoreTerms = uniqueSorted(coreTerms.filter((term) => !matched.has(term)));
  const missingCoreSignal = top?.why.some((line) => line.includes("缺少核心词")) ?? false;
  if (!top) {
    return { status: "near_miss", qualityFlags: [], coreTerms, matchedCoreTerms, missingCoreTerms };
  }
  if ((coreTerms.length > 0 && matchedCoreTerms.length === 0) || missingCoreSignal) {
    return {
      status: "near_miss",
      qualityFlags: ["weak_match", "missing_core_terms"],
      coreTerms,
      matchedCoreTerms,
      missingCoreTerms,
    };
  }
  if (coreTerms.length >= 4 && matchedCoreTerms.length / coreTerms.length < 0.35) {
    return {
      status: "low_confidence_hit",
      qualityFlags: ["weak_match"],
      coreTerms,
      matchedCoreTerms,
      missingCoreTerms,
    };
  }
  return { status: "hit", qualityFlags: [], coreTerms, matchedCoreTerms, missingCoreTerms: [] };
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

function inferTableFieldMapping(schema: TableSchema, grid: unknown[][]): {
  fieldMap: Record<string, TableFieldMapping>;
  rawKeys: string[];
  headerRowIndex: number;
  dataStartIndex: number;
  unmappedRawColumns: string[];
  diagnostics: string[];
} {
  const fields = schema.fields ?? [];
  const maxCols = grid.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), fields.length);
  const headerRowIndex = chooseHeaderRow(fields, grid);
  const labelRowIndex = chooseLabelRow(grid, headerRowIndex);
  const rawKeys = uniqueRawKeys(Array.from({ length: maxCols }, (_, columnIndex) => {
    const label = normalizeCellValue(grid[labelRowIndex]?.[columnIndex]);
    const header = normalizeCellValue(grid[headerRowIndex]?.[columnIndex]);
    return label || header || `column_${columnIndex + 1}`;
  }));
  const fieldMap: Record<string, TableFieldMapping> = {};
  const usedColumns = new Set<number>();
  const fieldByKey = new Map(fields.map((field) => [aliasKey(field), field] as const));
  const headerRow = grid[headerRowIndex] ?? [];

  for (let columnIndex = 0; columnIndex < maxCols; columnIndex += 1) {
    const headerValue = normalizeCellValue(headerRow[columnIndex]);
    const field = fieldByKey.get(aliasKey(headerValue));
    if (!field || fieldMap[field]) continue;
    fieldMap[field] = { rawKey: rawKeys[columnIndex], columnIndex, headerValue, matchMethod: "header" };
    usedColumns.add(columnIndex);
  }

  for (const [fieldIndex, field] of fields.entries()) {
    if (fieldMap[field]) continue;
    if (fieldIndex >= maxCols || usedColumns.has(fieldIndex)) continue;
    fieldMap[field] = {
      rawKey: rawKeys[fieldIndex],
      columnIndex: fieldIndex,
      headerValue: normalizeCellValue(headerRow[fieldIndex]),
      matchMethod: "schema_order",
    };
    usedColumns.add(fieldIndex);
  }

  const unmappedRawColumns = rawKeys.filter((rawKey, columnIndex) =>
    !usedColumns.has(columnIndex) && grid.some((row) => normalizeCellValue(row[columnIndex]) !== "")
  );
  const missingFields = fields.filter((field) => !(field in fieldMap));
  const diagnostics: string[] = [];
  if (fields.length === 0) diagnostics.push("schema has no fields");
  const orderedFallbackFields = Object.entries(fieldMap)
    .filter(([, mapping]) => mapping.matchMethod === "schema_order")
    .map(([field]) => field);
  if (orderedFallbackFields.length > 0) {
    diagnostics.push(`mapped by schema field order: ${orderedFallbackFields.join(", ")}`);
  }
  if (missingFields.length > 0) diagnostics.push(`unmapped schema fields: ${missingFields.join(", ")}`);
  if (unmappedRawColumns.length > 0) diagnostics.push(`unmapped raw columns: ${unmappedRawColumns.join(", ")}`);

  return {
    fieldMap,
    rawKeys,
    headerRowIndex,
    dataStartIndex: Math.min(grid.length, headerRowIndex + 1),
    unmappedRawColumns,
    diagnostics,
  };
}

function chooseHeaderRow(fields: string[], grid: unknown[][]): number {
  if (grid.length === 0) return 0;
  const fieldKeys = new Set(fields.map(aliasKey));
  let best = { row: 0, score: -1 };
  const scanRows = Math.min(grid.length, 12);
  for (let rowIndex = 0; rowIndex < scanRows; rowIndex += 1) {
    const row = grid[rowIndex] ?? [];
    const nonEmpty = row.map(normalizeCellValue).filter(Boolean);
    if (nonEmpty.length === 0) continue;
    const directMatches = nonEmpty.filter((value) => fieldKeys.has(aliasKey(value))).length;
    const technicalNames = nonEmpty.filter((value) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)).length;
    const score = directMatches * 20 + technicalNames - Math.max(0, nonEmpty.length - fields.length);
    if (score > best.score) best = { row: rowIndex, score };
  }
  return best.row;
}

function chooseLabelRow(grid: unknown[][], headerRowIndex: number): number {
  for (let rowIndex = 0; rowIndex < headerRowIndex; rowIndex += 1) {
    if ((grid[rowIndex] ?? []).some((value) => normalizeCellValue(value) !== "")) return rowIndex;
  }
  return headerRowIndex;
}

function uniqueRawKeys(keys: string[]): string[] {
  const seen = new Map<string, number>();
  return keys.map((key, index) => {
    const normalized = key || `column_${index + 1}`;
    const count = seen.get(normalized) ?? 0;
    seen.set(normalized, count + 1);
    return count === 0 ? normalized : `${normalized}_${count + 1}`;
  });
}

function rawRowFromGridRow(row: unknown[], rawKeys: string[]): Record<string, unknown> {
  return Object.fromEntries(rawKeys.map((rawKey, columnIndex) => [rawKey, row[columnIndex] ?? ""]));
}

function normalizeCellValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value).trim();
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
    description: yamlScalar(frontmatter, "description"),
    type: yamlScalar(frontmatter, "type") || "knowledge_note",
    componentId,
    packageId: yamlScalar(frontmatter, "packageId"),
    artifactId,
    kind: okfKind(frontmatter, artifactId),
    trust: parseOkfTrust(frontmatter),
    citations: parseOkfCitations(body, componentId, okfPath),
  };
}

function pageLookupKeys(page: OkfPage): string[] {
  const basename = page.okfPath.split("/").pop() ?? "";
  return uniqueOrdered([
    page.componentId,
    page.title,
    stripMarkdownExtension(page.title),
    page.description,
    firstMarkdownHeading(page.body),
    page.artifactId,
    stripMarkdownExtension(page.artifactId),
    page.artifactId.replace(/^wiki\//u, ""),
    stripMarkdownExtension(page.artifactId.replace(/^wiki\//u, "")),
    page.okfPath,
    page.okfPath.replace(/^\//u, ""),
    basename,
    stripMarkdownExtension(basename),
  ]).filter(Boolean);
}

function stripMarkdownExtension(value: string): string {
  return value.replace(/\.md$/iu, "");
}

function firstMarkdownHeading(markdown: string): string {
  return /^#\s+(.+?)\s*$/mu.exec(markdown)?.[1]?.trim() ?? "";
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
  if (isGenericDependencyKey(key)) return [];
  const aliased = aliases.get(key);
  if (aliased?.length) return aliased;
  const containedSchemas = [...schemasByName.entries()]
    .filter(([tableKey]) => tableKey.length >= 4 && key.includes(tableKey))
    .map(([, entry]) => entry);
  if (containedSchemas.length) return uniqueTableEntries(containedSchemas);
  const containedAliases = [...aliases.entries()]
    .filter(([alias]) => actionableAliasKey(alias) && key.includes(alias))
    .flatMap(([, entries]) => entries);
  return uniqueTableEntries(containedAliases);
}

function schemaEntriesForAliasTarget(value: string, schemasByName: Map<string, TableSchemaEntry>): TableSchemaEntry[] {
  const key = aliasKey(value);
  if (!key) return [];
  const exact = schemasByName.get(key);
  if (exact) return [exact];
  if (isGenericDependencyKey(key)) return [];
  if (!actionableAliasKey(key)) return [];
  const candidates = [...schemasByName.entries()]
    .filter(([tableKey]) => tableKey.includes(key))
    .map(([, entry]) => entry)
    .sort((a, b) => a.schema.table_name.length - b.schema.table_name.length || a.schema.table_name.localeCompare(b.schema.table_name));
  return uniqueTableEntries(candidates.slice(0, 12));
}

function actionableAliasKey(value: string): boolean {
  return value.length >= 4 || /[\p{Script=Han}]{2,}/u.test(value);
}

function isGenericDependencyKey(value: string): boolean {
  return ["config", "配置", "table", "表", "data", "数据", "配置表", "config表"].includes(value);
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
