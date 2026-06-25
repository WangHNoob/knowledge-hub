import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import xlsx from "xlsx";
import type { KnowledgeRuleConfig } from "../../types";
import { renderTableAliasTemplate } from "./tableAliases";
import type { StageResult } from "./types";

interface TableSchema {
  schema_version?: number;
  table_name: string;
  rel_path: string;
  fields: string[];
  row_count: number;
  sheets: string[];
}

const TABLE_SCHEMA_VERSION = 2;
const HEADER_SCAN_ROWS = 12;
const FIELD_META_TOKENS = new Set([
  "int",
  "long",
  "float",
  "double",
  "number",
  "string",
  "string(intern)",
  "bool",
  "boolean",
  "json",
  "array",
  "primary",
  "none",
  "null",
  "client",
  "server",
  "all",
  "both",
]);

interface ForeignKeyEdge {
  source: string;
  target: string;
  field: string;
  source_of_edge: "field_convention";
}

interface TableRelationCandidate extends ForeignKeyEdge {
  reason: string;
}

interface TableStageOptions {
  dataDir: string;
  force: boolean;
  rules?: KnowledgeRuleConfig;
  changedPaths?: string[];
  removedPaths?: string[];
  cacheRoot?: string;
}

export async function runTableStage(options: TableStageOptions): Promise<StageResult> {
  const gamedataDir = join(options.dataDir, "gamedata");
  if (!existsSync(gamedataDir)) {
    return {
      stage: "tables",
      status: "completed",
      outputPaths: [],
      warnings: [`missing gamedata directory: ${gamedataDir}`],
    };
  }

  const changedTables = tableNamesFromPaths(options.changedPaths ?? []);
  const removedTables = tableNamesFromPaths(options.removedPaths ?? []);
  const existingSchemas = !options.force && (changedTables.size > 0 || removedTables.size > 0)
    ? readExistingSchemas(options.dataDir)
    : {};
  const schemas: Record<string, TableSchema> = Object.fromEntries(
    Object.entries(existingSchemas).filter(([table]) => !removedTables.has(table)),
  );
  for (const file of walkFiles(gamedataDir)) {
    if (![".xlsx", ".xls", ".csv"].includes(extname(file).toLowerCase())) continue;
    const relNoExt = relative(gamedataDir, file).replace(/\\/g, "/").replace(/\.[^.]+$/u, "");
    if (!options.force && existingSchemas[relNoExt] && changedTables.size > 0 && !changedTables.has(relNoExt)) continue;
    const relPath = relative(options.dataDir, file).replace(/\\/g, "/");
    const schema = options.force ? readTableSchema(file, relNoExt, relPath) : readTableSchemaWithCache(file, relNoExt, relPath, options.cacheRoot ?? join(options.dataDir, ".kh-cache", "tables"));
    schemas[relNoExt] = schema;
  }
  const groups = groupSchemas(schemas);

  const { confirmed, candidates } = detectFkEdges(schemas, options.rules);
  const outputPaths = writeTableOutputs(options.dataDir, schemas, groups, confirmed, candidates);
  return { stage: "tables", status: "completed", outputPaths, warnings: [] };
}

function readExistingSchemas(dataDir: string): Record<string, TableSchema> {
  const file = join(dataDir, "wiki", "_tables", "schemas.json");
  if (!existsSync(file)) return {};
  try {
    const schemas = JSON.parse(readFileSync(file, "utf8")) as Record<string, TableSchema>;
    return Object.fromEntries(Object.entries(schemas).filter(([, schema]) => schema.schema_version === TABLE_SCHEMA_VERSION));
  } catch {
    return {};
  }
}

function tableNamesFromPaths(paths: string[]): Set<string> {
  const out = new Set<string>();
  for (const path of paths) {
    const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
    const match = /^gamedata\/(.+)\.(xlsx|xls|csv)$/iu.exec(normalized);
    if (match) out.add(match[1]);
  }
  return out;
}

function groupSchemas(schemas: Record<string, TableSchema>): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const tableName of Object.keys(schemas)) {
    const group = dirname(tableName) === "." ? "ungrouped" : dirname(tableName).replace(/\\/g, "/");
    groups[group] = [...(groups[group] ?? []), tableName].sort();
  }
  return groups;
}

export function detectFkEdges(schemas: Record<string, { fields: string[] }>, rules?: KnowledgeRuleConfig): { confirmed: ForeignKeyEdge[]; candidates: TableRelationCandidate[] } {
  const nameIndex = new Map<string, string>();
  for (const tableName of Object.keys(schemas)) {
    nameIndex.set(simpleTableName(tableName).toLowerCase(), tableName);
  }

  const edges: ForeignKeyEdge[] = [];
  const candidates: TableRelationCandidate[] = [];
  const seen = new Set<string>();
  for (const [tableName, schema] of Object.entries(schemas)) {
    const sourceSimple = simpleTableName(tableName).toLowerCase();
    for (const field of schema.fields ?? []) {
      const match = /^(.+?)[_]?Ids?$/i.exec(field);
      if (!match) continue;
      const target = nameIndex.get(match[1].toLowerCase());
      if (!target || target === tableName || match[1].toLowerCase() === sourceSimple) continue;
      const key = `${tableName}\0${target}\0${field}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const edge = { source: tableName, target, field, source_of_edge: "field_convention" as const };
      if (rules && !autoConfirmField(field, rules)) {
        candidates.push({ ...edge, reason: "manual_confirmation_required" });
      } else {
        edges.push(edge);
      }
    }
  }
  return {
    confirmed: edges.sort((a, b) => `${a.source}.${a.field}.${a.target}`.localeCompare(`${b.source}.${b.field}.${b.target}`)),
    candidates: candidates.sort((a, b) => `${a.source}.${a.field}.${a.target}`.localeCompare(`${b.source}.${b.field}.${b.target}`)),
  };
}

function readTableSchema(file: string, tableName: string, relPath: string): TableSchema {
  // Only the header rows + row count are needed. Materializing every row via
  // sheet_to_json blows the heap on large workbooks (e.g. a 53MB xlsx expands
  // to millions of JS objects), so read just the first few rows and derive the
  // row count from the sheet's reference range instead. Disable formula/HTML/
  // rich-text parsing to cut per-cell memory further.
  const workbook = xlsx.readFile(file, { cellFormula: false, cellHTML: false, cellText: false, cellStyles: false });
  const fields = new Set<string>();
  let rowCount = 0;
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const range = sheet["!ref"] ? xlsx.utils.decode_range(sheet["!ref"] as string) : null;
    if (range) {
      const header = detectHeaderRows(sheet, range);
      rowCount += Math.max(0, range.e.r - header.lastHeaderRow);
      for (const field of header.fields) fields.add(field);
    }
  }
  return {
    schema_version: TABLE_SCHEMA_VERSION,
    table_name: tableName,
    rel_path: relPath,
    fields: [...fields],
    row_count: rowCount,
    sheets: workbook.SheetNames,
  };
}

function readTableSchemaWithCache(file: string, tableName: string, relPath: string, cacheRoot: string): TableSchema {
  const content = readFileSync(file);
  const cacheKey = createHash("sha256")
    .update(`table-schema-v${TABLE_SCHEMA_VERSION}\0`)
    .update(tableName)
    .update("\0")
    .update(content)
    .digest("hex");
  const cacheFile = join(cacheRoot, `${cacheKey}.json`);
  if (existsSync(cacheFile)) {
    try {
      return JSON.parse(readFileSync(cacheFile, "utf8")) as TableSchema;
    } catch {
      // Fall through and refresh corrupt cache entries.
    }
  }
  const schema = readTableSchema(file, tableName, relPath);
  mkdirSync(cacheRoot, { recursive: true });
  writeFileSync(cacheFile, `${JSON.stringify(schema, null, 2)}\n`);
  return schema;
}

function detectHeaderRows(sheet: xlsx.WorkSheet, range: xlsx.Range): { fields: string[]; lastHeaderRow: number } {
  const scanEnd = Math.min(range.e.r, range.s.r + HEADER_SCAN_ROWS - 1);
  const candidates: Array<{ row: number; fields: string[]; score: number; technical: boolean }> = [];
  for (let row = range.s.r; row <= scanEnd; row += 1) {
    const values = rowValues(sheet, range, row);
    const nonEmpty = values.filter(Boolean);
    if (nonEmpty.length === 0) continue;
    const technicalFields = nonEmpty.filter(isTechnicalFieldName);
    const labelFields = nonEmpty.filter(isReadableHeaderLabel);
    const metaCount = nonEmpty.filter(isFieldMetaToken).length;
    const numericCount = nonEmpty.filter(isNumericLike).length;
    const technicalRatio = technicalFields.length / nonEmpty.length;
    const metaRatio = metaCount / nonEmpty.length;
    if (technicalFields.length >= 2 && technicalRatio >= 0.45 && metaRatio < 0.6) {
      candidates.push({ row, fields: technicalFields, score: technicalFields.length * 3 - numericCount - metaCount, technical: true });
    } else if (labelFields.length >= 2 && numericCount / nonEmpty.length < 0.5 && metaRatio < 0.5) {
      candidates.push({ row, fields: labelFields, score: labelFields.length - numericCount - metaCount, technical: false });
    }
  }

  const technical = candidates.filter((candidate) => candidate.technical);
  if (technical.length > 0) {
    return {
      fields: uniqueInOrder(technical.flatMap((candidate) => candidate.fields)),
      lastHeaderRow: Math.max(...technical.map((candidate) => candidate.row)),
    };
  }
  const best = candidates.sort((a, b) => b.score - a.score || a.row - b.row)[0];
  if (best) return { fields: uniqueInOrder(best.fields), lastHeaderRow: best.row };

  const fallback = rowValues(sheet, range, range.s.r).filter((value) => value && !isNumericLike(value));
  return { fields: uniqueInOrder(fallback), lastHeaderRow: range.s.r };
}

function rowValues(sheet: xlsx.WorkSheet, range: xlsx.Range, row: number): string[] {
  const values: string[] = [];
  for (let col = range.s.c; col <= range.e.c; col += 1) {
    const cell = sheet[xlsx.utils.encode_cell({ r: row, c: col })] as { v?: unknown } | undefined;
    const value = normalizeFieldValue(cell?.v);
    if (value) values.push(value);
  }
  return values;
}

function normalizeFieldValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function isTechnicalFieldName(value: string): boolean {
  if (isFieldMetaToken(value) || isNumericLike(value)) return false;
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
}

function isReadableHeaderLabel(value: string): boolean {
  if (isFieldMetaToken(value) || isNumericLike(value)) return false;
  if (value.length > 80) return false;
  return !/[=;{}<>]/u.test(value);
}

function isFieldMetaToken(value: string): boolean {
  return FIELD_META_TOKENS.has(value.trim().toLowerCase());
}

function isNumericLike(value: string): boolean {
  return /^[-+]?\d+(?:\.\d+)?$/u.test(value.trim());
}

function uniqueInOrder(values: string[]): string[] {
  return [...new Set(values)];
}

function writeTableOutputs(
  dataDir: string,
  schemas: Record<string, TableSchema>,
  groups: Record<string, string[]>,
  fkEdges: ForeignKeyEdge[],
  relationCandidates: TableRelationCandidate[] = [],
): string[] {
  const outputPaths = [
    "wiki/_tables/schemas.json",
    "wiki/_tables/groups.json",
    "wiki/_tables/table_aliases.json",
    "wiki/_tables/table_fk_registry.json",
    "wiki/_tables/table_relation_candidates.json",
  ];
  mkdirSync(join(dataDir, "wiki", "_tables"), { recursive: true });
  mkdirSync(join(dataDir, "table_schemas"), { recursive: true });
  mkdirSync(join(dataDir, "wiki", "tables"), { recursive: true });

  const aliasPath = join(dataDir, "wiki", "_tables", "table_aliases.json");
  // Prefer the persisted aliases injected by the alias-prep step (top-level
  // table_aliases.json); fall back to any prior _tables copy.
  const injectedAliasPath = join(dataDir, "table_aliases.json");
  const injectedAliases = existsSync(injectedAliasPath) ? readFileSync(injectedAliasPath, "utf8") : null;
  const existingAliases = injectedAliases === null && existsSync(aliasPath) ? JSON.parse(readFileSync(aliasPath, "utf8")) : {};
  writeFileSync(join(dataDir, "wiki", "_tables", "schemas.json"), `${JSON.stringify(sortObject(schemas), null, 2)}\n`);
  writeFileSync(join(dataDir, "wiki", "_tables", "groups.json"), `${JSON.stringify(sortObject(groups), null, 2)}\n`);
  writeFileSync(aliasPath, injectedAliases ?? renderTableAliasTemplate(Object.keys(schemas), existingAliases));
  writeFileSync(join(dataDir, "wiki", "_tables", "table_fk_registry.json"), `${JSON.stringify(fkEdges, null, 2)}\n`);
  writeFileSync(join(dataDir, "wiki", "_tables", "table_relation_candidates.json"), `${JSON.stringify(relationCandidates, null, 2)}\n`);

  for (const [tableName, schema] of Object.entries(schemas).sort(([a], [b]) => a.localeCompare(b))) {
    const file = tableFileName(tableName);
    writeFileSync(join(dataDir, "table_schemas", `${file}.json`), `${JSON.stringify(schema, null, 2)}\n`);
    outputPaths.push(`table_schemas/${file}.json`);
  }

  for (const [group, tables] of Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))) {
    const slug = tableFileName(group);
    writeFileSync(join(dataDir, "wiki", "tables", `${slug}.md`), renderTableGroupPage(group, tables, schemas));
    outputPaths.push(`wiki/tables/${slug}.md`);
  }

  return outputPaths.sort();
}

function autoConfirmField(field: string, rules: KnowledgeRuleConfig): boolean {
  const autoSuffixes = rules.tableRules.autoConfirmFieldIdSuffixes;
  const candidateSuffixes = rules.tableRules.candidateFieldIdSuffixes;
  if (candidateSuffixes.some((suffix) => field.endsWith(suffix))) return false;
  if (autoSuffixes.length === 0) return false;
  return autoSuffixes.some((suffix) => field.endsWith(suffix));
}

function renderTableGroupPage(group: string, tables: string[], schemas: Record<string, TableSchema>): string {
  return [
    "---",
    "type: table",
    `title: ${group}`,
    "table_schema: wiki/_tables/schemas.json",
    "---",
    "",
    `# ${group}`,
    "",
    "| table | fields | rows |",
    "| --- | --- | --- |",
    ...tables.map((table) => `| ${table} | ${(schemas[table]?.fields ?? []).join(", ")} | ${schemas[table]?.row_count ?? 0} |`),
    "",
  ].join("\n");
}

function simpleTableName(tableName: string): string {
  return basename(tableName).replace(/^_+/, "");
}

function tableFileName(value: string): string {
  return value.replace(/[\\/]+/g, "__").replace(/[^A-Za-z0-9_.-]+/g, "_") || "table";
}

function sortObject<T>(input: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === ".cache") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(path));
    else if (!entry.name.startsWith("~")) out.push(path);
  }
  return out.sort();
}
