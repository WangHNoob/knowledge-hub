import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import mammoth from "mammoth";
import xlsx from "xlsx";
import type { StageResult } from "./types";

export async function runConvertStage(options: { dataDir: string; force: boolean; only: string | null }): Promise<StageResult> {
  const docsDir = join(options.dataDir, "gamedocs");
  const outputPaths: string[] = [];
  const warnings: string[] = [];

  for (const absolute of walkFiles(docsDir)) {
    const rel = relative(docsDir, absolute).replace(/\\/g, "/");
    if (options.only && rel !== options.only && !rel.endsWith(`/${options.only}`)) continue;
    const ext = extname(absolute).toLowerCase();
    if (![".md", ".txt", ".docx", ".xlsx", ".xls"].includes(ext)) continue;
    const outRel = `processed/parsed/${rel.replace(/\.[^.]+$/, ".md")}`;
    const outAbs = join(options.dataDir, outRel);
    mkdirSync(dirname(outAbs), { recursive: true });
    const markdown = await convertFile(absolute, ext);
    writeFileSync(outAbs, markdown);
    outputPaths.push(outRel);
  }

  outputPaths.sort();
  return { stage: "convert", status: "completed", outputPaths, warnings };
}

async function convertFile(path: string, ext: string): Promise<string> {
  if (ext === ".md") return readFileSync(path, "utf8");
  if (ext === ".txt") return readFileSync(path, "utf8");
  if (ext === ".docx") {
    const result = await mammoth.convertToMarkdown({ path });
    return result.value;
  }
  const workbook = xlsx.readFile(path);
  return workbook.SheetNames.map((name) => {
    const rows = xlsx.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[name], { defval: "" });
    const header = `## Sheet: ${name}`;
    const body = rows.map((row) => `- ${Object.entries(row).map(([key, value]) => `${key}: ${String(value)}`).join("; ")}`).join("\n");
    return `${header}\n\n${body}`;
  }).join("\n\n");
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
