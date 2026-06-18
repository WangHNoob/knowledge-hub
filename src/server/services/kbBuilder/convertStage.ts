import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
    const converted = await convertFileWithContext(absolute, ext, rel, outAbs);
    warnings.push(...converted.warnings);
    outputPaths.push(outRel);
  }

  outputPaths.sort();
  return { stage: "convert", status: "completed", outputPaths, warnings };
}

async function convertFileWithContext(path: string, ext: string, rel: string, outAbs: string): Promise<{ warnings: string[] }> {
  try {
    const converted = await convertFile(path, ext, outAbs);
    return {
      warnings: converted.warnings.map((warning) => `${rel}: ${warning}`),
    };
  } catch (error) {
    throw new Error(`Failed to convert ${rel}: ${errorMessage(error)}`);
  }
}

async function convertFile(path: string, ext: string, outAbs: string): Promise<{ warnings: string[] }> {
  if (ext === ".md" || ext === ".txt") {
    // Copy through without materializing a second copy of the body in memory.
    writeFileSync(outAbs, readFileSync(path));
    return { warnings: [] };
  }
  if (ext === ".docx") {
    const result = await mammothMarkdown.convertToMarkdown({ path });
    writeFileSync(outAbs, stripInlineImageData(result.value));
    return { warnings: result.messages.map((message) => message.message) };
  }
  // Spreadsheets can be tens of MB; sheet_to_json + string concat would hold
  // the whole table (and its markdown render) in memory at once. Stream each
  // sheet row-by-row straight to disk instead.
  await writeWorkbookMarkdown(path, outAbs);
  return { warnings: [] };
}

function writeWorkbookMarkdown(path: string, outAbs: string): Promise<void> {
  const workbook = xlsx.readFile(path, { cellFormula: false, cellHTML: false, cellText: false, cellStyles: false });
  const out = createWriteStream(outAbs, { encoding: "utf8" });

  // Honor stream backpressure: on a 50MB+ sheet, firing hundreds of thousands
  // of write()s without ever awaiting 'drain' lets Node's internal buffer grow
  // unbounded — the same OOM in a different place. Pause on a full buffer.
  const write = (chunk: string): Promise<void> =>
    out.write(chunk) ? Promise.resolve() : new Promise<void>((r) => out.once("drain", r));

  return new Promise<void>((resolveWrite, rejectWrite) => {
    out.on("error", rejectWrite);

    void (async () => {
      try {
        let firstSheet = true;
        for (const name of workbook.SheetNames) {
          const sheet = workbook.Sheets[name];
          await write(`${firstSheet ? "" : "\n\n"}## Sheet: ${name}\n\n`);
          firstSheet = false;
          if (!sheet || !sheet["!ref"]) continue;

          const range = xlsx.utils.decode_range(sheet["!ref"] as string);
          const columns = range.e.c - range.s.c + 1;
          for (let row = range.s.r; row <= range.e.r; row += 1) {
            const cells: string[] = [];
            for (let col = range.s.c; col <= range.e.c; col += 1) {
              const cell = sheet[xlsx.utils.encode_cell({ r: row, c: col })] as { v?: unknown } | undefined;
              cells.push(markdownCell(cell?.v));
            }
            await write(`${markdownTableRow(cells)}\n`);
            if (row === range.s.r) {
              await write(`${markdownTableRow(Array.from({ length: columns }, () => "---"))}\n`);
            }
          }
        }
        out.end(resolveWrite);
      } catch (error) {
        out.destroy();
        rejectWrite(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
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
