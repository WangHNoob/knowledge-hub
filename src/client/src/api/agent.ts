import { getJson, postJson } from "./http";
import type { AgentEvent, KnowledgeEnvelope, McpAuditRecord } from "./types";

export async function listAgentEvents(): Promise<AgentEvent[]> {
  return (await getJson<{ events: AgentEvent[] }>("/api/agent/events")).events;
}

export async function listMcpAudit(): Promise<McpAuditRecord[]> {
  return (await getJson<{ audit: McpAuditRecord[] }>("/api/mcp/audit")).audit;
}

export async function simulateMcpQuery(toolName: string, payload: Record<string, unknown>): Promise<KnowledgeEnvelope> {
  return (await postJson<{ envelope: KnowledgeEnvelope }>("/api/mcp/query", { toolName, payload })).envelope;
}
