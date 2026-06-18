import { getJson } from "./http";
import type { SearchResult } from "./types";

export async function searchAll(q: string, limit?: number): Promise<SearchResult> {
  const params = new URLSearchParams({ q });
  if (limit) params.set("limit", String(limit));
  return (await getJson<{ result: SearchResult }>(`/api/search?${params.toString()}`)).result;
}
