import { getJson } from "./http";
import type { DashboardSummary } from "./types";

export async function getDashboard(): Promise<DashboardSummary> {
  return getJson<DashboardSummary>("/api/dashboard");
}
