import { getJson, postJson } from "./http";
import type { BuildResponse, ReviewTask } from "./types";

export async function listReviewTasks(severity?: string, status?: string): Promise<ReviewTask[]> {
  const params = new URLSearchParams();
  if (severity) params.set("severity", severity);
  if (status) params.set("status", status);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return (await getJson<{ tasks: ReviewTask[] }>(`/api/review/tasks${suffix}`)).tasks;
}

export async function transitionReviewTasks(
  taskIds: string[],
  status: "open" | "resolved" | "dismissed",
  note?: string
): Promise<ReviewTask[]> {
  return (await postJson<{ tasks: ReviewTask[] }>("/api/review/tasks/transition", { taskIds, status, note })).tasks;
}

export async function annotateReviewTask(input: {
  taskId: string;
  selectedCandidateId?: string;
  correctValue?: unknown;
  applyMode?: "hint" | "override";
  note?: string;
  dismissRule?: boolean;
  dismissalReason?: string;
}): Promise<{ task: ReviewTask }> {
  return postJson<{ task: ReviewTask }>("/api/review/tasks/annotate", input);
}

export async function startReviewTaskRebuild(taskId: string): Promise<BuildResponse> {
  return postJson<BuildResponse>(`/api/review/tasks/${encodeURIComponent(taskId)}/rebuild`, {});
}
