import { deleteJson, getJson, patchJson, postEmpty, postJson } from "./http";
import type { ReleaseRecord } from "./types";

export async function listReleases(projectId?: string): Promise<ReleaseRecord[]> {
  return (await getJson<{ releases: ReleaseRecord[] }>(projectId ? `/api/projects/${encodeURIComponent(projectId)}/releases` : "/api/releases")).releases;
}

export async function getCurrentRelease(projectId?: string): Promise<ReleaseRecord | null> {
  return (await getJson<{ release: ReleaseRecord | null }>(projectId ? `/api/projects/${encodeURIComponent(projectId)}/releases/current` : "/api/releases/current")).release;
}

export async function createRelease(version: string, packageIds: string[], parentReleaseId?: string | null, projectId?: string): Promise<ReleaseRecord> {
  return (await postJson<{ release: ReleaseRecord }>(projectId ? `/api/projects/${encodeURIComponent(projectId)}/releases` : "/api/releases", { version, packageIds, parentReleaseId })).release;
}

export async function publishRelease(releaseId: string, options: { autoMode?: boolean } = {}): Promise<ReleaseRecord> {
  if (!options.autoMode) return (await postEmpty<{ release: ReleaseRecord }>(`/api/releases/${encodeURIComponent(releaseId)}/publish`)).release;
  return (await postJson<{ release: ReleaseRecord }>(`/api/releases/${encodeURIComponent(releaseId)}/publish`, options)).release;
}

export async function rollbackRelease(releaseId: string): Promise<ReleaseRecord> {
  return (await postJson<{ release: ReleaseRecord }>("/api/releases/rollback", { releaseId })).release;
}

export async function updateRelease(
  releaseId: string,
  patch: { version?: string; note?: string }
): Promise<ReleaseRecord> {
  return (await patchJson<{ release: ReleaseRecord }>(`/api/releases/${encodeURIComponent(releaseId)}`, patch)).release;
}

export async function deleteRelease(releaseId: string): Promise<ReleaseRecord> {
  return (await deleteJson<{ release: ReleaseRecord }>(`/api/releases/${encodeURIComponent(releaseId)}`)).release;
}
