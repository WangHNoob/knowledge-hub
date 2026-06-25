import { isAbsolute, resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { config } from "./config";
import { createDatabase } from "./db";
import { createKnowledgeQueryService } from "./services/knowledgeQueryService";

const root = process.cwd();
const dataDir = isAbsolute(config.dataDir) ? config.dataDir : resolve(root, config.dataDir);
const db = await createDatabase({
  databaseUrl: config.databaseUrl,
});
const queryService = createKnowledgeQueryService(db, dataDir);

const server = new McpServer({
  name: "knowledge-hub",
  version: "0.1.0",
});

const contextFields = {
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

const tools: Array<{ name: string; title: string; description: string; inputSchema: z.ZodTypeAny }> = [
  {
    name: "kb_search",
    title: "Search Knowledge",
    description: "Search current published OKF knowledge. Returns ranked items plus Agent-friendly cards with trust, evidence, dependencies, and next tools.",
    inputSchema: z.object({ ...contextFields, query: queryField, q: queryField.optional(), limit: limitField, topK: limitField, top_k: limitField }).passthrough(),
  },
  {
    name: "kb_resolve_topic",
    title: "Resolve Topic",
    description: "Resolve a topic to actionable page, table, or graph entity targets and recommended next MCP tools.",
    inputSchema: z.object({ ...contextFields, topic: queryField, query: queryField.optional(), q: queryField.optional() }).passthrough(),
  },
  {
    name: "kb_get_page",
    title: "Get Page",
    description: "Read a Wiki markdown page from the current OKF release.",
    inputSchema: z.object({ ...contextFields, page: pageField, title: pageField.optional(), topic: pageField.optional(), componentId: componentIdField.optional() }).passthrough(),
  },
  {
    name: "kb_get_section",
    title: "Get Section",
    description: "Read a specific markdown section from a released Wiki page.",
    inputSchema: z.object({ ...contextFields, page: pageField, title: pageField.optional(), topic: pageField.optional(), componentId: componentIdField.optional(), section: z.string().min(1).describe("Markdown heading to extract.") }).passthrough(),
  },
  { name: "kb_list_pages", title: "List Pages", description: "List Wiki pages available in the current release.", inputSchema: noArgs },
  {
    name: "kb_get_page_tables",
    title: "Get Page Tables",
    description: "List table schemas referenced by a Wiki page and unresolved dependency hints.",
    inputSchema: z.object({ ...contextFields, page: pageField, title: pageField.optional(), topic: pageField.optional(), componentId: componentIdField.optional() }).passthrough(),
  },
  {
    name: "kb_get_entity",
    title: "Get Entity",
    description: "Read an entity from the current release graph snapshot.",
    inputSchema: z.object({ ...contextFields, entityId: entityField, id: entityField.optional(), name: entityField.optional() }).passthrough(),
  },
  {
    name: "kb_get_neighbors",
    title: "Get Neighbors",
    description: "Read graph neighbors and relations for an entity.",
    inputSchema: z.object({ ...contextFields, entityId: entityField, id: entityField.optional(), name: entityField.optional() }).passthrough(),
  },
  {
    name: "kb_list_entities",
    title: "List Entities",
    description: "List graph nodes, optionally filtered by entity type such as system, activity, table, or item.",
    inputSchema: z.object({ ...contextFields, type: z.string().optional().describe("Optional graph node type filter.") }).passthrough(),
  },
  {
    name: "kb_get_relations",
    title: "Get Relations",
    description: "Read graph edges, optionally filtered by source, target, or relation.",
    inputSchema: z.object({ ...contextFields, source: z.string().optional(), target: z.string().optional(), relation: z.string().optional() }).passthrough(),
  },
  {
    name: "kb_list_tables",
    title: "List Tables",
    description: "List table schemas available in the current release, searchable by table name, alias, group, or field.",
    inputSchema: z.object({ ...contextFields, query: z.string().optional(), q: z.string().optional(), group: z.string().optional(), limit: limitField, topK: limitField, top_k: limitField }).passthrough(),
  },
  {
    name: "kb_get_table_schema",
    title: "Get Table Schema",
    description: "Read a released table schema by canonical table name or alias.",
    inputSchema: z.object({ ...contextFields, table: tableField, tableName: tableField.optional(), name: tableField.optional() }).passthrough(),
  },
  {
    name: "kb_query_table",
    title: "Query Table",
    description: "Read rows from a released source table with optional exact-match filters.",
    inputSchema: z.object({ ...contextFields, table: tableField, tableName: tableField.optional(), name: tableField.optional(), limit: limitField, where: z.record(z.string(), z.unknown()).optional(), filters: z.record(z.string(), z.unknown()).optional() }).passthrough(),
  },
  {
    name: "kb_validate_table",
    title: "Validate Table",
    description: "Validate that a released table schema matches source table data.",
    inputSchema: z.object({ ...contextFields, table: tableField, tableName: tableField.optional(), name: tableField.optional() }).passthrough(),
  },
  {
    name: "kb_check_table_value",
    title: "Check Table Value",
    description: "Check exact values in a released source table.",
    inputSchema: z.object({ ...contextFields, table: tableField, tableName: tableField.optional(), name: tableField.optional(), field: z.string().min(1).describe("Field/column name to compare."), value: z.unknown().describe("Exact value to match after string normalization.") }).passthrough(),
  },
  {
    name: "kb_get_quality",
    title: "Get Quality",
    description: "Read release and component quality/trust summaries.",
    inputSchema: z.object({ ...contextFields, componentId: componentIdField.optional() }).passthrough(),
  },
  {
    name: "kb_get_evidence",
    title: "Get Evidence",
    description: "Read evidence records for a component, page, or query.",
    inputSchema: z.object({ ...contextFields, componentId: componentIdField.optional(), page: pageField.optional(), query: z.string().optional(), q: z.string().optional(), topic: z.string().optional() }).passthrough(),
  },
  { name: "kb_get_release", title: "Get Release", description: "Read the current published release envelope and OKF manifest.", inputSchema: noArgs },
];

for (const tool of tools) {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const payload = args as Record<string, unknown>;
        const envelope = await queryService.runTool(tool.name, payload, {
          sessionId: typeof payload.sessionId === "string" ? payload.sessionId : "mcp-stdio",
          agentRole: typeof payload.agentRole === "string" ? payload.agentRole : "agent",
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

await server.connect(new StdioServerTransport());

const shutdown = async () => {
  await server.close();
  await db.close();
};
process.on("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
process.on("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
