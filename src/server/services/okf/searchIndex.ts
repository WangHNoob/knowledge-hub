import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { TrustScore } from "../../types";

export interface OkfSearchIndex {
  okfAssetType: "search_index";
  version: "v1";
  generatedAt: string;
  pages: OkfSearchPage[];
}

export interface OkfSearchPage {
  componentId: string;
  title: string;
  artifactId: string;
  okfPath: string;
  kind: string;
  type: string;
  trust: TrustScore | null;
  fields: {
    title: string;
    path: string;
    type: string;
    headings: string[];
    body: string;
    dataDependencies: string;
    tables: string[];
    citations: string[];
  };
  terms: Record<SearchField, string[]>;
}

export interface OkfSearchResultItem {
  componentId: string;
  title: string;
  artifactId: string;
  okfPath: string;
  kind: string;
  type: string;
  trust: TrustScore | null;
  snippet: string;
  score: number;
  matchedTerms: string[];
  matchedFields: string[];
  why: string[];
  tableDependencies: string[];
}

export type SearchField = "title" | "path" | "type" | "headings" | "body" | "dataDependencies" | "tables" | "citations";

interface BuildPageInput {
  okfPath: string;
  markdown: string;
}

interface GraphAsset {
  nodes?: Array<{ id?: string; label?: string; wiki_page?: string }>;
  edges?: Array<{ source?: string; target?: string; relation?: string }>;
}

interface TableAliasManifest {
  aliases?: Array<{ table?: string; canonical?: string; canonicalName?: string; aliases?: string[] }>;
}

const FIELD_WEIGHTS: Record<SearchField, number> = {
  title: 8,
  path: 5,
  type: 3,
  headings: 5,
  body: 1,
  dataDependencies: 4,
  tables: 5,
  citations: 1,
};

const INTENT_TERMS: Array<{ triggers: string[]; expansions: string[]; reason: string }> = [
  {
    triggers: ["活动结构", "结构", "玩法结构", "活动流程"],
    expansions: ["活动目标", "开放条件", "玩法流程", "奖励与消耗", "关联配置表", "data dependencies"],
    reason: "活动结构意图扩展",
  },
  {
    triggers: ["配置", "配置表", "表字段", "字段", "查表"],
    expansions: ["关联配置表", "data dependencies", "table schema", "fields", "configured_in"],
    reason: "配置表意图扩展",
  },
  {
    triggers: ["证据", "来源", "依据", "可信", "可靠"],
    expansions: ["证据", "citations", "source", "trust"],
    reason: "证据追溯意图扩展",
  },
];

export function buildOkfSearchIndex(input: {
  generatedAt: string;
  pages: BuildPageInput[];
  bundleDir: string;
}): OkfSearchIndex {
  const graphTablesByPage = graphTablesByPageTitle(input.bundleDir);
  const aliasTermsByTable = tableAliasTermsByCanonical(input.bundleDir);
  return {
    okfAssetType: "search_index",
    version: "v1",
    generatedAt: input.generatedAt,
    pages: input.pages
      .map(({ okfPath, markdown }) => pageFromMarkdown(okfPath, markdown, graphTablesByPage, aliasTermsByTable))
      .filter((page): page is OkfSearchPage => page !== null)
      .sort((a, b) => a.okfPath.localeCompare(b.okfPath)),
  };
}

export function searchOkfIndex(index: OkfSearchIndex, query: string, limit = 10): OkfSearchResultItem[] {
  const normalizedQuery = normalizeText(query);
  const expanded = expandQuery(query);
  const queryTerms = unique([...tokenizeSearchText(query), ...expanded.terms]);
  if (queryTerms.length === 0) return [];

  const items: OkfSearchResultItem[] = [];
  for (const page of index.pages) {
    const matchedTerms = new Set<string>();
    const matchedFields = new Set<string>();
    const why: string[] = [];
    let score = 0;

    for (const field of Object.keys(FIELD_WEIGHTS) as SearchField[]) {
      const pageTerms = new Set(page.terms[field] ?? []);
      const fieldMatches = queryTerms.filter((term) => pageTerms.has(term));
      if (fieldMatches.length === 0) continue;
      matchedFields.add(field);
      fieldMatches.forEach((term) => matchedTerms.add(term));
      score += fieldMatches.length * FIELD_WEIGHTS[field];
      why.push(`${field} 命中：${fieldMatches.slice(0, 5).join(", ")}`);
    }

    const pageText = normalizeText([
      page.fields.title,
      page.fields.path,
      page.fields.type,
      page.fields.headings.join(" "),
      page.fields.body,
      page.fields.dataDependencies,
      page.fields.tables.join(" "),
    ].join("\n"));
    if (normalizedQuery && pageText.includes(normalizedQuery)) {
      score += 6;
      matchedFields.add("body");
      why.unshift("完整短语命中");
    }

    for (const intent of expanded.reasons) {
      const intentMatches = intent.expansions.filter((term) => matchedTerms.has(term));
      if (intentMatches.length > 0) {
        score += 3;
        why.push(`${intent.reason}：${intentMatches.slice(0, 4).join(", ")}`);
      }
      if (intent.reason === "配置表意图扩展" && page.fields.tables.length > 0) {
        score += 4;
        if (page.fields.dataDependencies.trim()) matchedFields.add("dataDependencies");
        matchedFields.add("tables");
        why.push(`配置表意图命中结构化表依赖：${page.fields.tables.slice(0, 3).join(", ")}`);
      }
      if (intent.reason === "活动结构意图扩展" && page.type === "activity_template") {
        score += 4;
        matchedFields.add("type");
        why.push("活动结构意图命中活动模板");
      }
    }

    if (page.trust?.score !== undefined) {
      score *= 0.9 + Math.max(0, Math.min(1, page.trust.score)) * 0.1;
      why.push(`可信度 ${page.trust.score}`);
    }

    if (score <= 0) continue;
    items.push({
      componentId: page.componentId,
      title: page.title,
      artifactId: page.artifactId,
      okfPath: page.okfPath,
      kind: page.kind,
      type: page.type,
      trust: page.trust,
      snippet: snippetForTerms(page.fields.body, queryTerms),
      score: round(score),
      matchedTerms: [...matchedTerms].sort(),
      matchedFields: [...matchedFields].sort(),
      why: unique(why).slice(0, 8),
      tableDependencies: page.fields.tables,
    });
  }
  return items.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
}

export function tokenizeSearchText(value: string): string[] {
  const normalized = normalizeText(value);
  const out = new Set<string>();
  for (const token of normalized.match(/[a-z0-9]+|[\p{Script=Han}]+/gu) ?? []) {
    if (token.length === 0) continue;
    out.add(token);
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      for (const n of [2, 3]) {
        for (let i = 0; i <= token.length - n; i += 1) out.add(token.slice(i, i + n));
      }
    }
  }
  return [...out];
}

function pageFromMarkdown(
  okfPath: string,
  markdown: string,
  graphTablesByTitle: Map<string, string[]>,
  aliasTermsByTable: Map<string, string[]>,
): OkfSearchPage | null {
  const parsed = parseOkfPage(markdown);
  if (!parsed.componentId) return null;
  const sections = parseSections(parsed.body);
  const headings = sections.map((section) => section.heading);
  const dataDependencies = sections
    .filter((section) => dependencyHeading(section.heading))
    .map((section) => section.content)
    .join("\n");
  const graphTables = graphTablesByTitle.get(parsed.title) ?? graphTablesByTitle.get(parsed.artifactId) ?? [];
  const textTables = tableNamesMentioned(`${parsed.body}\n${parsed.artifactId}`, aliasTermsByTable);
  const tables = unique([...graphTables, ...textTables]).sort();
  const citations = extractCitationLines(parsed.body);

  const fields: OkfSearchPage["fields"] = {
    title: parsed.title,
    path: `${okfPath}\n${parsed.artifactId}`,
    type: `${parsed.type}\n${parsed.kind}`,
    headings,
    body: stripUtilitySections(parsed.body),
    dataDependencies,
    tables: tables.flatMap((table) => [table, ...(aliasTermsByTable.get(table) ?? [])]),
    citations,
  };
  const terms = Object.fromEntries(
    (Object.keys(FIELD_WEIGHTS) as SearchField[]).map((field) => [field, tokenizeSearchText(Array.isArray(fields[field]) ? fields[field].join("\n") : String(fields[field] ?? ""))])
  ) as Record<SearchField, string[]>;

  return {
    componentId: parsed.componentId,
    title: parsed.title,
    artifactId: parsed.artifactId,
    okfPath,
    kind: parsed.kind,
    type: parsed.type,
    trust: parsed.trust,
    fields,
    terms,
  };
}

function parseOkfPage(markdown: string): {
  body: string;
  title: string;
  type: string;
  componentId: string;
  artifactId: string;
  kind: string;
  trust: TrustScore | null;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(markdown);
  const frontmatter = match?.[1] ?? "";
  const body = match?.[2] ?? markdown;
  const artifactId = yamlScalar(frontmatter, "artifactId");
  return {
    body,
    title: yamlScalar(frontmatter, "title") || firstHeading(body) || artifactId,
    type: yamlScalar(frontmatter, "type") || "knowledge_note",
    componentId: yamlScalar(frontmatter, "componentId"),
    artifactId,
    kind: okfKind(frontmatter, artifactId),
    trust: parseOkfTrust(frontmatter),
  };
}

function parseSections(markdown: string): Array<{ heading: string; content: string }> {
  const lines = markdown.split(/\r?\n/u);
  const out: Array<{ heading: string; content: string }> = [];
  let current: { heading: string; lines: string[] } | null = null;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) {
      if (current) out.push({ heading: current.heading, content: current.lines.join("\n").trim() });
      current = { heading: heading[2].trim(), lines: [] };
      continue;
    }
    current?.lines.push(line);
  }
  if (current) out.push({ heading: current.heading, content: current.lines.join("\n").trim() });
  return out;
}

function graphTablesByPageTitle(bundleDir: string): Map<string, string[]> {
  const graph = readJson<GraphAsset>(join(bundleDir, "graph", "graph.json"));
  const out = new Map<string, string[]>();
  if (!graph) return out;
  const labelsById = new Map<string, string>();
  for (const node of graph.nodes ?? []) {
    if (!node.id) continue;
    labelsById.set(node.id, node.label ?? node.id);
    if (node.wiki_page) labelsById.set(node.wiki_page.replace(/^wiki\//u, ""), node.label ?? node.id);
  }
  for (const edge of graph.edges ?? []) {
    if (edge.relation !== "configured_in" || !edge.source || !edge.target) continue;
    const source = labelsById.get(edge.source) ?? edge.source;
    const target = edge.target.replace(/^table:/u, "");
    out.set(source, unique([...(out.get(source) ?? []), target]));
  }
  return out;
}

function tableAliasTermsByCanonical(bundleDir: string): Map<string, string[]> {
  const manifest = readJson<TableAliasManifest>(join(bundleDir, "tables", "aliases.json"));
  const out = new Map<string, string[]>();
  for (const row of manifest?.aliases ?? []) {
    const table = row.table ?? row.canonical ?? row.canonicalName ?? "";
    if (!table) continue;
    out.set(table, unique([table, ...(row.aliases ?? [])]));
  }
  return out;
}

function tableNamesMentioned(text: string, aliasTermsByTable: Map<string, string[]>): string[] {
  const haystack = aliasKey(text);
  const out: string[] = [];
  for (const [table, terms] of aliasTermsByTable.entries()) {
    if (terms.some((term) => haystack.includes(aliasKey(term)))) out.push(table);
  }
  return out;
}

function expandQuery(query: string): { terms: string[]; reasons: Array<{ reason: string; expansions: string[] }> } {
  const normalized = normalizeText(query);
  const terms = new Set<string>();
  const reasons: Array<{ reason: string; expansions: string[] }> = [];
  for (const intent of INTENT_TERMS) {
    if (!intent.triggers.some((trigger) => normalized.includes(normalizeText(trigger)))) continue;
    const expansions = unique(intent.expansions.flatMap(tokenizeSearchText));
    expansions.forEach((term) => terms.add(term));
    reasons.push({ reason: intent.reason, expansions });
  }
  return { terms: [...terms], reasons };
}

function stripUtilitySections(body: string): string {
  const lines = body.split(/\r?\n/u);
  const out: string[] = [];
  let skip = false;
  for (const line of lines) {
    const heading = /^#\s+(.+)$/u.exec(line);
    if (heading) skip = ["trust", "citations", "引用", "证据"].includes(heading[1].trim().toLowerCase());
    if (!skip) out.push(line);
  }
  return out.join("\n").trim();
}

function extractCitationLines(body: string): string[] {
  const lines = body.split(/\r?\n/u);
  const headingIndex = lines.findIndex((line) => /^#\s+(Citations|引用|证据)\s*$/iu.test(line.trim()));
  if (headingIndex < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (/^#\s+\S/u.test(line)) break;
    if (line.trim()) out.push(line.trim());
  }
  return out;
}

function dependencyHeading(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "data dependencies" || ["配置表依赖", "关联配置表", "数据依赖", "表依赖"].includes(normalized);
}

function parseOkfTrust(frontmatter: string): TrustScore | null {
  const score = numberScalar(frontmatter, "score");
  const version = yamlScalar(frontmatter, "version");
  if (score === null || version !== "v2-lite") return null;
  return {
    version: "v2-lite",
    score,
    status: statusScalar(yamlScalar(frontmatter, "status")),
    breakdown: {
      evidence: numberScalar(frontmatter, "evidence") ?? 0,
      completeness: numberScalar(frontmatter, "completeness") ?? 0,
      auditFreshness: numberScalar(frontmatter, "auditFreshness") ?? 0,
      consistency: numberScalar(frontmatter, "consistency") ?? 0,
    },
    caps: [],
    reasons: [],
    lastTrustedAuditAt: yamlScalar(frontmatter, "lastTrustedAuditAt") || null,
    auditHalfLifeDays: 180,
    evidenceRequired: true,
  };
}

function yamlScalar(frontmatter: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^(?:${escaped}|\\s+${escaped}):\\s*(.+?)\\s*$`, "mu").exec(frontmatter);
  if (!match) return "";
  const raw = match[1].trim();
  try {
    return String(JSON.parse(raw));
  } catch {
    return raw.replace(/^["']|["']$/gu, "");
  }
}

function numberScalar(frontmatter: string, key: string): number | null {
  const value = yamlScalar(frontmatter, key);
  return value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
}

function statusScalar(value: string): TrustScore["status"] {
  return value === "trusted" || value === "usable_with_risk" || value === "needs_review" || value === "blocked" ? value : "needs_review";
}

function okfKind(frontmatter: string, artifactId: string): string {
  const tags = yamlScalar(frontmatter, "tags");
  for (const kind of ["wiki_page", "table_wiki_page"]) {
    if (tags.includes(kind)) return kind;
  }
  if (artifactId.startsWith("wiki/tables/")) return "table_wiki_page";
  return "wiki_page";
}

function firstHeading(markdown: string): string {
  return /^#\s+(.+)$/mu.exec(markdown)?.[1]?.trim() ?? "";
}

function snippetForTerms(markdown: string, terms: string[]): string {
  const lines = markdown.split(/\r?\n/u);
  return lines.find((line) => {
    const normalized = normalizeText(line);
    return terms.some((term) => normalized.includes(term));
  })?.slice(0, 240) ?? lines.find(Boolean)?.slice(0, 240) ?? "";
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[`*_~#[\]()>|]/gu, " ").replace(/\s+/gu, " ").trim();
}

function aliasKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/[\s_\-()[\]（）【】{}《》:：,，.。/\\]+/gu, "");
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values.filter(Boolean))];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
