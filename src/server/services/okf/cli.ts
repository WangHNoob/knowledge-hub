// src/server/services/okf/cli.ts
import { promises as fs } from "node:fs";
import path from "node:path";

import { scanWorkspace } from "./conformanceService";
import { renderReportMarkdown } from "./reportRender";

async function main(): Promise<void> {
  const dir = process.argv[2] ?? path.resolve("knowledge/wiki");
  const outDir = process.argv[3] ?? process.cwd();
  const report = await scanWorkspace(dir, { now: new Date().toISOString() });
  await fs.writeFile(path.join(outDir, "okf_report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(outDir, "okf_report.md"), renderReportMarkdown(report), "utf8");
  console.log(
    `OKF scan of ${dir}: ${report.conceptCount} concepts, ` +
      `${report.summary.blocking} blocking, ${report.summary.warning} warning. ` +
      `Reports written to ${outDir}.`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
