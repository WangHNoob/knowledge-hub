import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";

import type { ProjectRecord } from "../api";

export interface ProjectContextValue {
  projects: ProjectRecord[];
  currentProjectId: string;
  currentProject: ProjectRecord | null;
  loading: boolean;
  switching: boolean;
  switchProject(projectId: string): Promise<void>;
  createProject(input: { name: string; description?: string }): Promise<void>;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ value, children }: { value: Omit<ProjectContextValue, "currentProject">; children: ReactNode }) {
  const currentProject = value.projects.find((project) => project.projectId === value.currentProjectId) ?? value.projects[0] ?? null;
  const contextValue = useMemo<ProjectContextValue>(() => ({ ...value, currentProject }), [currentProject, value]);
  return <ProjectContext.Provider value={contextValue}>{children}</ProjectContext.Provider>;
}

export function useProject() {
  const value = useContext(ProjectContext);
  if (!value) throw new Error("useProject must be used inside ProjectProvider.");
  return value;
}
