import { getJson, postJson, putJson } from "./http";
import type { KnowledgeGovernanceProfile, KnowledgeGovernanceProfileInput } from "./types";

export async function getGovernanceProfile(projectId?: string): Promise<KnowledgeGovernanceProfile> {
  const res = await getJson<{ profile: KnowledgeGovernanceProfile }>(
    projectId ? `/api/projects/${encodeURIComponent(projectId)}/governance-profile` : "/api/flywheel/governance-profile",
  );
  return res.profile;
}

export async function updateGovernanceProfile(
  patch: KnowledgeGovernanceProfileInput,
  projectId?: string,
): Promise<KnowledgeGovernanceProfile> {
  const res = await putJson<{ profile: KnowledgeGovernanceProfile }>(
    projectId ? `/api/projects/${encodeURIComponent(projectId)}/governance-profile` : "/api/flywheel/governance-profile",
    patch,
  );
  return res.profile;
}

export async function resetGovernanceProfile(projectId?: string): Promise<KnowledgeGovernanceProfile> {
  const res = await postJson<{ profile: KnowledgeGovernanceProfile }>(
    projectId
      ? `/api/projects/${encodeURIComponent(projectId)}/governance-profile/reset`
      : "/api/flywheel/governance-profile/reset",
    {},
  );
  return res.profile;
}
