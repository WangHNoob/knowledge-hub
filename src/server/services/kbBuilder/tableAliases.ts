import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface TableAliasIndex {
  readonly canonicalNames: Set<string>;
  resolve(value: string): string | null;
  resolveMany(value: string): string[];
  replacements(): Array<{ alias: string; canonical: string }>;
}

type AliasFile =
  | Record<string, unknown>
  | Array<{ table?: unknown; canonical?: unknown; canonicalName?: unknown; aliases?: unknown }>;

export function loadTableAliases(dataDir: string, canonicalTables: string[] = []): TableAliasIndex {
  const aliasToCanonical = new Map<string, string>();
  const originalAliases: Array<{ alias: string; canonical: string }> = [];
  const canonicalNames = new Set(canonicalTables.filter(Boolean));
  const files = [
    join(dataDir, "table_aliases.json"),
    join(dataDir, "processed", "table_aliases.json"),
    join(dataDir, "wiki", "_tables", "table_aliases.json"),
  ];

  for (const file of files) {
    if (!existsSync(file)) continue;
    addAliasFile(aliasToCanonical, originalAliases, canonicalNames, JSON.parse(readFileSync(file, "utf8")) as AliasFile);
  }

  for (const table of canonicalNames) {
    addAlias(aliasToCanonical, originalAliases, canonicalNames, table, table);
  }

  return {
    canonicalNames,
    resolve(value: string) {
      return aliasToCanonical.get(aliasKey(value)) ?? null;
    },
    resolveMany(value: string) {
      const out: string[] = [];
      const push = (table: string | null) => {
        if (table && !out.includes(table)) out.push(table);
      };
      push(aliasToCanonical.get(aliasKey(value)) ?? null);
      for (const token of value.split(/[,\n，、;；/|]+/u)) push(aliasToCanonical.get(aliasKey(token)) ?? null);
      for (const [alias, canonical] of aliasToCanonical.entries()) {
        if (alias && aliasKey(value).includes(alias)) push(canonical);
      }
      return out;
    },
    replacements() {
      return originalAliases
        .filter(({ alias, canonical }) => alias !== canonical)
        .sort((a, b) => b.alias.length - a.alias.length || a.alias.localeCompare(b.alias));
    },
  };
}

export function renderTableAliasTemplate(tables: string[], existing: unknown = {}): string {
  const aliases = new Map<string, string[]>();
  collectExistingAliases(aliases, existing);
  const rows = [...new Set(tables.filter(Boolean))].sort().map((table) => ({
    table,
    aliases: aliases.get(table) ?? [],
  }));
  return `${JSON.stringify(rows, null, 2)}\n`;
}

function addAliasFile(
  aliasToCanonical: Map<string, string>,
  originalAliases: Array<{ alias: string; canonical: string }>,
  canonicalNames: Set<string>,
  input: AliasFile,
): void {
  if (Array.isArray(input)) {
    for (const row of input) {
      const canonical = stringValue(row.canonical) ?? stringValue(row.canonicalName) ?? stringValue(row.table);
      if (!canonical) continue;
      addAlias(aliasToCanonical, originalAliases, canonicalNames, canonical, canonical);
      for (const alias of stringArray(row.aliases)) addAlias(aliasToCanonical, originalAliases, canonicalNames, alias, canonical);
    }
    return;
  }

  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      addAlias(aliasToCanonical, originalAliases, canonicalNames, key, value);
      continue;
    }
    if (Array.isArray(value)) {
      addAlias(aliasToCanonical, originalAliases, canonicalNames, key, key);
      for (const alias of stringArray(value)) addAlias(aliasToCanonical, originalAliases, canonicalNames, alias, key);
      continue;
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const canonical = stringValue(record.canonical) ?? stringValue(record.canonicalName) ?? stringValue(record.table) ?? key;
      addAlias(aliasToCanonical, originalAliases, canonicalNames, canonical, canonical);
      addAlias(aliasToCanonical, originalAliases, canonicalNames, key, canonical);
      for (const alias of stringArray(record.aliases)) addAlias(aliasToCanonical, originalAliases, canonicalNames, alias, canonical);
    }
  }
}

function collectExistingAliases(out: Map<string, string[]>, input: unknown): void {
  if (!input || typeof input !== "object") return;
  if (Array.isArray(input)) {
    for (const row of input) {
      const record = row as Record<string, unknown>;
      const canonical = stringValue(record.canonical) ?? stringValue(record.canonicalName) ?? stringValue(record.table);
      if (canonical) out.set(canonical, stringArray(record.aliases));
    }
    return;
  }
  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) out.set(key, stringArray(value));
    else if (value && typeof value === "object") out.set(key, stringArray((value as Record<string, unknown>).aliases));
  }
}

function addAlias(
  aliasToCanonical: Map<string, string>,
  originalAliases: Array<{ alias: string; canonical: string }>,
  canonicalNames: Set<string>,
  alias: string,
  canonical: string,
): void {
  const cleanAlias = alias.trim();
  const cleanCanonical = canonical.trim();
  if (!cleanAlias || !cleanCanonical) return;
  canonicalNames.add(cleanCanonical);
  aliasToCanonical.set(aliasKey(cleanAlias), cleanCanonical);
  if (!originalAliases.some((item) => item.alias === cleanAlias && item.canonical === cleanCanonical)) {
    originalAliases.push({ alias: cleanAlias, canonical: cleanCanonical });
  }
}

function aliasKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/[\s_\-]+/gu, "");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}
