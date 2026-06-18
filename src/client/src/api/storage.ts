import { getJson, postJson } from "./http";
import type { ReclaimResult, StorageCategory, StorageOverview, StorageScanReport } from "./types";

export async function getStorageOverview(): Promise<StorageOverview> {
  return (await getJson<{ overview: StorageOverview }>("/api/storage/overview")).overview;
}

export async function scanStorage(): Promise<StorageScanReport> {
  return (await getJson<{ report: StorageScanReport }>("/api/storage/scan")).report;
}

export async function reclaimStorage(categories: StorageCategory[]): Promise<ReclaimResult> {
  return (await postJson<{ result: ReclaimResult }>("/api/storage/reclaim", { categories })).result;
}
