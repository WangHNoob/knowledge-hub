import { isAbsolute, resolve } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { config } from "./config";
import { createDatabase } from "./db";
import { createKnowledgeMcpServer } from "./mcpTools";
import { createGovernanceProfileService } from "./services/governanceProfileService";
import { createKnowledgeQueryService } from "./services/knowledgeQueryService";

const root = process.cwd();
const dataDir = isAbsolute(config.dataDir) ? config.dataDir : resolve(root, config.dataDir);

if (config.mcpStdioRequireToken && !config.mcpServiceToken.trim()) {
  throw new Error("KH_MCP_STDIO_REQUIRE_TOKEN=true but KH_MCP_SERVICE_TOKEN is empty; refusing to start stdio MCP.");
}

const db = await createDatabase({
  databaseUrl: config.databaseUrl,
});
const governanceProfileService = createGovernanceProfileService(db, {
  autoPublishRevisions: config.autoPublishRevisions,
  autoPublishMode: config.autoPublishMode,
  lintAutoGovernanceEnabled: true,
  lintAutoEligibleThreshold: config.autoRemediationConfidenceThreshold,
});
const queryService = createKnowledgeQueryService(db, dataDir, undefined, governanceProfileService);

const server = createKnowledgeMcpServer(queryService, {
  sessionId: "mcp-stdio",
  agentRole: "agent",
});

await server.connect(new StdioServerTransport());

const shutdown = async () => {
  await server.close();
  await db.close();
};
process.on("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
process.on("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
