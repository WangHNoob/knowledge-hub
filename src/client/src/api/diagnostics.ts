import { getJson } from "./http";
import type { DiagnosticLogQuery, DiagnosticLogRecord, DiagnosticSummary } from "./types";

export async function getDiagnosticSummary(): Promise<DiagnosticSummary> {
  return (await getJson<{ summary: DiagnosticSummary }>("/api/diagnostics/summary")).summary;
}

export async function listDiagnosticLogs(query: DiagnosticLogQuery = {}): Promise<DiagnosticLogRecord[]> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && String(value).trim() !== "") params.set(key, String(value));
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return (await getJson<{ logs: DiagnosticLogRecord[] }>(`/api/diagnostics/logs${suffix}`)).logs;
}

export async function getDiagnosticTrace(traceId: string): Promise<DiagnosticLogRecord[]> {
  return (await getJson<{ logs: DiagnosticLogRecord[] }>(`/api/diagnostics/logs/${encodeURIComponent(traceId)}`)).logs;
}
