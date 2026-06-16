import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import xlsx from "xlsx";
import type { KnowledgeRuleConfig } from "../../types";
import type { StageResult } from "./types";

interface TableSchema {
  table_name: string;
  rel_path: string;
  fields: string[];
  row_count: number;
  sheets: string[];
}

interface ForeignKeyEdge {
  source: string;
  target: string;
  field: string;
  source_of_edge: "field_convention";
}

interface TableRelationCandidate extends ForeignKeyEdge {
  reason: string;
}

export async function runTableStage(options: { dataDir: string; force: boolean; rules?: KnowledgeRuleConfig }): Promise<StageResult> {
  const gamedataDir = join(options.dataDir, "gamedata");
  if (!existsSync(gamedataDir)) {
    return {
      stage: "tables",
      status: "completed",
      outputPaths: [],
      warnings: [`missing gamedata directory: ${gamedataDir}`],
    };
  }

  const schemas: Record<string, TableSchema> = {};
  const groups: Record<string, string[]> = {};
  for (const file of walkFiles(gamedataDir)) {
    if (![".xlsx", ".xls", ".csv"].includes(extname(file).toLowerCase())) continue;
    const relNoExt = relative(gamedataDir, file).replace(/\\/g, "/").replace(/\.[^.]+$/u, "");
    const group = dirname(relNoExt) === "." ? "ungrouped" : dirname(relNoExt).replace(/\\/g, "/");
    const schema = readTableSchema(file, relNoExt, relative(options.dataDir, file).replace(/\\/g, "/"));
    schemas[relNoExt] = schema;
    groups[group] = [...(groups[group] ?? []), relNoExt].sort();
  }

  const { confirmed, candidates } = detectFkEdges(schemas, options.rules);
  const outputPaths = writeTableOutputs(options.dataDir, schemas, groups, confirmed, candidates);
  return { stage: "tables", status: "completed", outputPaths, warnings: [] };
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
  const workbook = xlsx.readFile(file);
  const fields = new Set<string>();
  let rowCount = 0;
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    rowCount += rows.length;
    if (rows[0]) {
      for (const field of Object.keys(rows[0])) fields.add(field);
    } else {
      const matrix = xlsx.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
      for (const value of matrix[0] ?? []) {
        if (String(value).trim()) fields.add(String(value).trim());
      }
    }
  }
  return {
    table_name: tableName,
    rel_path: relPath,
    fields: [...fields],
    row_count: rowCount,
    sheets: workbook.SheetNames,
  };
}

function writeTableOutputs(
  dataDir: string,
  schemas: Record<string, TableSchema>,
  groups: Record<string, string[]>,
  fkEdges: ForeignKeyEdge[],
  relationCandidates: TableRelationCandidate[] = [],
): string[] {
  const outputPaths = ["wiki/_tables/schemas.json", "wiki/_tables/groups.json", "wiki/_tables/table_fk_registry.json", "wiki/_tables/table_relation_candidates.json"];
  mkdirSync(join(dataDir, "wiki", "_tables"), { recursive: true });
  mkdirSync(join(dataDir, "table_schemas"), { recursive: true });
  mkdirSync(join(dataDir, "wiki", "tables"), { recursive: true });

  writeFileSync(join(dataDir, "wiki", "_tables", "schemas.json"), `${JSON.stringify(sortObject(schemas), null, 2)}\n`);
  writeFileSync(join(dataDir, "wiki", "_tables", "groups.json"), `${JSON.stringify(sortObject(groups), null, 2)}\n`);
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
