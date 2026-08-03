import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { config } from "../config";
import type { RouteContext } from "../routes/context";

const execFileAsync = promisify(execFile);

export interface SvnSyncResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  svnUpdated: boolean;
  svnOutput?: string;
  projectId: string;
  versionId?: string;
  label?: string;
  changedFileCount?: number;
  sync?: unknown;
}

/** 策划资料 SVN → 建版本 → 飞轮同步发布。 */
export async function runSvnSyncIngest(
  ctx: RouteContext,
  input: { projectId?: string; requestedBy: string; skipSvnUpdate?: boolean },
): Promise<SvnSyncResult> {
  const projectId = input.projectId ?? "default_project";
  if (!config.svnSyncEnabled) {
    return { ok: false, skipped: true, reason: "KH_SVN_SYNC_ENABLED 未开启", svnUpdated: false, projectId };
  }
  const wcPath = config.svnWcPath.trim();
  if (!wcPath) {
    return { ok: false, skipped: true, reason: "未配置 KH_SVN_WC_PATH", svnUpdated: false, projectId };
  }
  const rootPath = resolve(wcPath);
  if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
    return { ok: false, reason: `SVN 工作副本不存在或不是目录: ${rootPath}`, svnUpdated: false, projectId };
  }

  let svnUpdated = false;
  let svnOutput = "";
  if (!input.skipSvnUpdate) {
    const cmd = config.svnUpdateCommand.trim() || "svn update";
    const parts = cmd.split(/\s+/).filter(Boolean);
    const bin = parts[0] ?? "svn";
    const args = parts.slice(1);
    try {
      const { stdout, stderr } = await execFileAsync(bin, [...args], {
        cwd: rootPath,
        timeout: 10 * 60 * 1000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      });
      svnUpdated = true;
      svnOutput = `${stdout ?? ""}${stderr ?? ""}`.trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `svn update 失败: ${message}`, svnUpdated: false, projectId, svnOutput };
    }
  }

  const bundle = await ctx.projectService.getDefaultBundle(projectId);
  if (!bundle) {
    return {
      ok: false,
      reason: `项目 ${projectId} 还没有资料库，请先在 Hub 创建项目/资料库。`,
      svnUpdated,
      svnOutput,
      projectId,
    };
  }

  const imported = await ctx.bundleService.importDirectoryAsVersion({
    rootPath,
    bundleId: bundle.bundleId,
    projectId,
    note: `svn-sync ${new Date().toISOString()}`,
    createdBy: input.requestedBy,
  });

  const sync = await ctx.flywheelService.sync({
    projectId,
    requestedBy: input.requestedBy,
    mode: "incremental",
  });

  return {
    ok: true,
    svnUpdated,
    svnOutput: svnOutput.slice(0, 4000),
    projectId,
    versionId: imported.version.versionId,
    label: imported.version.label,
    changedFileCount: imported.changes.length,
    sync,
  };
}
