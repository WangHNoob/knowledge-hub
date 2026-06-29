import { getJson, postJson } from "./http";
import type { AgentEvent, AttributionAudit, FlywheelConvergenceSummary, FlywheelEvent, KnowledgeEnvelope, McpAuditRecord } from "./types";

export async function listAgentEvents(): Promise<AgentEvent[]> {
  return (await getJson<{ events: AgentEvent[] }>("/api/agent/events")).events;
}

export async function listMcpAudit(): Promise<McpAuditRecord[]> {
  return (await getJson<{ audit: McpAuditRecord[] }>("/api/mcp/audit")).audit;
}

export async function listFlywheelEvents(): Promise<FlywheelEvent[]> {
  return (await getJson<{ events: FlywheelEvent[] }>("/api/agent/flywheel-events")).events;
}

export async function getFlywheelConvergenceSummary(): Promise<FlywheelConvergenceSummary> {
  return (await getJson<{ summary: FlywheelConvergenceSummary }>("/api/agent/flywheel-convergence")).summary;
}

export async function simulateMcpQuery(toolName: string, payload: Record<string, unknown>): Promise<KnowledgeEnvelope> {
  return (await postJson<{ envelope: KnowledgeEnvelope }>("/api/mcp/query", { toolName, payload })).envelope;
}

export async function listOutputAudits(): Promise<AttributionAudit[]> {
  return (await getJson<{ audits: AttributionAudit[] }>("/api/agent/output-audits")).audits;
}

export async function createOutputAudit(input: {
  releaseId: string;
  title: string;
  segments: Array<{ text: string; trace?: Partial<KnowledgeEnvelope["trace"]>; derivedFrom?: string[] }>;
}): Promise<AttributionAudit> {
  return (await postJson<{ audit: AttributionAudit }>("/api/agent/output-audits", input)).audit;
}
