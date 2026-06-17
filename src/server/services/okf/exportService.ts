import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative } from "node:path";

import type { AssetComponent, AssetPackage, DatabaseHandle, ReleaseRecord } from "../../types";
import { renderReportMarkdown } from "./reportRender";
import { scanWorkspace } from "./conformanceService";
import { OKF_EXPORTER_VERSION, type ConformanceReport } from "./types";

const EXPORTABLE_MARKDOWN_KINDS = new Set(["wiki_page", "table_wiki_page"]);

export interface OkfExportManifest {
  bundleUri: string;
  reportUri: string;
  reportMarkdownUri: string;
  exporterVersion: number;
  okfVersion: "0.1";
  bundleHash: string;
  summary: ConformanceReport["summary"];
  linkSummary: ConformanceReport["linkSummary"];
  citationSummary: ConformanceReport["citationSummary"];
}

export interface OkfExportResult {
  manifest: OkfExportManifest;
  report: ConformanceReport;
}

export interface ExportReleaseOkfInput {
  release: ReleaseRecord;
  packages: AssetPackage[];
  components: AssetComponent[];
  publishedAt: string;
  activeRuleProfileHash: string;
}

export function createOkfExportService(db: DatabaseHandle, dataDir: string) {
  return new OkfExportService(db, dataDir);
}

export class OkfExportService {
  private readonly adapter;

  constructor(private readonly db: DatabaseHandle, private readonly dataDir: string) {
    this.adapter = db.adapter;
  }

  async exportRelease(input: ExportReleaseOkfInput): Promise<OkfExportResult> {
    const releaseDir = join(this.dataDir, "releases", input.release.releaseId);
    const bundleDir = join(releaseDir, "okf_bundle");
    rmSync(bundleDir, { recursive: true, force: true });
    mkdirSync(bundleDir, { recursive: true });

    const exportedPaths: string[] = [];
    const packageById = new Map(input.packages.map((pkg) => [pkg.packageId, pkg] as const));
    const evidenceByComponent = await this.evidenceByComponent(input.components.map((component) => component.componentId));

    for (const component of input.components) {
      if (!EXPORTABLE_MARKDOWN_KINDS.has(component.kind)) continue;
      const okfPath = okfPathForComponent(component);
      if (!okfPath) continue;
      const sourcePath = resolveComponentFile(this.dataDir, component, packageById.get(component.packageId));
      const raw = readFileSync(sourcePath, "utf8");
      const body = stripFrontmatter(raw).trim();
      const rendered = renderOkfMarkdown({
        component,
        body,
        okfPath,
        publishedAt: input.publishedAt,
        activeRuleProfileHash: input.activeRuleProfileHash,
        evidenceRows: evidenceByComponent.get(component.componentId) ?? [],
      });
      const target = join(bundleDir, ...okfPath.split(posix.sep));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, rendered, "utf8");
      exportedPaths.push(okfPath);
    }

    writeFileSync(join(bundleDir, "index.md"), renderIndex(input.release, exportedPaths), "utf8");
    writeFileSync(join(bundleDir, "log.md"), renderLog(input.release, input.publishedAt, input.packages), "utf8");

    const report = await scanWorkspace(bundleDir, { now: input.publishedAt });
    const reportUri = posix.join("releases", input.release.releaseId, "okf_report.json");
    const reportMarkdownUri = posix.join("releases", input.release.releaseId, "okf_report.md");
    writeFileSync(join(this.dataDir, ...reportUri.split(posix.sep)), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    writeFileSync(join(this.dataDir, ...reportMarkdownUri.split(posix.sep)), renderReportMarkdown(report), "utf8");

    if (report.summary.blocking > 0) {
      throw new Error(`OKF conformance failed with ${report.summary.blocking} blocking issue(s).`);
    }

    return {
      report,
      manifest: {
        bundleUri: posix.join("releases", input.release.releaseId, "okf_bundle"),
        reportUri,
        reportMarkdownUri,
        exporterVersion: OKF_EXPORTER_VERSION,
        okfVersion: report.okfVersion,
        bundleHash: hashExportedBundle(bundleDir, exportedPaths),
        summary: report.summary,
        linkSummary: report.linkSummary,
        citationSummary: report.citationSummary,
      },
    };
  }

  private async evidenceByComponent(componentIds: string[]): Promise<Map<string, EvidenceRow[]>> {
    if (componentIds.length === 0) return new Map();
    const placeholders = componentIds.map((_, index) => `$${index + 1}`).join(",");
    const { rows } = await this.adapter.query(
      `SELECT evidence_id, component_id, source_version_id, quote, note, confidence
       FROM evidence_records
       WHERE component_id IN (${placeholders})
       ORDER BY component_id, created_at, evidence_id`,
      componentIds,
    );
    const out = new Map<string, EvidenceRow[]>();
    for (const row of rows) {
      const componentId = String(row.component_id);
      out.set(componentId, [...(out.get(componentId) ?? []), {
        evidenceId: String(row.evidence_id),
        sourceVersionId: String(row.source_version_id ?? ""),
        quote: String(row.quote ?? ""),
        note: String(row.note ?? ""),
        confidence: Number(row.confidence ?? 0),
      }]);
    }
    return out;
  }
}

interface EvidenceRow {
  evidenceId: string;
  sourceVersionId: string;
  quote: string;
  note: string;
  confidence: number;
}

function okfPathForComponent(component: AssetComponent): string | null {
  const candidate = (component.artifactId || component.legacyPath).replace(/\\/g, "/");
  if (!candidate.endsWith(".md")) return null;
  const withoutWiki = candidate.startsWith("wiki/") ? candidate.slice("wiki/".length) : candidate;
  if (basename(withoutWiki) === "index.md") return null;
  return withoutWiki.split("/").filter(Boolean).join(posix.sep);
}

function okfTypeForPath(okfPath: string): string {
  if (okfPath.startsWith("systems/")) return "system_rule";
  if (okfPath.startsWith("activities/")) return "activity_template";
  if (okfPath.startsWith("tables/")) return "table_schema";
  if (okfPath.startsWith("ui_flows/")) return "ui_flow";
  if (okfPath.startsWith("numeric_rules/")) return "numerical_convention";
  if (okfPath.startsWith("fields/")) return "field_spec";
  if (okfPath.startsWith("concepts/")) return "concept";
  return "knowledge_note";
}

function resolveComponentFile(dataDir: string, component: AssetComponent, pkg?: AssetPackage): string {
  if (component.storageUri.startsWith("legacy://")) {
    throw new Error(`Cannot export legacy-only component to OKF: ${component.componentId}`);
  }
  const runRoot = pkg?.createdByRunId ? join(dataDir, "kb-build-runs", pkg.createdByRunId) : "";
  const candidates = [
    isAbsolute(component.storageUri) ? component.storageUri : "",
    runRoot ? join(runRoot, component.storageUri) : "",
    join(dataDir, component.storageUri),
  ].filter(Boolean);
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (!resolved) throw new Error(`OKF export artifact file not found for ${component.componentId}: ${component.storageUri}`);

  const allowedRoots = [runRoot, dataDir].filter(Boolean);
  const contained = allowedRoots.some((root) => {
    const rel = relative(root, resolved);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  if (!contained) throw new Error(`Refusing to export file outside allowed roots: ${component.componentId}`);
  return resolved;
}

function stripFrontmatter(markdown: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/u.exec(markdown);
  return match ? match[1] : markdown;
}

function renderOkfMarkdown(input: {
  component: AssetComponent;
  body: string;
  okfPath: string;
  publishedAt: string;
  activeRuleProfileHash: string;
  evidenceRows: EvidenceRow[];
}): string {
  const type = okfTypeForPath(input.okfPath);
  const title = input.component.title || input.okfPath.replace(/\.md$/u, "");
  const body = input.body || `# ${title}\n`;
  const description = firstTextLine(body) || title;
  const frontmatter = [
    "---",
    `type: ${yamlString(type)}`,
    `title: ${yamlString(title)}`,
    `description: ${yamlString(description)}`,
    `tags: [${unique([input.component.group, input.component.kind, type]).map(yamlString).join(", ")}]`,
    `timestamp: ${yamlString(input.publishedAt)}`,
    `resource: ${yamlString(`kh://component/${input.component.componentId}`)}`,
    "kh:",
    `  componentId: ${yamlString(input.component.componentId)}`,
    `  packageId: ${yamlString(input.component.packageId)}`,
    `  artifactId: ${yamlString(input.component.artifactId)}`,
    `  legislationProfileHash: ${yamlString(input.activeRuleProfileHash)}`,
    "---",
    "",
  ].join("\n");
  return `${frontmatter}${body.trim()}\n${renderCitations(input.evidenceRows)}`;
}

function renderCitations(rows: EvidenceRow[]): string {
  if (rows.length === 0) return "\n";
  const lines = ["", "# Citations", ""];
  rows.forEach((row, index) => {
    const quote = row.quote.replace(/\s+/g, " ").trim();
    const note = row.note ? `; ${row.note.replace(/\s+/g, " ").trim()}` : "";
    lines.push(`${index + 1}. ${quote || "Evidence record"} (${row.evidenceId}; source ${row.sourceVersionId}; confidence ${row.confidence}${note})`);
  });
  return `${lines.join("\n")}\n`;
}

function renderIndex(release: ReleaseRecord, paths: string[]): string {
  return [
    "# OKF Bundle Index",
    "",
    `Release: ${release.version}`,
    "",
    ...paths.sort().map((okfPath) => `- [${okfPath}](/${okfPath})`),
    "",
  ].join("\n");
}

function renderLog(release: ReleaseRecord, publishedAt: string, packages: AssetPackage[]): string {
  return [
    "# OKF Bundle Log",
    "",
    `- releaseId: ${release.releaseId}`,
    `- version: ${release.version}`,
    `- publishedAt: ${publishedAt}`,
    `- packageIds: ${packages.map((pkg) => pkg.packageId).sort().join(", ")}`,
    "",
  ].join("\n");
}

function firstTextLine(markdown: string): string {
  return markdown
    .split(/\r?\n/u)
    .map((line) => line.replace(/^#+\s*/u, "").trim())
    .find((line) => line.length > 0 && !line.startsWith("|")) ?? "";
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function hashExportedBundle(bundleDir: string, exportedPaths: string[]): string {
  const hash = createHash("sha256");
  for (const rel of ["index.md", "log.md", ...exportedPaths.sort()]) {
    const full = join(bundleDir, ...rel.split(posix.sep));
    if (!existsSync(full)) continue;
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(full));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}
