import { postJson } from "./http";

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

export async function runSvnSync(input?: {
  projectId?: string;
  skipSvnUpdate?: boolean;
}): Promise<{ result: SvnSyncResult }> {
  return postJson<{ result: SvnSyncResult }>("/api/ops/svn-sync", input ?? {});
}
