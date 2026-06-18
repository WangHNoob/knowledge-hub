import { getJson, postJson, putJson } from "./http";
import type { TableAliasEntry } from "./types";

export async function listTableAliases(): Promise<TableAliasEntry[]> {
  return (await getJson<{ entries: TableAliasEntry[] }>("/api/table-aliases")).entries;
}

export async function saveTableAliases(
  entries: Array<{ canonical: string; aliases: string[] }>
): Promise<TableAliasEntry[]> {
  return (await putJson<{ entries: TableAliasEntry[] }>("/api/table-aliases", { entries })).entries;
}

export async function importTableAliases(map: unknown): Promise<{ imported: number; entries: TableAliasEntry[] }> {
  return postJson<{ imported: number; entries: TableAliasEntry[] }>("/api/table-aliases/import", { map });
}

export async function pruneTableAliases(): Promise<{ removed: number; entries: TableAliasEntry[] }> {
  return postJson<{ removed: number; entries: TableAliasEntry[] }>("/api/table-aliases/prune", {});
}
