// src/server/services/okf/reportRender.ts
import type { ConformanceReport, OkfIssue } from "./types";

export function renderReportMarkdown(report: ConformanceReport): string {
  const lines: string[] = [
    "# OKF Conformance Report",
    "",
    `- scannedAt: ${report.scannedAt}`,
    `- okfVersion: ${report.okfVersion}`,
    `- conceptCount: ${report.conceptCount}`,
    `- blocking: ${report.summary.blocking}`,
    `- warning: ${report.summary.warning}`,
    `- links: resolved ${report.linkSummary.resolved} / ambiguous ${report.linkSummary.ambiguous} / unresolved ${report.linkSummary.unresolved}`,
    `- citations: ${report.citationSummary.present}/${report.citationSummary.required}`,
    "",
  ];

  const byPath = new Map<string, OkfIssue[]>();
  for (const issue of report.issues) {
    byPath.set(issue.okfPath, [...(byPath.get(issue.okfPath) ?? []), issue]);
  }

  for (const okfPath of [...byPath.keys()].sort()) {
    lines.push(`## ${okfPath}`, "");
    for (const issue of byPath.get(okfPath) ?? []) {
      const tag = issue.blocking ? "BLOCKING" : "warning";
      lines.push(`- [${tag}] ${issue.issueType} (${issue.layer}) — ${issue.message}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
