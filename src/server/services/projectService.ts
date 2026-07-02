import { nanoid } from "nanoid";

import type { DatabaseHandle, ProjectRecord, SourceBundle, UserRecord } from "../types";
import { mapProject, mapUser } from "../db/mappers";

export function createProjectService(db: DatabaseHandle) {
  return new ProjectService(db);
}

export class ProjectService {
  private readonly adapter;

  constructor(private readonly db: DatabaseHandle) {
    this.adapter = db.adapter;
  }

  async listProjects(): Promise<ProjectRecord[]> {
    const { rows } = await this.adapter.query(
      "SELECT * FROM projects ORDER BY status ASC, created_at ASC, project_id ASC",
    );
    return rows.map(mapProject);
  }

  async getProject(projectId: string): Promise<ProjectRecord | null> {
    const { rows } = await this.adapter.query("SELECT * FROM projects WHERE project_id = $1", [projectId]);
    return rows.length ? mapProject(rows[0]) : null;
  }

  async requireProject(projectId: string): Promise<ProjectRecord> {
    const project = await this.getProject(projectId);
    if (!project) throw new Error(`未知项目：${projectId}`);
    return project;
  }

  async createProject(input: { name: string; description?: string; createdBy: string }): Promise<{ project: ProjectRecord; bundle: SourceBundle }> {
    const now = new Date().toISOString();
    const projectId = `proj_${slug(input.name)}_${nanoid(6)}`;
    const bundleId = `src_${slug(projectId)}_default`;
    await this.adapter.query("BEGIN");
    try {
      await this.adapter.query(
        `INSERT INTO projects (project_id, name, description, status, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,'active',$4,$5,$5)`,
        [projectId, input.name.trim(), input.description?.trim() ?? "", input.createdBy, now],
      );
      await this.adapter.query(
        `INSERT INTO source_bundles (bundle_id, project_id, name, description, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [bundleId, projectId, "默认资料库", "gamedata 表格 + gamedocs 文档统一版本化", now],
      );
      await this.adapter.query("COMMIT");
    } catch (error) {
      await this.adapter.query("ROLLBACK");
      throw error;
    }
    return {
      project: (await this.getProject(projectId))!,
      bundle: (await this.getDefaultBundle(projectId))!,
    };
  }

  async updateProject(projectId: string, patch: { name?: string; description?: string; status?: "active" | "archived" }): Promise<ProjectRecord | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) { sets.push(`name = $${params.length + 1}`); params.push(patch.name.trim()); }
    if (patch.description !== undefined) { sets.push(`description = $${params.length + 1}`); params.push(patch.description); }
    if (patch.status !== undefined) { sets.push(`status = $${params.length + 1}`); params.push(patch.status); }
    if (sets.length === 0) return this.getProject(projectId);
    sets.push(`updated_at = $${params.length + 1}`);
    params.push(new Date().toISOString());
    params.push(projectId);
    const { rows } = await this.adapter.query(
      `UPDATE projects SET ${sets.join(", ")} WHERE project_id = $${params.length} RETURNING *`,
      params,
    );
    return rows.length ? mapProject(rows[0]) : null;
  }

  async selectProject(username: string, projectId: string): Promise<UserRecord | null> {
    await this.requireProject(projectId);
    const { rows } = await this.adapter.query(
      `UPDATE users SET current_project_id = $2 WHERE username = $1 RETURNING *`,
      [username, projectId],
    );
    if (rows.length === 0) return null;
    return mapUser(rows[0]);
  }

  async getDefaultBundle(projectId: string): Promise<SourceBundle | null> {
    const { rows } = await this.adapter.query(
      "SELECT * FROM source_bundles WHERE project_id = $1 ORDER BY created_at ASC, bundle_id ASC LIMIT 1",
      [projectId],
    );
    return rows.length ? mapSourceBundle(rows[0]) : null;
  }
}

function mapSourceBundle(row: Record<string, unknown>): SourceBundle {
  return {
    bundleId: String(row.bundle_id),
    projectId: String(row.project_id ?? "default_project"),
    name: String(row.name),
    description: String(row.description ?? ""),
    createdAt: String(row.created_at),
  };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 40) || "project";
}
