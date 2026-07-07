import { getJson, postJson } from "./http";
import type {
  AgentFeedbackCluster,
  DismissedException,
  FlywheelStatus,
  FlywheelSyncResult,
  HumanException,
  KnowledgeLintRemediation,
  LintRemediationSummary,
} from "./types";

export async function getFlywheelStatus(projectId?: string): Promise<FlywheelStatus> {
  return getJson<FlywheelStatus>(projectId ? `/api/projects/${encodeURIComponent(projectId)}/flywheel/status` : "/api/flywheel/status");
}

export async function listFlywheelExceptions(projectId?: string): Promise<HumanException[]> {
  const res = await getJson<{ exceptions: HumanException[] }>(
    projectId ? `/api/projects/${encodeURIComponent(projectId)}/flywheel/exceptions` : "/api/flywheel/exceptions",
  );
  return res.exceptions;
}

export async function syncFlywheel(projectId?: string, mode?: "incremental" | "full"): Promise<FlywheelSyncResult> {
  return postJson<FlywheelSyncResult>(
    projectId ? `/api/projects/${encodeURIComponent(projectId)}/flywheel/sync` : "/api/flywheel/sync",
    mode ? { mode } : {},
  );
}

export async function listFlywheelRemediations(
  projectId?: string,
  releaseId?: string,
): Promise<{ remediations: KnowledgeLintRemediation[]; summary: LintRemediationSummary }> {
  const base = projectId ? `/api/projects/${encodeURIComponent(projectId)}/flywheel/remediations` : "/api/flywheel/remediations";
  const url = releaseId ? `${base}?releaseId=${encodeURIComponent(releaseId)}` : base;
  return getJson<{ remediations: KnowledgeLintRemediation[]; summary: LintRemediationSummary }>(url);
}

export async function retryFlywheelRemediation(
  projectId: string,
  remediationId: string,
): Promise<KnowledgeLintRemediation> {
  const res = await postJson<{ remediation: KnowledgeLintRemediation }>(
    `/api/projects/${encodeURIComponent(projectId)}/flywheel/remediations/${encodeURIComponent(remediationId)}/retry`,
    {},
  );
  return res.remediation;
}

export async function listFeedbackClusters(projectId?: string): Promise<AgentFeedbackCluster[]> {
  const res = await getJson<{ clusters: AgentFeedbackCluster[] }>(
    projectId ? `/api/projects/${encodeURIComponent(projectId)}/flywheel/feedback-clusters` : "/api/flywheel/feedback-clusters",
  );
  return res.clusters;
}

function flywheelBase(projectId?: string): string {
  return projectId ? `/api/projects/${encodeURIComponent(projectId)}/flywheel` : "/api/flywheel";
}

export async function listDismissedExceptions(projectId?: string): Promise<DismissedException[]> {
  const res = await getJson<{ dismissed: DismissedException[] }>(`${flywheelBase(projectId)}/exceptions/dismissed`);
  return res.dismissed;
}

export async function dismissException(
  input: { key: string; exceptionType?: string; title?: string; reason?: string },
  projectId?: string,
): Promise<DismissedException> {
  const res = await postJson<{ dismissed: DismissedException }>(`${flywheelBase(projectId)}/exceptions/dismiss`, input);
  return res.dismissed;
}

export async function restoreException(key: string, projectId?: string): Promise<void> {
  await postJson<Record<string, never>>(`${flywheelBase(projectId)}/exceptions/restore`, { key });
}

export async function rebuildComponent(componentId: string, projectId?: string): Promise<FlywheelSyncResult> {
  return postJson<FlywheelSyncResult>(`${flywheelBase(projectId)}/components/${encodeURIComponent(componentId)}/rebuild`, {});
}

export async function rebuildGraph(projectId?: string): Promise<FlywheelSyncResult> {
  return postJson<FlywheelSyncResult>(`${flywheelBase(projectId)}/graph/rebuild`, {});
}
