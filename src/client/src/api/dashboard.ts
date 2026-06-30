import { getJson } from "./http";
import type { DashboardSummary, FlywheelWorkbench } from "./types";

export async function getDashboard(): Promise<DashboardSummary> {
  return getJson<DashboardSummary>("/api/dashboard");
}

export async function getFlywheelWorkbench(): Promise<FlywheelWorkbench> {
  return getJson<FlywheelWorkbench>("/api/dashboard/workbench");
}
