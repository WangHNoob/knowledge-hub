import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import { nanoid } from "nanoid";
import xlsx from "xlsx";

import type { AssetComponent, AssetPackage, DatabaseHandle, KnowledgeEnvelope, KnowledgeEnvelopeTrustScore, KnowledgeTrace, ReleaseRecord, TrustScore } from "../types";
import { jsonArray, jsonObject, mapComponent, mapPackage } from "../db/mappers";
import { createAttributionAuditService } from "./attributionAuditService";
import type { DiagnosticLogger } from "./diagnosticService";
import { createFeedbackService, type FeedbackService, type FeedbackType } from "./feedbackService";
import { createReleaseService, type AutoPublishCheck } from "./releaseService";
import { createKbBuilderPipelineService } from "./kbBuilderService";
import { createLintRemediationService } from "./lintRemediationService";
import { createGovernanceProfileService, type GovernanceProfileService } from "./governanceProfileService";
import { emitKnowledgeEvent } from "./eventService";
import { createSourceBundleService } from "./sourceBundleService";
import { createProjectService } from "./projectService";
import { createKnowledgeService } from "./knowledgeService";
import { createFlywheelService, type FlywheelService } from "./flywheelService";
import { createTaskPolicyService } from "./taskPolicyService";
import { isComponentVisibleToRole } from "./knowledgeAcl";
import { searchOkfIndex, tokenizeSearchText, type OkfSearchIndex, type OkfSearchResultItem } from "./okf/searchIndex";
import { fuseSearchWithRrf, searchDenseIndex } from "./okf/hybridSearch";
import { scoreFromQuality, trustFromQuality } from "./trustScore";
import { OkfBundleReader } from "./kbQuery/OkfBundleReader.js";
import { KbGraphTools } from "./kbQuery/KbGraphTools.js";
import { KbGovernanceTools } from "./kbQuery/KbGovernanceTools.js";
import {
  aliasKey,
  booleanArg,
  boundedLimitArg,
  classifySearchMatch,
  dependencyCandidates,
  dependencyHint,
  dependencyLines,
  emptyTrustSummary,
  envelopeContract,
  extractDependencyText,
  extractSection,
  inferTableFieldMapping,
  latestIso,
  lintStatusFromTrust,
  looksLikeDependencyToken,
  manifestComponentIds,
  nextStepForTarget,
  normalize,
  normalizeCellValue,
  numberArg,
  objectArg,
  optionalString,
  pageLookupKeys,
  pageSuggestedTools,
  rawRowFromGridRow,
  releaseEnvelope,
  releaseSourceVersionIds,
  releaseSummary,
  resolveCandidateTables,
  round,
  ruleProfileHashFromRelease,
  same,
  schemaEntriesForAliasTarget,
  scoreText,
  searchCard,
  searchGuidance,
  slimTraceArrays,
  slimTrustEnvelope,
  snippet,
  stringArg,
  trustLevel,
  uniqueOrdered,
  uniqueSorted,
  uniqueTableEntries,
} from "./kbQuery/utils.js";

const EVIDENCE_REQUIRED_COMPONENT_KINDS = new Set(["wiki_page"]);
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
  "kb_rollback_release",
]);

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
  private readonly okfReader: OkfBundleReader;
  private readonly graphTools: KbGraphTools;
  private readonly govTools: KbGovernanceTools;
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
    this.okfReader = new OkfBundleReader(dataDir);
    this.graphTools = new KbGraphTools({
      adapter: db.adapter,
      okfReader: this.okfReader,
      shared: {
        releaseComponents: (release, kinds) => this.releaseComponents(release, kinds),
        readComponentText: (component) => this.readComponentText(component),
        releasePackages: (release) => this.releasePackages(release),
      },
    });
    this.govTools = new KbGovernanceTools({
      db,
      adapter: db.adapter,
      diagnostics,
      releaseService: this.releaseService,
      builderService: this.builderService,
      lintRemediationService: this.lintRemediationService,
      attributionAuditService: this.attributionAuditService,
      governanceProfileService: this.governanceProfileService,
      flywheel: () => this.flywheel(),
      shared: {
        trustSummaryForComponents: (release, componentIds) => this.trustSummaryForComponents(release, componentIds),
      },
    });
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
      const toolResult = await this.executeTool(release, toolName, payload, context);
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
        return this.govTools.kbListProjects(projectId);
      case "kb_get_flywheel_status":
        return this.govTools.kbGetFlywheelStatus(projectId);
      case "kb_run_health_check":
        return this.govTools.kbRunHealthCheck(projectId, payload, context);
      case "kb_submit_correction":
        return this.govTools.kbSubmitCorrection(projectId, payload, context);
      case "kb_apply_correction":
        return this.govTools.kbApplyCorrection(projectId, stringArg(payload, "correctionId"), context, optionalString(payload, "note"));
      case "kb_start_incremental_check":
        return this.govTools.kbStartIncrementalCheck(projectId, payload, context);
      case "kb_publish_if_ready":
        return this.govTools.kbPublishIfReady(projectId, payload, context);
      case "kb_get_correction_status":
        return this.govTools.kbGetCorrectionStatus(projectId, stringArg(payload, "correctionId"));
      case "kb_govern_flywheel":
        return this.govTools.kbGovernFlywheel(projectId, payload, context);
      case "kb_submit_attribution":
        return this.govTools.kbSubmitAttribution(projectId, payload, context);
      case "kb_list_feedback_clusters":
        return this.govTools.kbListFeedbackClusters(projectId);
      case "kb_rollback_release":
        return this.govTools.kbRollbackRelease(projectId, payload, context);
      default:
        throw new Error(`Unknown Knowledge MCP governance tool: ${toolName}`);
    }
  }

  private async executeTool(release: ReleaseRecord, toolName: string, payload: Record<string, unknown>, context: KnowledgeQueryContext = {}): Promise<ToolResult> {
    switch (toolName) {
      case "kb_get_release":
        return { result: releaseSummary(release, booleanArg(payload, false, "includeManifest", "manifest"), numberArg(payload, 30, "manifestLimit", "limit")), componentIds: [], forceHit: true };
      case "kb_search":
        return this.kbSearch(release, stringArg(payload, "query", "q"), numberArg(payload, 10, "limit", "topK", "top_k"), context.agentRole);
      case "kb_resolve_topic":
        return this.kbResolveTopic(release, stringArg(payload, "topic", "query", "q"));
      case "kb_get_page":
        return this.kbGetPage(release, stringArg(payload, "componentId", "page", "title", "topic"));
      case "kb_get_section":
        return this.kbGetSection(release, stringArg(payload, "componentId", "page", "title", "topic"), stringArg(payload, "section"));
      case "kb_list_pages":
        return this.kbListPages(release);
      case "kb_get_index":
        return this.kbGetIndex(release);
      case "kb_get_page_tables":
        return this.kbGetPageTables(release, stringArg(payload, "componentId", "page", "title", "topic"));
      case "kb_get_entity":
        return this.graphTools.kbGetEntity(release, stringArg(payload, "entityId", "id", "name"));
      case "kb_get_neighbors":
        return this.graphTools.kbGetNeighbors(release, stringArg(payload, "entityId", "id", "name"));
      case "kb_list_entities":
        return this.graphTools.kbListEntities(release, optionalString(payload, "type"));
      case "kb_get_relations":
        return this.graphTools.kbGetRelations(release, optionalString(payload, "source"), optionalString(payload, "target"), optionalString(payload, "relation"));
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

  private async kbSearch(release: ReleaseRecord, query: string, limit = 10, agentRole?: string): Promise<ToolResult> {
    const boundedLimit = boundedLimitArg(limit, 10, 50);
    const indexItems = await this.kbSearchIndex(release, query, boundedLimit, agentRole);
    if (indexItems.length > 0) {
      const match = classifySearchMatch(query, indexItems);
      return {
        result: await this.searchResultPayload(release, query, indexItems),
        componentIds: indexItems.map((item) => item.componentId),
        artifactIds: indexItems.map((item) => item.artifactId),
        qualityFlags: match.qualityFlags,
      };
    }
    return this.kbSearchMarkdownFallback(release, query, boundedLimit, agentRole);
  }

  private async kbSearchIndex(release: ReleaseRecord, query: string, limit: number, agentRole?: string): Promise<OkfSearchResultItem[]> {
    const index = this.okfReader.readOkfSearchIndex(release);
    if (!index) return [];
    const lexical = searchOkfIndex(index, query, Math.max(limit * 2, 20));
    const dense = this.okfReader.readOkfDenseIndex(release);
    let candidates: OkfSearchResultItem[];
    if (!dense || dense.vectors.length === 0) {
      candidates = lexical.slice(0, Math.max(limit * 2, 20));
    } else {
      const denseRanks = searchDenseIndex(dense, query, Math.max(limit * 2, 20));
      const pageById = new Map(index.pages.map((page) => [page.componentId, page] as const));
      candidates = fuseSearchWithRrf(lexical, denseRanks, pageById, Math.max(limit * 2, 20));
    }
    const visible = await this.filterSearchItemsByDbVisibility(candidates, agentRole);
    return this.alignSearchItemsWithPageTables(release, visible.slice(0, limit));
  }

  private async filterSearchItemsByDbVisibility(items: OkfSearchResultItem[], agentRole?: string): Promise<OkfSearchResultItem[]> {
    if (items.length === 0) return items;
    const ids = items.map((item) => item.componentId);
    const placeholders = ids.map((_, index) => `$${index + 1}`).join(",");
    const { rows } = await this.adapter.query(
      `SELECT component_id, quality FROM asset_components WHERE component_id IN (${placeholders})`,
      ids,
    );
    const qualityById = new Map(rows.map((row) => [String(row.component_id), jsonObject(row.quality)] as const));
    return items.filter((item) => isComponentVisibleToRole(qualityById.get(item.componentId) ?? {}, agentRole));
  }

  private async kbSearchMarkdownFallback(release: ReleaseRecord, query: string, limit: number, agentRole?: string): Promise<ToolResult> {
    const needle = query.toLowerCase();
    const pages = this.okfReader.readOkfPages(release);
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
    const visible = await this.filterSearchItemsByDbVisibility(items, agentRole);
    const limited = await this.alignSearchItemsWithPageTables(release, visible.slice(0, limit));
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
      retrieval: {
        mode: items.some((item) => item.matchedFields.includes("dense")) ? "hybrid_rrf" : "lexical",
        lexical: true,
        dense: items.some((item) => item.matchedFields.includes("dense")),
      },
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
    const entity = this.graphTools.findGraphNodeSafe(release, topic);
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
    const pages = this.okfReader.readOkfPages(release);
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

  /** 读取发布物目录 index.md（按模块分组、含一句话描述与关联配表），供 Agent 先查目录再定位。 */
  private async kbGetIndex(release: ReleaseRecord): Promise<ToolResult> {
    const full = this.okfReader.okfBundleFile(release, "index.md");
    if (!existsSync(full)) {
      return { result: { found: false, reason: "release bundle has no index.md" }, componentIds: [], forceHit: true };
    }
    const content = readFileSync(full, "utf8");
    return {
      result: { found: true, okfPath: "/index.md", releaseId: release.releaseId, content },
      componentIds: [],
      forceHit: true,
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
    const pagesByComponent = new Map(this.okfReader.readOkfPages(release).map((page) => [page.componentId, page] as const));
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
    for (const row of this.okfReader.readOkfTableAliases(release)) {
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
      const graph = await this.graphTools.readGraph(release);
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


  private async tableSchemas(release: ReleaseRecord): Promise<Array<{ component: KnowledgeAssetRef; schema: TableSchema; sourceVersionIds?: string[] }>> {
    const okfSchemas = this.okfReader.readOkfTableSchemas(release);
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


  private async findOkfPage(release: ReleaseRecord, page: string): Promise<OkfPage | null> {
    const normalized = normalize(page);
    const pages = this.okfReader.readOkfPages(release);
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
    return this.okfReader.readOkfPages(release).flatMap((page) => wanted.has(page.componentId) ? page.citations : []);
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
    for (const row of this.okfReader.readOkfTableAliases(release)) {
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


  /**
   * 供后台周期调度器（registerHealthSweepScheduler）调用的知识健康巡检入口。
   * 对某项目运行一次 lint / trust / 过期审计（auditIsStale 是时间相关的，只有定期触发才能
   * 及时发现「知识过期」）检查，结果落 knowledge_lint.health_checked 事件进入自动化历史，可审阅。
   * 复用 kbRunHealthCheck 的全部逻辑与事件发射，仅在 actor 与调用场景上区别于 MCP 手动调用。
   */
  async runScheduledHealthCheck(projectId: string, actor = "health-sweep-scheduler"): Promise<{ projectId: string; status: string }> {
    // 预设规则任务收敛（info 自动 dismiss + gap_fill 无源自动收敛）——不依赖人工。
    const policy = await createTaskPolicyService(this.db).applyOpenTaskPolicies(projectId);
    if (policy.dismissedTasks > 0 || policy.dismissedGapFill > 0) {
      await this.diagnostics?.write({
        traceId: "",
        level: "info",
        category: "flywheel",
        message: "task policy auto-converged open items",
        status: "completed",
        actor,
        entityType: "project",
        entityId: projectId,
        context: { projectId, dismissedTasks: policy.dismissedTasks, dismissedGapFill: policy.dismissedGapFill },
      });
    }
    const outcome = await this.govTools.kbRunHealthCheck(projectId, {}, { sessionId: actor });
    const status = typeof (outcome.result as { status?: unknown })?.status === "string"
      ? String((outcome.result as { status?: unknown }).status)
      : "unknown";
    return { projectId, status };
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
    for (const page of this.okfReader.readOkfPages(release)) {
      if (wanted.has(page.componentId)) out.set(page.componentId, page.trust);
    }
    const graph = this.okfReader.readOkfGraph(release);
    if (graph && wanted.has(graph.componentId)) out.set(graph.componentId, graph.trust ?? null);
    for (const entry of this.okfReader.readOkfTableSchemas(release)) {
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

