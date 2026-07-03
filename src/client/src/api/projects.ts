import { getJson, patchJson, postEmpty, postJson } from "./http";
import type { ProjectRecord, SourceBundle } from "./types";

export async function listProjects(): Promise<{ projects: ProjectRecord[]; currentProjectId: string }> {
  return getJson("/api/projects");
}

export async function createProject(input: { name: string; description?: string }): Promise<{ project: ProjectRecord; bundle: SourceBundle }> {
  return postJson("/api/projects", input);
}

export async function updateProject(projectId: string, patch: { name?: string; description?: string; status?: "active" | "archived" }): Promise<ProjectRecord> {
  return (await patchJson<{ project: ProjectRecord }>(`/api/projects/${encodeURIComponent(projectId)}`, patch)).project;
}

export async function selectProject(projectId: string): Promise<{ user: { currentProjectId: string } }> {
  return postEmpty(`/api/projects/${encodeURIComponent(projectId)}/select`);
}
