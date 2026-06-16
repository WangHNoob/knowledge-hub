import { getJson } from "./http";
import type { ReviewTask } from "./types";

export async function listReviewTasks(severity?: string): Promise<ReviewTask[]> {
  const suffix = severity ? `?severity=${encodeURIComponent(severity)}` : "";
  return (await getJson<{ tasks: ReviewTask[] }>(`/api/review/tasks${suffix}`)).tasks;
}
