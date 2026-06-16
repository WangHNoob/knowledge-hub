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
  payload: BuildRequest
): Promise<BuildResponse> {
  return postJson<BuildResponse>(
    `/api/source-bundles/${encodeURIComponent(bundleId)}/versions/${encodeURIComponent(versionId)}/build`,
    payload
  );
}

export async function listBuildRuns(): Promise<KnowledgeBuildRun[]> {
  return (await getJson<{ runs: KnowledgeBuildRun[] }>("/api/build-runs")).runs;
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
