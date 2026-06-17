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

const toolInputSchema = z.object({}).passthrough();

const tools: Array<{ name: string; title: string; description: string }> = [
  { name: "kb_search", title: "Search Knowledge", description: "Search Wiki pages in the current published Knowledge Hub release." },
  { name: "kb_resolve_topic", title: "Resolve Topic", description: "Resolve a user topic to the best matching page or component." },
  { name: "kb_get_page", title: "Get Page", description: "Read a Wiki markdown page from the current release." },
  { name: "kb_get_section", title: "Get Section", description: "Read a specific markdown section from a Wiki page." },
  { name: "kb_list_pages", title: "List Pages", description: "List Wiki pages available in the current release." },
  { name: "kb_get_page_tables", title: "Get Page Tables", description: "List table schemas referenced by a Wiki page." },
  { name: "kb_get_entity", title: "Get Entity", description: "Read an entity from the current release graph snapshot." },
  { name: "kb_get_neighbors", title: "Get Neighbors", description: "Read graph neighbors and relations for an entity." },
  { name: "kb_list_entities", title: "List Entities", description: "List graph entities, optionally filtered by type." },
  { name: "kb_get_relations", title: "Get Relations", description: "Read graph relations, optionally filtered by source, target, or relation." },
  { name: "kb_list_tables", title: "List Tables", description: "List table schemas available in the current release." },
  { name: "kb_get_table_schema", title: "Get Table Schema", description: "Read a released table schema." },
  { name: "kb_query_table", title: "Query Table", description: "Read rows from a released source table with optional exact filters." },
  { name: "kb_validate_table", title: "Validate Table", description: "Validate that a released table schema matches source table data." },
  { name: "kb_check_table_value", title: "Check Table Value", description: "Check exact values in a released source table." },
  { name: "kb_get_quality", title: "Get Quality", description: "Read release and component quality summaries." },
  { name: "kb_get_evidence", title: "Get Evidence", description: "Read evidence records for a component or page." },
  { name: "kb_get_release", title: "Get Release", description: "Read the current published release envelope." },
];

for (const tool of tools) {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: toolInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const envelope = await queryService.runTool(tool.name, args as Record<string, unknown>, {
          sessionId: typeof args.sessionId === "string" ? args.sessionId : "mcp-stdio",
          agentRole: typeof args.agentRole === "string" ? args.agentRole : "agent",
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
