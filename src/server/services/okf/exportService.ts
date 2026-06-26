import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative } from "node:path";

import type { AssetComponent, AssetPackage, DatabaseHandle, ReleaseRecord } from "../../types";
import { trustFromQuality } from "../trustScore";
import { renderReportMarkdown } from "./reportRender";
import { scanWorkspace } from "./conformanceService";
import { buildOkfSearchIndex } from "./searchIndex";
import { OKF_EXPORTER_VERSION, type ConformanceReport } from "./types";
import {
  renderReleaseAuditLog,
  withOkfAuditSummary,
  type ReleaseAuditSummary
} from "../releaseAudit";

const EXPORTABLE_MARKDOWN_KINDS = new Set(["wiki_page", "table_wiki_page"]);

export interface OkfExportManifest {
  bundleUri: string;
  reportUri: string;
  reportMarkdownUri: string;
  graphUri?: string;
  tableSchemasUri?: string;
  tableAliasesUri?: string;
  searchIndexUri?: string;
  logUri: string;
  exporterVersion: number;
  okfVersion: "0.1";
  bundleHash: string;
  summary: ConformanceReport["summary"];
  linkSummary: ConformanceReport["linkSummary"];
  citationSummary: ConformanceReport["citationSummary"];
  auditSummary: ReleaseAuditSummary;
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
  auditSummary: ReleaseAuditSummary;
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
    const graphUri = exportGraphAsset(this.dataDir, bundleDir, input.components, packageById);
    const tableSchemasUri = exportTableSchemasAsset(this.dataDir, bundleDir, input.components, packageById, input.release, input.packages);
    const tableAliasesUri = exportTableAliasesAsset(this.dataDir, bundleDir, input.components, packageById);
    exportedPaths.push(...[graphUri, tableSchemasUri, tableAliasesUri].filter((uri): uri is string => Boolean(uri)));

    const searchPages: Array<{ okfPath: string; markdown: string }> = [];
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
      searchPages.push({ okfPath: `/${okfPath}`, markdown: rendered });
      exportedPaths.push(okfPath);
    }

    const searchIndexUri = exportSearchIndexAsset(bundleDir, input.publishedAt, searchPages);
    if (searchIndexUri) exportedPaths.push(searchIndexUri);

    writeFileSync(join(bundleDir, "index.md"), renderIndex(input.release, exportedPaths), "utf8");
    writeFileSync(join(bundleDir, "log.md"), renderReleaseAuditLog(input.auditSummary), "utf8");

    const report = await scanWorkspace(bundleDir, { now: input.publishedAt });
    const reportUri = posix.join("releases", input.release.releaseId, "okf_report.json");
    const reportMarkdownUri = posix.join("releases", input.release.releaseId, "okf_report.md");
    writeFileSync(join(this.dataDir, ...reportUri.split(posix.sep)), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    writeFileSync(join(this.dataDir, ...reportMarkdownUri.split(posix.sep)), renderReportMarkdown(report), "utf8");
    const auditSummary = withOkfAuditSummary(input.auditSummary, report, { reportUri, reportMarkdownUri });
    writeFileSync(join(bundleDir, "log.md"), renderReleaseAuditLog(auditSummary), "utf8");

    if (report.summary.blocking > 0) {
      throw new Error(`OKF conformance failed with ${report.summary.blocking} blocking issue(s).`);
    }

    return {
      report,
      manifest: {
        bundleUri: posix.join("releases", input.release.releaseId, "okf_bundle"),
        reportUri,
        reportMarkdownUri,
        graphUri,
        tableSchemasUri,
        tableAliasesUri,
        searchIndexUri,
        logUri: posix.join("releases", input.release.releaseId, "okf_bundle", "log.md"),
        exporterVersion: OKF_EXPORTER_VERSION,
        okfVersion: report.okfVersion,
        bundleHash: hashExportedBundle(bundleDir, exportedPaths),
        summary: report.summary,
        linkSummary: report.linkSummary,
        citationSummary: report.citationSummary,
        auditSummary,
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

interface TableSchemaJson {
  table_name?: string;
  rel_path?: string;
  fields?: string[];
  row_count?: number;
  sheets?: string[];
}

interface TableAliasRow {
  table?: string;
  canonical?: string;
  canonicalName?: string;
  aliases?: unknown;
}

function okfPathForComponent(component: AssetComponent): string | null {
  const candidate = (component.artifactId || component.legacyPath).replace(/\\/g, "/");
  if (!candidate.endsWith(".md")) return null;
  const withoutWiki = candidate.startsWith("wiki/") ? candidate.slice("wiki/".length) : candidate;
  if (basename(withoutWiki) === "index.md") return null;
  return withoutWiki.split("/").filter(Boolean).join(posix.sep);
}

function okfTypeForComponent(component: AssetComponent, okfPath: string): string {
  if (component.kind === "table_wiki_page") return "table_registry";
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

function exportGraphAsset(dataDir: string, bundleDir: string, components: AssetComponent[], packageById: Map<string, AssetPackage>): string | undefined {
  const component = components.find((item) => item.kind === "graph_snapshot");
  if (!component) return undefined;
  const graph = JSON.parse(readFileSync(resolveComponentFile(dataDir, component, packageById.get(component.packageId)), "utf8")) as Record<string, unknown>;
  const uri = "graph/graph.json";
  writeJsonAsset(bundleDir, uri, {
    okfAssetType: "knowledge_graph",
    componentId: component.componentId,
    packageId: component.packageId,
    artifactId: component.artifactId,
    trust: trustFromQuality(component.quality),
    nodes: Array.isArray(graph.nodes) ? graph.nodes : [],
    edges: Array.isArray(graph.edges) ? graph.edges : [],
  });
  return uri;
}

function exportTableSchemasAsset(dataDir: string, bundleDir: string, components: AssetComponent[], packageById: Map<string, AssetPackage>, release: ReleaseRecord, packages: AssetPackage[]): string | undefined {
  const schemaComponents = components.filter((item) => item.kind === "table_schema_json");
  const registryComponents = components.filter((item) => item.kind === "table_registry");
  const tables = schemaComponents.flatMap((component) => {
    const schema = JSON.parse(readFileSync(resolveComponentFile(dataDir, component, packageById.get(component.packageId)), "utf8")) as TableSchemaJson;
    return normalizeTableSchemas(schema, component, packages);
  });
  if (tables.length === 0) {
    for (const component of registryComponents) {
      const registry = JSON.parse(readFileSync(resolveComponentFile(dataDir, component, packageById.get(component.packageId)), "utf8")) as Record<string, TableSchemaJson>;
      for (const [tableName, schema] of Object.entries(registry)) {
        tables.push(...normalizeTableSchemas({ table_name: tableName, ...schema }, component, packages));
      }
    }
  }
  if (tables.length === 0) return undefined;
  const uri = "tables/schemas.json";
  writeJsonAsset(bundleDir, uri, {
    okfAssetType: "table_schema_manifest",
    releaseId: release.releaseId,
    sourceVersionIds: packageSourceVersionIds(packages),
    tables: tables.sort((a, b) => a.schema.table_name.localeCompare(b.schema.table_name)),
  });
  return uri;
}

function exportTableAliasesAsset(dataDir: string, bundleDir: string, components: AssetComponent[], packageById: Map<string, AssetPackage>): string | undefined {
  const component = components.find((item) => item.kind === "table_registry" && /(?:^|\/)table_aliases\.json$/u.test(item.artifactId));
  if (!component) return undefined;
  const rows = readAliasRows(resolveComponentFile(dataDir, component, packageById.get(component.packageId)));
  if (rows.length === 0) return undefined;
  const uri = "tables/aliases.json";
  writeJsonAsset(bundleDir, uri, {
    okfAssetType: "table_alias_manifest",
    componentId: component.componentId,
    packageId: component.packageId,
    artifactId: component.artifactId,
    trust: trustFromQuality(component.quality),
    aliases: rows,
  });
  return uri;
}

function exportSearchIndexAsset(bundleDir: string, generatedAt: string, pages: Array<{ okfPath: string; markdown: string }>): string | undefined {
  if (pages.length === 0) return undefined;
  const uri = "search/index.json";
  writeJsonAsset(bundleDir, uri, buildOkfSearchIndex({ generatedAt, pages, bundleDir }));
  return uri;
}

function readAliasRows(path: string): Array<{ table: string; aliases: string[] }> {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (Array.isArray(raw)) {
    return raw
      .map((row) => {
        const record = row as TableAliasRow;
        const table = stringValue(record.table) || stringValue(record.canonical) || stringValue(record.canonicalName);
        const aliases = Array.isArray(record.aliases) ? record.aliases.filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0).map((alias) => alias.trim()) : [];
        return table ? { table, aliases } : null;
      })
      .filter((row): row is { table: string; aliases: string[] } => row !== null && row.aliases.length > 0);
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>)
      .flatMap(([table, value]) => {
        if (typeof value === "string" && value.trim()) return [{ table, aliases: [value.trim()] }];
        if (Array.isArray(value)) return [{ table, aliases: value.filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0).map((alias) => alias.trim()) }];
        if (value && typeof value === "object") {
          const aliases = (value as { aliases?: unknown }).aliases;
          if (Array.isArray(aliases)) return [{ table, aliases: aliases.filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0).map((alias) => alias.trim()) }];
        }
        return [];
      })
      .filter((row) => row.table && row.aliases.length > 0);
  }
  return [];
}

function normalizeTableSchemas(schema: TableSchemaJson, component: AssetComponent, packages: AssetPackage[]) {
  if (!schema.table_name || !schema.rel_path) return [];
  return [{
    componentId: component.componentId,
    packageId: component.packageId,
    artifactId: component.artifactId,
    trust: trustFromQuality(component.quality),
    sourceVersionIds: packageSourceVersionIds(packages),
    schema: {
      table_name: schema.table_name,
      rel_path: schema.rel_path,
      fields: Array.isArray(schema.fields) ? schema.fields : [],
      row_count: Number(schema.row_count ?? 0),
      sheets: Array.isArray(schema.sheets) ? schema.sheets : undefined,
    },
  }];
}

function writeJsonAsset(bundleDir: string, uri: string, value: unknown): void {
  const target = join(bundleDir, ...uri.split(posix.sep));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function packageSourceVersionIds(packages: AssetPackage[]): string[] {
  return unique(packages.flatMap((pkg) => pkg.sourceVersionIds)).sort();
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
  const type = okfTypeForComponent(input.component, input.okfPath);
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
    ...renderTrustFrontmatter(input.component),
    "---",
    "",
  ].join("\n");
  return `${frontmatter}${body.trim()}\n${renderTrustSection(input.component)}${renderCitations(input.evidenceRows)}`;
}

function renderTrustFrontmatter(component: AssetComponent): string[] {
  const trust = trustFromQuality(component.quality);
  if (!trust) return [];
  return [
    "  trust:",
    `    version: ${yamlString(trust.version)}`,
    `    score: ${trust.score}`,
    `    status: ${yamlString(trust.status)}`,
    `    evidence: ${trust.breakdown.evidence}`,
    `    completeness: ${trust.breakdown.completeness}`,
    `    auditFreshness: ${trust.breakdown.auditFreshness}`,
    `    consistency: ${trust.breakdown.consistency}`,
    `    lastTrustedAuditAt: ${yamlString(trust.lastTrustedAuditAt ?? "")}`,
  ];
}

function renderTrustSection(component: AssetComponent): string {
  const trust = trustFromQuality(component.quality);
  if (!trust) return "";
  const caps = trust.caps.length ? trust.caps.map((cap) => cap.label).join("; ") : "none";
  return [
    "",
    "# Trust",
    "",
    `- score: ${trust.score}`,
    `- status: ${trust.status}`,
    `- evidence: ${trust.breakdown.evidence}`,
    `- completeness: ${trust.breakdown.completeness}`,
    `- auditFreshness: ${trust.breakdown.auditFreshness}`,
    `- consistency: ${trust.breakdown.consistency}`,
    `- caps: ${caps}`,
    "",
  ].join("\n");
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

function firstTextLine(markdown: string): string {
  return markdown
    .split(/\r?\n/u)
    .map((line) => line.replace(/^#+\s*/u, "").trim())
    .find((line) => line.length > 0 && !line.startsWith("|")) ?? "";
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
