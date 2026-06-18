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
