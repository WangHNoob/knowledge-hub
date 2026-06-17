// src/server/services/okf/conformanceService.ts
import { promises as fs } from "node:fs";
import path from "node:path";

import { scanFrontmatter } from "./frontmatter";
import { scanMarkdown } from "./markdownScan";
import { OKF_EXPORTER_VERSION, type ConformanceReport, type OkfIssue, type OkfIssueLayer, type OkfIssueType } from "./types";

const RESERVED = new Set(["index.md", "log.md"]);
const OPTIONAL_FIELDS: Array<{ key: string; issueType: OkfIssueType }> = [
  { key: "description", issueType: "missing_description" },
  { key: "tags", issueType: "missing_tags" },
  { key: "timestamp", issueType: "missing_timestamp" },
  { key: "resource", issueType: "missing_resource" },
];
const CITATION_REQUIRED_TYPES = new Set([
  "system_rule",
  "activity_template",
  "table_schema",
  "ui_flow",
  "numerical_convention",
]);

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function issue(okfPath: string, issueType: OkfIssueType, layer: OkfIssueLayer, blocking: boolean, message: string): OkfIssue {
  return { okfPath, issueType, layer, blocking, message };
}

async function listMarkdown(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue; // avoid symlink cycles when scanning arbitrary dirs
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
    }
  }
  await walk(root);
  out.sort();
  return out;
}

export function createOkfConformanceService() {
  return { scanWorkspace };
}

export async function scanWorkspace(dir: string, opts: { now: string }): Promise<ConformanceReport> {
  const files = await listMarkdown(dir);
  const present = new Set(files.map((f) => `/${toPosix(path.relative(dir, f))}`));

  const issues: OkfIssue[] = [];
  let conceptCount = 0;
  let resolved = 0;
  let unresolved = 0;
  let citationRequired = 0;
  let citationPresent = 0;

  for (const file of files) {
    const okfPath = `/${toPosix(path.relative(dir, file))}`;
    if (RESERVED.has(path.basename(file))) continue; // reserved files are not concepts
    conceptCount += 1;

    const raw = await fs.readFile(file, "utf8");
    const fm = scanFrontmatter(raw);

    if (!fm.hasFrontmatter) {
      issues.push(
        fm.unparseable
          ? issue(okfPath, "unparseable_yaml", "okf_conformance", true, "frontmatter opened with --- but has no closing ---")
          : issue(okfPath, "missing_frontmatter", "okf_conformance", true, "no YAML frontmatter block"),
      );
      continue;
    }

    if (fm.type === "") {
      issues.push(issue(okfPath, "missing_type", "okf_conformance", true, "frontmatter has empty or missing type"));
    }

    for (const field of OPTIONAL_FIELDS) {
      if (!fm.keys.has(field.key)) {
        issues.push(issue(okfPath, field.issueType, "kh_publish_quality", false, `missing optional field: ${field.key}`));
      }
    }

    const links = scanMarkdown(fm.body);
    for (const inner of links.obsidian) {
      issues.push(issue(okfPath, "obsidian_link", "kh_publish_quality", false, `non-standard obsidian link: [[${inner}]]`));
      unresolved += 1;
    }
    for (const target of links.bundleLinks) {
      if (present.has(target)) {
        resolved += 1;
      } else {
        issues.push(issue(okfPath, "broken_link", "kh_publish_quality", false, `link target not found: ${target}`));
        unresolved += 1;
      }
    }

    if (CITATION_REQUIRED_TYPES.has(fm.type)) {
      citationRequired += 1;
      if (links.hasCitations) citationPresent += 1;
      else issues.push(issue(okfPath, "missing_citation", "kh_publish_quality", false, `${fm.type} page has no # Citations section`));
    }
  }

  const summary = {
    blocking: issues.filter((i) => i.blocking).length,
    warning: issues.filter((i) => !i.blocking).length,
    info: 0,
  };

  return {
    okfVersion: "0.1",
    exporterVersion: OKF_EXPORTER_VERSION,
    scannedAt: opts.now,
    conceptCount,
    referenceCount: 0,
    issues,
    summary,
    linkSummary: { resolved, ambiguous: 0, unresolved },
    citationSummary: { required: citationRequired, present: citationPresent },
  };
}
