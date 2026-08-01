export type KnowledgeVisibility = "public" | "internal" | "restricted";

const ROLE_VISIBILITY: Record<string, KnowledgeVisibility[]> = {
  viewer: ["public"],
  developer: ["public", "internal"],
  admin: ["public", "internal", "restricted"],
  agent: ["public", "internal"],
  "mcp-agent": ["public", "internal"],
  "qa-agent": ["public", "internal"],
  planner: ["public", "internal"],
};

/** Resolve allowed visibility labels for an MCP agent role. Unknown roles get public-only. */
export function allowedVisibilityForRole(agentRole: string | undefined): Set<KnowledgeVisibility> {
  const role = (agentRole ?? "agent").toLowerCase();
  const allowed = ROLE_VISIBILITY[role] ?? ["public"];
  return new Set(allowed);
}

export function componentVisibility(quality: Record<string, unknown> | undefined | null): KnowledgeVisibility {
  const raw = quality && typeof quality.visibility === "string" ? quality.visibility.toLowerCase() : "public";
  if (raw === "internal" || raw === "restricted" || raw === "public") return raw;
  return "public";
}

export function isComponentVisibleToRole(
  quality: Record<string, unknown> | undefined | null,
  agentRole: string | undefined,
): boolean {
  return allowedVisibilityForRole(agentRole).has(componentVisibility(quality));
}
