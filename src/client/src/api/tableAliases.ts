import { getJson, putJson } from "./http";
import type { TableAliasEntry } from "./types";

export async function listTableAliases(): Promise<TableAliasEntry[]> {
  return (await getJson<{ entries: TableAliasEntry[] }>("/api/table-aliases")).entries;
}

export async function saveTableAliases(
  entries: Array<{ canonical: string; aliases: string[] }>
): Promise<TableAliasEntry[]> {
  return (await putJson<{ entries: TableAliasEntry[] }>("/api/table-aliases", { entries })).entries;
}
