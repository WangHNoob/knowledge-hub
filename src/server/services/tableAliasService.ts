import type { DatabaseHandle, TableAliasEntry, TableAliasSource } from "../types";

export function createTableAliasService(db: DatabaseHandle) {
  return new TableAliasService(db);
}

/**
 * Persistent store for table-name aliases (the "translation table"). This is the
 * single source of truth: the kb-build pipeline reads from here (not from the
 * ephemeral run workspace) and writes LLM-generated drafts back here, while the
 * web UI lets humans curate the same rows. Survives rebuilds by design.
 */
export class TableAliasService {
  private readonly adapter;
  constructor(private readonly db: DatabaseHandle) {
    this.adapter = db.adapter;
  }

  async list(): Promise<TableAliasEntry[]> {
    const { rows } = await this.adapter.query("SELECT * FROM table_aliases ORDER BY canonical ASC");
    return rows.map(mapAlias);
  }

  /** Inserts empty rows for any canonical tables not yet tracked. Returns the names actually added. */
  async ensureTables(canonicals: string[]): Promise<string[]> {
    const added: string[] = [];
    for (const canonical of dedupe(canonicals)) {
      const { rowCount } = await this.adapter.query(
        "INSERT INTO table_aliases (canonical, aliases, source, updated_by, updated_at) VALUES ($1,'[]','manual','',$2) ON CONFLICT (canonical) DO NOTHING",
        [canonical, new Date().toISOString()]
      );
      if (rowCount) added.push(canonical);
    }
    return added;
  }

  /** Upserts aliases for the given tables (used by both the UI save and LLM drafts). */
  async upsertMany(
    entries: Array<{ canonical: string; aliases: string[] }>,
    actor: string,
    source: TableAliasSource
  ): Promise<TableAliasEntry[]> {
    const now = new Date().toISOString();
    for (const entry of entries) {
      const aliases = dedupe(entry.aliases.map((a) => a.trim()).filter(Boolean));
      await this.adapter.query(
        `INSERT INTO table_aliases (canonical, aliases, source, updated_by, updated_at)
         VALUES ($1,$2::jsonb,$3,$4,$5)
         ON CONFLICT (canonical) DO UPDATE
           SET aliases = EXCLUDED.aliases, source = EXCLUDED.source, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [entry.canonical, JSON.stringify(aliases), source, actor, now]
      );
    }
    return this.list();
  }

  /** Canonical names that still have no alias — the work-list for LLM drafting. */
  async listMissing(): Promise<string[]> {
    const { rows } = await this.adapter.query(
      "SELECT canonical FROM table_aliases WHERE jsonb_array_length(aliases) = 0 ORDER BY canonical ASC"
    );
    return rows.map((row) => String(row.canonical));
  }

  /** Renders the alias map as the array-of-rows shape the pipeline writes to disk. */
  async exportRows(): Promise<Array<{ table: string; aliases: string[] }>> {
    return (await this.list()).map((entry) => ({ table: entry.canonical, aliases: entry.aliases }));
  }

  /**
   * Imports a cn_en_map-style payload. Accepts either the flat `{ "EnglishTable": "中文名" }`
   * map (one Chinese name per table) or the array form `[{ table, aliases }]`. Each imported
   * row is merged into existing aliases (no dupes). Returns how many tables were touched.
   */
  async importMap(payload: unknown, actor: string): Promise<{ imported: number }> {
    const incoming = parseImportPayload(payload);
    if (incoming.length === 0) return { imported: 0 };
    const existing = new Map((await this.list()).map((entry) => [entry.canonical, entry.aliases]));
    const merged = incoming.map((row) => ({
      canonical: row.canonical,
      aliases: dedupe([...(existing.get(row.canonical) ?? []), ...row.aliases])
    }));
    await this.upsertMany(merged, actor, "manual");
    return { imported: merged.length };
  }
}

function parseImportPayload(payload: unknown): Array<{ canonical: string; aliases: string[] }> {
  // Array form: [{ table|canonical, aliases|name }]
  if (Array.isArray(payload)) {
    return payload
      .map((raw) => {
        const record = raw as Record<string, unknown>;
        const canonical = str(record.canonical) ?? str(record.table);
        if (!canonical) return null;
        const aliases = Array.isArray(record.aliases)
          ? record.aliases.filter((a): a is string => typeof a === "string")
          : str(record.name) ? [str(record.name)!] : [];
        return { canonical, aliases };
      })
      .filter((row): row is { canonical: string; aliases: string[] } => row !== null);
  }
  // Flat cn_en_map: { "EnglishTable": "中文名" }
  if (payload && typeof payload === "object") {
    return Object.entries(payload as Record<string, unknown>)
      .map(([canonical, value]) => ({
        canonical: canonical.trim(),
        aliases: typeof value === "string" && value.trim() ? [value.trim()] : []
      }))
      .filter((row) => row.canonical);
  }
  return [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function mapAlias(row: Record<string, unknown>): TableAliasEntry {
  return {
    canonical: row.canonical as string,
    aliases: Array.isArray(row.aliases) ? (row.aliases as string[]) : safeJsonArray(row.aliases),
    source: (row.source as TableAliasSource) ?? "manual",
    updatedBy: (row.updated_by as string) ?? "",
    updatedAt: String(row.updated_at)
  };
}

function safeJsonArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
