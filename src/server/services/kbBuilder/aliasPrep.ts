import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

import type { LlmClient } from "./llmClient";

const ALIAS_FILE = "table_aliases.json";
const DRAFT_BATCH = 40;
const TABLE_EXTS = new Set([".xlsx", ".xls", ".csv"]);

/** Canonical table names = gamedata workbook paths without extension (header read not needed). */
export function scanGamedataTableNames(dataDir: string): string[] {
  const gamedataDir = join(dataDir, "gamedata");
  if (!existsSync(gamedataDir)) return [];
  const names: string[] = [];
  for (const file of walkFiles(gamedataDir)) {
    if (!TABLE_EXTS.has(extname(file).toLowerCase())) continue;
    names.push(relative(gamedataDir, file).replace(/\\/g, "/").replace(/\.[^.]+$/u, ""));
  }
  return [...new Set(names)].sort();
}

/** Writes the persisted alias map into the run workspace as the file the pipeline reads first. */
export function writeAliasFile(dataDir: string, rows: Array<{ table: string; aliases: string[] }>): void {
  writeFileSync(join(dataDir, ALIAS_FILE), `${JSON.stringify(rows, null, 2)}\n`);
}

const DRAFT_SCHEMA = {
  name: "table_aliases",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            table: { type: "string" },
            aliases: { type: "array", items: { type: "string" } }
          },
          required: ["table", "aliases"]
        }
      }
    },
    required: ["items"]
  }
} as const;

/**
 * Asks the LLM to draft Chinese aliases for a batch of canonical table names so the
 * translation table doesn't start from zero. Failures degrade gracefully: a failed
 * batch is skipped (reported via onWarn) rather than aborting the whole build.
 */
export async function generateAliasDrafts(
  client: LlmClient,
  tableNames: string[],
  hooks: { onProgress?: (done: number, total: number) => void; onWarn?: (message: string) => void } = {}
): Promise<Array<{ canonical: string; aliases: string[] }>> {
  const out: Array<{ canonical: string; aliases: string[] }> = [];
  for (let start = 0; start < tableNames.length; start += DRAFT_BATCH) {
    const batch = tableNames.slice(start, start + DRAFT_BATCH);
    try {
      const result = await client.complete({
        system:
          "你是游戏数据表命名翻译助手。给定一批以英文或路径形式命名的数据表，为每个表给出 1-3 个简洁的中文别名，" +
          "用于把策划文档里出现的中文表名解析回规范表名。中文别名应贴合表的业务含义，不要逐字音译，不要包含路径或扩展名。" +
          "必须原样回显传入的 table 值。只输出 JSON。",
        user: `请为以下数据表生成中文别名：\n${batch.map((name) => `- ${name}`).join("\n")}`,
        jsonSchema: DRAFT_SCHEMA as { name: string; schema: Record<string, unknown> },
        maxTokens: 2048
      });
      const items = parseItems(result.text);
      const known = new Set(batch);
      for (const item of items) {
        if (!known.has(item.table)) continue;
        const aliases = item.aliases.map((a) => a.trim()).filter(Boolean);
        if (aliases.length) out.push({ canonical: item.table, aliases });
      }
    } catch (error) {
      hooks.onWarn?.(`别名生成批次失败（${batch[0]} …）：${error instanceof Error ? error.message : String(error)}`);
    }
    hooks.onProgress?.(Math.min(start + DRAFT_BATCH, tableNames.length), tableNames.length);
  }
  return out;
}

function parseItems(text: string): Array<{ table: string; aliases: string[] }> {
  try {
    const parsed = JSON.parse(text) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return [];
    return parsed.items
      .map((raw) => {
        const record = raw as { table?: unknown; aliases?: unknown };
        const table = typeof record.table === "string" ? record.table : null;
        const aliases = Array.isArray(record.aliases)
          ? record.aliases.filter((a): a is string => typeof a === "string")
          : [];
        return table ? { table, aliases } : null;
      })
      .filter((item): item is { table: string; aliases: string[] } => item !== null);
  } catch {
    return [];
  }
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
