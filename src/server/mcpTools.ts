import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { KnowledgeQueryService, KnowledgeQueryContext } from "./services/knowledgeQueryService";

export interface KnowledgeMcpContextDefaults extends KnowledgeQueryContext {
  sessionId: string;
  agentRole: string;
}

const contextFields = {
  projectId: z.string().optional().describe("Knowledge Hub project/game id. Pass this to query a specific game knowledge base."),
  sessionId: z.string().optional().describe("Optional caller/session id for MCP audit records."),
  agentRole: z.string().optional().describe("Optional role label for MCP audit records, e.g. planner or qa-agent."),
};
const limitField = z.number().int().positive().max(200).optional().describe("Maximum number of results to return.");
const queryField = z.string().min(1).describe("Natural-language query or exact topic/table name.");
const componentIdField = z.string().min(1).describe("Knowledge Hub component id from a previous MCP result.");
const pageField = z.string().min(1).describe("Page title, OKF path, artifact id, or component id.");
const tableField = z.string().min(1).describe("Table name or maintained table alias.");
const entityField = z.string().min(1).describe("Graph entity id, label, or name.");

const noArgs = z.object(contextFields).passthrough();

export const knowledgeMcpTools: Array<{
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  readOnly: boolean;
}> = [
  {
    name: "kb_search",
    title: "Search Knowledge",
    description: "Search current published OKF knowledge. Returns ranked items plus Agent-friendly cards with trust, evidence, dependencies, and next tools.",
    inputSchema: z.object({ ...contextFields, query: queryField, q: queryField.optional(), limit: limitField, topK: limitField, top_k: limitField }).passthrough(),
    readOnly: true,
  },
  {
    name: "kb_resolve_topic",
    title: "Resolve Topic",
    description: "Resolve a topic to actionable page, table, or graph entity targets and recommended next MCP tools.",
    inputSchema: z.object({ ...contextFields, topic: queryField, query: queryField.optional(), q: queryField.optional() }).passthrough(),
    readOnly: true,
  },
  {
    name: "kb_get_page",
    title: "Get Page",
    description: "Read a Wiki markdown page from the current OKF release.",
    inputSchema: z.object({ ...contextFields, page: pageField, title: pageField.optional(), topic: pageField.optional(), componentId: componentIdField.optional() }).passthrough(),
    readOnly: true,
  },
  {
    name: "kb_get_section",
    title: "Get Section",
    description: "Read a specific markdown section from a released Wiki page.",
    inputSchema: z.object({ ...contextFields, page: pageField, title: pageField.optional(), topic: pageField.optional(), componentId: componentIdField.optional(), section: z.string().min(1).describe("Markdown heading to extract.") }).passthrough(),
    readOnly: true,
  },
  { name: "kb_list_pages", title: "List Pages", description: "List Wiki pages available in the current release.", inputSchema: noArgs, readOnly: true },
  {
    name: "kb_get_page_tables",
    title: "Get Page Tables",
    description: "List table schemas referenced by a Wiki page and unresolved dependency hints.",
    inputSchema: z.object({ ...contextFields, page: pageField, title: pageField.optional(), topic: pageField.optional(), componentId: componentIdField.optional() }).passthrough(),
    readOnly: true,
  },
  {
    name: "kb_get_entity",
    title: "Get Entity",
    description: "Read an entity from the current release graph snapshot.",
    inputSchema: z.object({ ...contextFields, entityId: entityField, id: entityField.optional(), name: entityField.optional() }).passthrough(),
    readOnly: true,
  },
  {
    name: "kb_get_neighbors",
    title: "Get Neighbors",
    description: "Read graph neighbors and relations for an entity.",
    inputSchema: z.object({ ...contextFields, entityId: entityField, id: entityField.optional(), name: entityField.optional() }).passthrough(),
    readOnly: true,
  },
  {
    name: "kb_list_entities",
    title: "List Entities",
    description: "List graph nodes, optionally filtered by entity type such as system, activity, table, or item.",
    inputSchema: z.object({ ...contextFields, type: z.string().optional().describe("Optional graph node type filter.") }).passthrough(),
    readOnly: true,
  },
  {
    name: "kb_get_relations",
    title: "Get Relations",
    description: "Read graph edges, optionally filtered by source, target, or relation.",
    inputSchema: z.object({ ...contextFields, source: z.string().optional(), target: z.string().optional(), relation: z.string().optional() }).passthrough(),
    readOnly: true,
  },
  {
    name: "kb_list_tables",
    title: "List Tables",
    description: "List table schemas available in the current release, searchable by table name, alias, group, or field.",
    inputSchema: z.object({ ...contextFields, query: z.string().optional(), q: z.string().optional(), group: z.string().optional(), limit: limitField, topK: limitField, top_k: limitField }).passthrough(),
    readOnly: true,
  },
  {
    name: "kb_get_table_schema",
    title: "Get Table Schema",
    description: "Read a released table schema by canonical table name or alias.",
    inputSchema: z.object({ ...contextFields, table: tableField, tableName: tableField.optional(), name: tableField.optional() }).passthrough(),
    readOnly: true,
  },
  {
    name: "kb_query_table",
    title: "Query Table",
    description: "Read rows from a released source table with optional exact-match filters.",
    inputSchema: z.object({ ...contextFields, table: tableField, tableName: tableField.optional(), name: tableField.optional(), limit: limitField, where: z.record(z.string(), z.unknown()).optional(), filters: z.record(z.string(), z.unknown()).optional() }).passthrough(),
    readOnly: true,
  },
  {
    name: "kb_get_table_raw",
    title: "Get Table Raw Grid",
    description: "Read a released source table as a faithful raw grid (array-of-arrays), preserving column order, column-ID row and empty columns. Use this (not kb_query_table) when you need the exact table layout to regenerate importable config tables.",
    inputSchema: z.object({ ...contextFields, table: tableField, tableName: tableField.optional(), name: tableField.optional(), headerRows: z.number().int().min(0).optional().describe("Optional: how many leading rows are headers, to split header/data in the response (rows always returns the full grid).") }).passthrough(),
    readOnly: true,
  },
  {
    name: "kb_validate_table",
    title: "Validate Table",
    description: "Validate that a released table schema matches source table data.",
    inputSchema: z.object({ ...contextFields, table: tableField, tableName: tableField.optional(), name: tableField.optional() }).passthrough(),
    readOnly: true,
  },
  {
    name: "kb_check_table_value",
    title: "Check Table Value",
    description: "Check exact values in a released source table.",
    inputSchema: z.object({ ...contextFields, table: tableField, tableName: tableField.optional(), name: tableField.optional(), field: z.string().min(1).describe("Field/column name to compare."), value: z.unknown().describe("Exact value to match after string normalization.") }).passthrough(),
    readOnly: true,
  },
  {
    name: "kb_get_quality",
    title: "Get Quality",
    description: "Read release and component quality/trust summaries.",
    inputSchema: z.object({ ...contextFields, componentId: componentIdField.optional() }).passthrough(),
    readOnly: true,
  },
  {
    name: "kb_get_evidence",
    title: "Get Evidence",
    description: "Read evidence records for a component, page, or query.",
    inputSchema: z.object({ ...contextFields, componentId: componentIdField.optional(), page: pageField.optional(), query: z.string().optional(), q: z.string().optional(), topic: z.string().optional() }).passthrough(),
    readOnly: true,
  },
  {
    name: "kb_get_release",
    title: "Get Release",
    description: "Read the current published release summary. Pass includeManifest=true only when the full frozen manifest is needed.",
    inputSchema: z.object({ ...contextFields, includeManifest: z.boolean().optional().describe("Return the full frozen release manifest. Defaults to false to keep MCP responses small.") }).passthrough(),
    readOnly: true,
  },
  {
    name: "kb_get_flywheel_status",
    title: "Get Flywheel Status",
    description: "Read project flywheel status: current release, latest build, open exceptions, corrections, and auto-publish gates.",
    inputSchema: noArgs,
    readOnly: true,
  },
  {
    name: "kb_submit_correction",
    title: "Submit Correction",
    description: "Submit a structured correction proposal for a staged/draft knowledge component. This does not mutate published OKF assets.",
    inputSchema: z.object({
      ...contextFields,
      componentId: componentIdField.optional(),
      knowledgePath: z.string().optional().describe("Wiki path, artifact id, title, legacy path, or source path when componentId is unavailable."),
      issue: z.string().min(1).describe("What is wrong or missing."),
      suggestion: z.unknown().describe("Corrected value or structured patch proposed by the Agent."),
      sourceContext: z.string().optional().describe("Source/user context that supports the correction."),
      queryContext: z.string().optional().describe("The Agent query/task context that revealed the issue."),
      confidence: z.number().min(0).max(1).optional(),
      ruleId: z.string().optional(),
      pageType: z.string().optional(),
      factKey: z.string().optional(),
    }).passthrough(),
    readOnly: false,
  },
  {
    name: "kb_apply_correction",
    title: "Apply Correction",
    description: "Activate a submitted correction in the source correction layer for the staged asset. Published releases remain immutable.",
    inputSchema: z.object({ ...contextFields, correctionId: z.string().min(1), note: z.string().optional() }).passthrough(),
    readOnly: false,
  },
  {
    name: "kb_start_incremental_check",
    title: "Start Incremental Check",
    description: "Run a scoped rebuild/check for the affected component so correction, lint, evidence, dependencies, and trust can be re-evaluated.",
    inputSchema: z.object({ ...contextFields, correctionId: z.string().optional(), componentId: componentIdField.optional(), sourcePath: z.string().optional() }).passthrough(),
    readOnly: false,
  },
  {
    name: "kb_publish_if_ready",
    title: "Publish If Ready",
    description: "Ask the server to publish the latest eligible build/revision only if auto-publish gates pass; otherwise returns explicit skip reasons.",
    inputSchema: z.object({ ...contextFields, packageId: z.string().optional(), runId: z.string().optional() }).passthrough(),
    readOnly: false,
  },
  {
    name: "kb_get_correction_status",
    title: "Get Correction Status",
    description: "Read the correction lifecycle from submission through application, rebuild/check, and publish decision.",
    inputSchema: z.object({ ...contextFields, correctionId: z.string().min(1) }).passthrough(),
    readOnly: true,
  },
  {
    name: "kb_govern_flywheel",
    title: "Govern Flywheel",
    description: "One-shot Agent-first governance: submit or reuse a correction, apply it to staged correction state, start scoped incremental check, and request publish-if-ready. Never mutates published OKF assets directly.",
    inputSchema: z.object({
      ...contextFields,
      correctionId: z.string().optional().describe("Existing correction id. If omitted, componentId/knowledgePath + issue + suggestion are used to submit a new correction."),
      componentId: componentIdField.optional(),
      knowledgePath: z.string().optional(),
      issue: z.string().optional().describe("Required when correctionId is omitted."),
      suggestion: z.unknown().optional().describe("Required when correctionId is omitted."),
      sourceContext: z.string().optional(),
      queryContext: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
      ruleId: z.string().optional(),
      pageType: z.string().optional(),
      factKey: z.string().optional(),
      sourcePath: z.string().optional(),
      apply: z.boolean().optional().describe("Default true. Set false to only submit/reuse the correction."),
      check: z.boolean().optional().describe("Default true. Set false to skip scoped rebuild/check."),
      publish: z.boolean().optional().describe("Default true. Publish only occurs if server gates pass."),
      note: z.string().optional(),
    }).passthrough(),
    readOnly: false,
  },
  {
    name: "kb_report_gap",
    title: "Report Knowledge Gap",
    description: "Agent feedback: report that current published knowledge cannot answer a user query. Routes a review task into the flywheel.",
    inputSchema: z.object({
      ...contextFields,
      query: queryField,
      q: queryField.optional(),
      expected: z.string().optional().describe("What knowledge or answer the Agent expected to find."),
      reason: z.string().optional().describe("Why the current result is insufficient."),
      note: z.string().optional().describe("Additional triage context for reviewers."),
    }).passthrough(),
    readOnly: false,
  },
  {
    name: "kb_report_bad_hit",
    title: "Report Bad Hit",
    description: "Agent feedback: report that a retrieved component was irrelevant or misleading. Routes a review task into the flywheel.",
    inputSchema: z.object({
      ...contextFields,
      query: queryField,
      q: queryField.optional(),
      componentId: componentIdField.optional(),
      componentIds: z.array(componentIdField).optional(),
      page: pageField.optional(),
      expected: z.string().optional().describe("The expected topic/component/table if known."),
      reason: z.string().optional().describe("Why the hit is wrong or misleading."),
      note: z.string().optional().describe("Additional triage context for reviewers."),
    }).passthrough(),
    readOnly: false,
  },
  {
    name: "kb_report_stale",
    title: "Report Stale Knowledge",
    description: "Agent feedback: report that a component appears outdated, contradicted, or no longer reliable. Routes a review task into the flywheel.",
    inputSchema: z.object({
      ...contextFields,
      componentId: componentIdField.optional(),
      componentIds: z.array(componentIdField).optional(),
      page: pageField.optional(),
      query: z.string().optional(),
      q: z.string().optional(),
      topic: z.string().optional(),
      expected: z.string().optional().describe("The fresher or corrected understanding if known."),
      reason: z.string().optional().describe("Why the knowledge appears stale or incorrect."),
      note: z.string().optional().describe("Additional triage context for reviewers."),
    }).passthrough(),
    readOnly: false,
  },
];

export function createKnowledgeMcpServer(
  queryService: KnowledgeQueryService,
  defaults: KnowledgeMcpContextDefaults,
): McpServer {
  const server = new McpServer({
    name: "knowledge-hub",
    version: "0.1.0",
  });

  registerKnowledgeMcpTools(server, queryService, defaults);
  return server;
}

export function registerKnowledgeMcpTools(
  server: McpServer,
  queryService: KnowledgeQueryService,
  defaults: KnowledgeMcpContextDefaults,
): void {
  for (const tool of knowledgeMcpTools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.readOnly },
      },
      async (args) => {
        try {
          const payload = args as Record<string, unknown>;
          const envelope = await queryService.runTool(tool.name, payload, {
            sessionId: typeof payload.sessionId === "string" ? payload.sessionId : defaults.sessionId,
            agentRole: typeof payload.agentRole === "string" ? payload.agentRole : defaults.agentRole,
            projectId: typeof payload.projectId === "string" ? payload.projectId : defaults.projectId,
            traceId: defaults.traceId,
          });
          return {
            structuredContent: envelope as unknown as Record<string, unknown>,
            content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
          };
        } catch (error) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
          };
        }
      },
    );
  }
}
