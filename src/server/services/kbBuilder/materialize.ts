import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import type { DatabaseHandle } from "../../types";
import type { SourceBundleService } from "../sourceBundleService";
import type { RunWorkspace } from "./types";

export async function materializeSourceVersion(options: {
  db: DatabaseHandle;
  sourceService: SourceBundleService;
  versionId: string;
  workspaceRoot: string;
  runId: string;
}): Promise<RunWorkspace> {
  const files = await options.sourceService.listFiles(options.versionId);
  const workspaceDir = join(options.workspaceRoot, options.runId);
  const dataDir = join(workspaceDir, "data");
  rmSync(workspaceDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });

  for (const file of files) {
    const read = await options.sourceService.readFile(options.versionId, file.logicalPath);
    if (!read) throw new Error(`Source file content missing: ${file.logicalPath}`);
    const relative = normalize(file.logicalPath).replace(/^(\.\.[/\\])+/, "");
    if (!relative.startsWith("gamedocs") && !relative.startsWith("gamedata")) {
      throw new Error(`Unsupported source logical path: ${file.logicalPath}`);
    }
    const target = join(dataDir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, read.content);
  }

  return { runId: options.runId, workspaceDir, dataDir, files };
}
