import { getJson, postEmpty, postJson } from "./http";
import type { ReleaseRecord } from "./types";

export async function listReleases(): Promise<ReleaseRecord[]> {
  return (await getJson<{ releases: ReleaseRecord[] }>("/api/releases")).releases;
}

export async function getCurrentRelease(): Promise<ReleaseRecord | null> {
  return (await getJson<{ release: ReleaseRecord | null }>("/api/releases/current")).release;
}

export async function createRelease(version: string, packageIds: string[]): Promise<ReleaseRecord> {
  return (await postJson<{ release: ReleaseRecord }>("/api/releases", { version, packageIds })).release;
}

export async function publishRelease(releaseId: string): Promise<ReleaseRecord> {
  return (await postEmpty<{ release: ReleaseRecord }>(`/api/releases/${encodeURIComponent(releaseId)}/publish`)).release;
}

export async function rollbackRelease(releaseId: string): Promise<ReleaseRecord> {
  return (await postJson<{ release: ReleaseRecord }>("/api/releases/rollback", { releaseId })).release;
}
