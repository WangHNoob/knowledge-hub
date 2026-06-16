import { postJson } from "./http";
import type { LegacyImportResult, LegacyScanSummary } from "./types";

export async function scanLegacy(path: string): Promise<LegacyScanSummary> {
  return postJson<LegacyScanSummary>("/api/legacy/scan", { path });
}

export async function importLegacy(path: string): Promise<LegacyImportResult> {
  return postJson<LegacyImportResult>("/api/legacy/import", { path });
}
