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
    description: "Search current published OKF knowledge. Returns ranked items plus Agent-friendly cards with trust, evidence, dependencies, and next tools. For navigation-first lookups, call kb_get_index first to read the directory TOC and locate the exact page/table.",
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
  { name: "kb_list_pages", title: "List Pages", description: "List Wiki pages available in the current release. Use kb_get_index for the grouped directory with one-line descriptions and key tables.", inputSchema: noArgs, readOnly: true },
  {
    name: "kb_get_index",
    title: "Get Knowledge Directory Index",
    description: "Read the release directory index (index.md): complete TOC of all wiki pages grouped by module, each with a one-line scope description and its key CSV tables, plus a where-to-find guide. Call this first to locate the right page/table, then use kb_get_page / kb_query_table.",
    inputSchema: z.object(contextFields).passthrough(),
    readOnly: true,
  },
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
    description: "Read the current published release summary. includeManifest=true returns a bounded manifest preview, not the full frozen manifest, to keep MCP responses small.",
    inputSchema: z.object({
      ...contextFields,
      includeManifest: z.boolean().optional().describe("Return a bounded frozen manifest preview. Defaults to false to keep MCP responses small."),
      manifestLimit: z.number().int().positive().max(200).optional().describe("Maximum number of manifest sample entries to return when includeManifest=true. Defaults to 30."),
    }).passthrough(),
    readOnly: true,
  },
  {
    name: "kb_list_projects",
    title: "List Projects",
    description: "List Knowledge Hub game projects available to this MCP connection and show the current/default projectId.",
    inputSchema: noArgs,
    readOnly: true,
  },
  {
    name: "kb_rollback_release",
    title: "Rollback Release Channel",
    description: "Admin-only: repoint the project release channel to a previously published release. Does not rewrite immutable release snapshots.",
    inputSchema: z.object({
      ...contextFields,
      releaseId: z.string().min(1).describe("Published release id to make current."),
      agentRole: z.string().optional().describe("Must be admin for this tool."),
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
            // 机器通道：完整信封（UI 知识面板/评测解析 trust.components 等）
            structuredContent: envelope as unknown as Record<string, unknown>,
            // 模型文本通道：瘦身视图。工具结果不做有损截断，但同一结果在
            // items 与 cards 里的重复渲染、以及仅诊断用的缩进空白不带给模型
            // ——实测 kb_search 文本从 45KB 降到 ~20KB。
            content: [{ type: "text" as const, text: JSON.stringify(modelTextEnvelope(envelope)) }],
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

/**
 * 模型文本通道瘦身视图（不改变 structuredContent）：
 * - 去掉 pretty-print 缩进（实测占 kb_search 文本的 ~38%）；
 * - result.items 压成指针字段（snippet/trust/artifactId 与 cards 重复，
 *   模型需要看的是 cards；componentId/title/okfPath 等定位字段保留）；
 * - 顶层 trust.components（逐组件明细，3KB+）只保留汇总，明细走机器通道。
 */
function modelTextEnvelope(envelope: object): Record<string, unknown> {
  const source = envelope as Record<string, unknown>;
  const result = source.result as Record<string, unknown> | undefined;
  const slim: Record<string, unknown> = { ...source };
  if (result && Array.isArray(result.items)) {
    const items = result.items as Array<Record<string, unknown>>;
    slim.result = {
      ...result,
      items: items.map((item) => ({
        componentId: item.componentId,
        title: item.title,
        okfPath: item.okfPath,
        kind: item.kind,
        type: item.type,
        score: item.score,
        why: item.why,
        matchedFields: item.matchedFields,
        tableDependencies: item.tableDependencies,
      })),
    };
  }
  if (source.trust && typeof source.trust === "object") {
    const { components: _components, ...trustSummary } = source.trust as Record<string, unknown>;
    slim.trust = trustSummary;
  }
  return slim;
}
