import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import mammoth from "mammoth";
import xlsx from "xlsx";
import type { StageResult } from "./types";

type MammothMarkdownResult = { value: string; messages: Array<{ message: string }> };
type MammothWithMarkdown = typeof mammoth & {
  convertToMarkdown(input: { path: string }): Promise<MammothMarkdownResult>;
};

const mammothMarkdown = mammoth as MammothWithMarkdown;

export async function runConvertStage(options: { dataDir: string; force: boolean; only: string | null }): Promise<StageResult> {
  const docsDir = join(options.dataDir, "gamedocs");
  const outputPaths: string[] = [];
  const warnings: string[] = [];
  const outputRoot = resolve(options.dataDir, "processed", "parsed");

  if (!existsSync(docsDir)) {
    return {
      stage: "convert",
      status: "skipped",
      outputPaths,
      warnings: [`Missing gamedocs directory: ${docsDir}`],
    };
  }

  const only = normalizeOnlyFilter(options.only);
  for (const absolute of walkFiles(docsDir)) {
    const rel = relative(docsDir, absolute).replace(/\\/g, "/");
    if (only && rel !== only && !rel.endsWith(`/${only}`)) continue;
    const ext = extname(absolute).toLowerCase();
    if (![".md", ".txt", ".docx", ".xlsx", ".xls"].includes(ext)) continue;
    const outRel = `processed/parsed/${rel.replace(/\.[^.]+$/, ".md")}`;
    const outAbs = resolve(options.dataDir, outRel);
    assertContainedOutput(outputRoot, outAbs, outRel);
    mkdirSync(dirname(outAbs), { recursive: true });
    const converted = await convertFileWithContext(absolute, ext, rel);
    warnings.push(...converted.warnings);
    writeFileSync(outAbs, converted.markdown);
    outputPaths.push(outRel);
  }

  outputPaths.sort();
  return { stage: "convert", status: "completed", outputPaths, warnings };
}

async function convertFileWithContext(path: string, ext: string, rel: string): Promise<{ markdown: string; warnings: string[] }> {
  try {
    const converted = await convertFile(path, ext);
    return {
      markdown: converted.markdown,
      warnings: converted.warnings.map((warning) => `${rel}: ${warning}`),
    };
  } catch (error) {
    throw new Error(`Failed to convert ${rel}: ${errorMessage(error)}`);
  }
}

async function convertFile(path: string, ext: string): Promise<{ markdown: string; warnings: string[] }> {
  if (ext === ".md") return { markdown: readFileSync(path, "utf8"), warnings: [] };
  if (ext === ".txt") return { markdown: readFileSync(path, "utf8"), warnings: [] };
  if (ext === ".docx") {
    const result = await mammothMarkdown.convertToMarkdown({ path });
    return {
      markdown: stripInlineImageData(result.value),
      warnings: result.messages.map((message) => message.message),
    };
  }
  const workbook = xlsx.readFile(path);
  return {
    markdown: workbook.SheetNames.map((name) => {
      const rows = xlsx.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], { header: 1, defval: "" });
      return `## Sheet: ${name}\n\n${markdownTable(rows)}`;
    }).join("\n\n"),
    warnings: [],
  };
}

function normalizeOnlyFilter(only: string | null): string | null {
  if (!only) return null;
  const normalized = only.replace(/\\/g, "/").replace(/^\/+/, "");
  return normalized.startsWith("gamedocs/") ? normalized.slice("gamedocs/".length) : normalized;
}

function assertContainedOutput(outputRoot: string, outputPath: string, outputRel: string) {
  const relativeToRoot = relative(outputRoot, outputPath);
  if (relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
    throw new Error(`Refusing to write convert output outside processed/parsed: ${outputRel}`);
  }
}

function markdownTable(rows: unknown[][]): string {
  if (rows.length === 0) return "";
  const columns = Math.max(...rows.map((row) => row.length));
  const header = normalizeRow(rows[0], columns);
  const body = rows.slice(1).map((row) => normalizeRow(row, columns));
  return [
    markdownTableRow(header),
    markdownTableRow(Array.from({ length: columns }, () => "---")),
    ...body.map(markdownTableRow),
  ].join("\n");
}

function normalizeRow(row: unknown[], columns: number): string[] {
  return Array.from({ length: columns }, (_, index) => markdownCell(row[index]));
}

function markdownTableRow(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function markdownCell(value: unknown): string {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// mammoth inlines embedded images as base64 data-URIs, which can balloon a docx
// to many MB and blow past the LLM context window. Image bytes carry no value for
// text/knowledge extraction, so replace each inline image with a lightweight marker.
function stripInlineImageData(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\(data:[^)]*\)/gu, "![image]")
    .replace(/<img[^>]*src="data:[^"]*"[^>]*>/giu, "");
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
