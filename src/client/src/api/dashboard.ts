import { getJson } from "./http";
import type { DashboardSummary, FlywheelWorkbench } from "./types";

export async function getDashboard(projectId?: string): Promise<DashboardSummary> {
  return getJson<DashboardSummary>(projectId ? `/api/projects/${encodeURIComponent(projectId)}/dashboard` : "/api/dashboard");
}

export async function getFlywheelWorkbench(projectId?: string): Promise<FlywheelWorkbench> {
  return getJson<FlywheelWorkbench>(projectId ? `/api/projects/${encodeURIComponent(projectId)}/dashboard/workbench` : "/api/dashboard/workbench");
}
