import { getJson, postJson } from "./http";
import type {
  AgentFeedbackCluster,
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

export async function listFeedbackClusters(projectId?: string): Promise<AgentFeedbackCluster[]> {
  const res = await getJson<{ clusters: AgentFeedbackCluster[] }>(
    projectId ? `/api/projects/${encodeURIComponent(projectId)}/flywheel/feedback-clusters` : "/api/flywheel/feedback-clusters",
  );
  return res.clusters;
}
