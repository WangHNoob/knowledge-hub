import { deleteJson, getJson, postEmpty, postJson } from "./http";
import type {
  BuildModelConfig,
  BuildRequest,
  BuildResponse,
  KnowledgeBuildRun,
  ModelConnectivityResult
} from "./types";

export async function buildKnowledgePackage(
  bundleId: string,
  versionId: string,
  payload: BuildRequest,
  projectId?: string
): Promise<BuildResponse> {
  return postJson<BuildResponse>(
    `${buildPrefix(bundleId, versionId, projectId)}/build`,
    payload
  );
}

export async function buildAndPublishKnowledge(
  bundleId: string,
  versionId: string,
  payload: BuildRequest,
  projectId?: string
): Promise<BuildResponse> {
  return postJson<BuildResponse>(
    `${buildPrefix(bundleId, versionId, projectId)}/build-and-publish`,
    payload
  );
}

export async function listBuildRuns(projectId?: string): Promise<KnowledgeBuildRun[]> {
  return (await getJson<{ runs: KnowledgeBuildRun[] }>(projectId ? `/api/projects/${encodeURIComponent(projectId)}/build-runs` : "/api/build-runs")).runs;
}

export async function stopBuildRun(runId: string): Promise<KnowledgeBuildRun> {
  return (await postEmpty<{ run: KnowledgeBuildRun }>(`/api/build-runs/${encodeURIComponent(runId)}/stop`)).run;
}

export async function deleteBuildRun(runId: string): Promise<boolean> {
  return (await deleteJson<{ deleted: boolean }>(`/api/build-runs/${encodeURIComponent(runId)}`)).deleted;
}

export async function testModelConnectivity(modelConfig: BuildModelConfig): Promise<ModelConnectivityResult> {
  return postJson<ModelConnectivityResult>("/api/model-connectivity/test", { modelConfig });
}

function buildPrefix(bundleId: string, versionId: string, projectId?: string): string {
  const tail = `source-bundles/${encodeURIComponent(bundleId)}/versions/${encodeURIComponent(versionId)}`;
  return projectId ? `/api/projects/${encodeURIComponent(projectId)}/${tail}` : `/api/${tail}`;
}
