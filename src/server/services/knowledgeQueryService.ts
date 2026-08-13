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
import { KbEnvelopeAssembler } from "./kbQuery/KbEnvelopeAssembler.js";
import { KbGraphTools } from "./kbQuery/KbGraphTools.js";
import { KbGovernanceTools } from "./kbQuery/KbGovernanceTools.js";
import { KbSearchTools } from "./kbQuery/KbSearchTools.js";
import { KbPageTools } from "./kbQuery/KbPageTools.js";
import { KbTableTools } from "./kbQuery/KbTableTools.js";
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
  private readonly envelope: KbEnvelopeAssembler;
  private readonly graphTools: KbGraphTools;
  private readonly govTools: KbGovernanceTools;
  private readonly searchTools: KbSearchTools;
  private readonly pageTools: KbPageTools;
  private readonly tableTools: KbTableTools;
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
    this.envelope = new KbEnvelopeAssembler({ adapter: db.adapter, okfReader: this.okfReader });
    // 域类：table 无外部依赖先建；graph/search/page 间经 bindDomains 晚绑定（构造期不调用）
    this.tableTools = new KbTableTools({
      adapter: db.adapter,
      dataDir,
      sourceService: this.sourceService,
      okfReader: this.okfReader,
    });
    this.graphTools = new KbGraphTools({
      adapter: db.adapter,
      okfReader: this.okfReader,
      shared: {
        releaseComponents: (release, kinds) => this.tableTools.releaseComponents(release, kinds),
        readComponentText: (component) => this.tableTools.readComponentText(component),
        releasePackages: (release) => this.tableTools.releasePackages(release),
      },
    });
    this.searchTools = new KbSearchTools({
      adapter: db.adapter,
      okfReader: this.okfReader,
      graphTools: this.graphTools,
      shared: {
        evidenceCountsForComponents: (release, componentIds) => this.envelope.evidenceCountsForComponents(release, componentIds),
      },
    });
    this.pageTools = new KbPageTools({
      okfReader: this.okfReader,
      graphTools: this.graphTools,
    });
    this.searchTools.bindDomains(this.pageTools, this.tableTools);
    this.pageTools.bindDomains(this.searchTools, this.tableTools);
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
        trustSummaryForComponents: (release, componentIds) => this.envelope.trustSummaryForComponents(release, componentIds),
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
      const okfEvidenceRecords = this.envelope.okfEvidenceRecordsForComponents(release, hitComponentIds);
      const dbEvidenceRecords = await this.envelope.evidenceRecordsForComponents(hitComponentIds);
      const trust = await this.envelope.trustSummaryForComponents(release, hitComponentIds);
      const evidenceIds = toolResult.evidenceIds ?? uniqueSorted([
        ...okfEvidenceRecords.map((record) => record.evidenceId),
        ...dbEvidenceRecords.map((record) => String(record.evidence_id)),
      ]);
      qualityFlags = uniqueSorted([
        ...(toolResult.qualityFlags ?? []),
        ...await this.envelope.qualityFlagsForComponents(hitComponentIds, dbEvidenceRecords, new Set(okfEvidenceRecords.map((record) => record.componentId)), new Map(trust.components.map((component) => [component.componentId, component.trust] as const))),
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
            artifactIds: toolResult.artifactIds ?? await this.envelope.artifactIdsForComponents(hitComponentIds),
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
        return this.searchTools.kbSearch(release, stringArg(payload, "query", "q"), numberArg(payload, 10, "limit", "topK", "top_k"), context.agentRole);
      case "kb_resolve_topic":
        return this.searchTools.kbResolveTopic(release, stringArg(payload, "topic", "query", "q"));
      case "kb_get_page":
        return this.pageTools.kbGetPage(release, stringArg(payload, "componentId", "page", "title", "topic"));
      case "kb_get_section":
        return this.pageTools.kbGetSection(release, stringArg(payload, "componentId", "page", "title", "topic"), stringArg(payload, "section"));
      case "kb_list_pages":
        return this.pageTools.kbListPages(release);
      case "kb_get_index":
        return this.pageTools.kbGetIndex(release);
      case "kb_get_page_tables":
        return this.pageTools.kbGetPageTables(release, stringArg(payload, "componentId", "page", "title", "topic"));
      case "kb_get_entity":
        return this.graphTools.kbGetEntity(release, stringArg(payload, "entityId", "id", "name"));
      case "kb_get_neighbors":
        return this.graphTools.kbGetNeighbors(release, stringArg(payload, "entityId", "id", "name"));
      case "kb_list_entities":
        return this.graphTools.kbListEntities(release, optionalString(payload, "type"));
      case "kb_get_relations":
        return this.graphTools.kbGetRelations(release, optionalString(payload, "source"), optionalString(payload, "target"), optionalString(payload, "relation"));
      case "kb_list_tables":
        return this.tableTools.kbListTables(release, optionalString(payload, "query", "q", "group"), numberArg(payload, 50, "limit", "topK", "top_k"));
      case "kb_get_table_schema":
        return this.tableTools.kbGetTableSchema(release, stringArg(payload, "table", "tableName", "name"));
      case "kb_query_table":
        return this.tableTools.kbQueryTable(release, stringArg(payload, "table", "tableName", "name"), Number(payload.limit ?? 20), objectArg(payload.where ?? payload.filters));
      case "kb_get_table_raw":
        return this.tableTools.kbGetTableRaw(release, stringArg(payload, "table", "tableName", "name"), Number(payload.headerRows ?? 0));
      case "kb_validate_table":
        return this.tableTools.kbValidateTable(release, stringArg(payload, "table", "tableName", "name"));
      case "kb_check_table_value":
        return this.tableTools.kbCheckTableValue(release, stringArg(payload, "table", "tableName", "name"), stringArg(payload, "field"), payload.value);
      case "kb_get_quality":
        return this.tableTools.kbGetQuality(release, optionalString(payload, "componentId"));
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















  private async kbGetEvidence(release: ReleaseRecord, componentId?: string, page?: string, query?: string): Promise<ToolResult> {
    const component = componentId
      ? (await this.tableTools.releaseComponents(release)).find((item) => item.componentId === componentId)
      : null;
    const okfPage = !component && page ? await this.pageTools.findOkfPage(release, page) : null;
    const componentIds = component
      ? [component.componentId]
      : okfPage ? [okfPage.componentId]
        : query ? (await this.searchTools.kbSearch(release, query)).componentIds : [];
    const okfRecords = this.envelope.okfEvidenceRecordsForComponents(release, componentIds);
    const dbRecords = componentIds.length ? await this.envelope.evidenceRecordsForComponents(componentIds) : [];
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
      const pageResult = await this.pageTools.kbGetPage(release, page);
      if (pageResult.componentIds.length > 0) return pageResult.componentIds;
    }
    const query = optionalString(payload, "query", "q", "topic");
    if (query) {
      const search = await this.searchTools.kbSearch(release, query, 3);
      return search.componentIds.slice(0, 3);
    }
    return [];
  }





  /** 组件产物文件（转发至表格域读取器，保持公共 API 兼容）。 */
  async getComponentFile(packageId: string, componentId: string): Promise<{
    componentId: string;
    kind: string;
    legacyPath: string;
    storageUri: string;
    content: string;
    truncated: boolean;
  }> {
    return this.tableTools.getComponentFile(packageId, componentId);
  }



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
    const trust = release ? await this.envelope.trustSummaryForComponents(release, componentIds) : { averageScore: null, minScore: null, summary: emptyTrustSummary(null), components: [] };
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

