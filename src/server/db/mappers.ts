import type {
  AgentEvent,
  AssetComponent,
  AssetGroup,
  AssetPackage,
  EvidenceRecord,
  McpAuditRecord,
  ReleaseRecord,
  ReviewTask,
  UserRecord
} from "../types";

/**
 * Pure row mappers from DB snake_case columns to domain camelCase shapes.
 *
 * All `*` columns selected with `SELECT *` are mappable here. JSONB columns
 * may arrive as parsed JS values (pg native) or as strings (legacy paths,
 * tests); `jsonArray`/`jsonObject` accept both.
 */

export function mapUser(row: Record<string, unknown>): UserRecord {
  return {
    id: row.id as string,
    username: row.username as string,
    passwordHash: row.password_hash as string,
    role: row.role as UserRecord["role"],
    displayName: row.display_name as string
  };
}

export function mapPackage(row: Record<string, unknown>): AssetPackage {
  return {
    packageId: row.package_id as string,
    name: row.name as string,
    kind: row.kind as string,
    status: row.status as AssetPackage["status"],
    description: row.description as string,
    createdByRunId: row.created_by_run_id as string,
    sourceVersionIds: jsonArray(row.source_version_ids),
    legacyPaths: jsonArray(row.legacy_paths),
    qualitySummary: jsonObject(row.quality_summary),
    createdAt: String(row.created_at)
  };
}

export function mapComponent(row: Record<string, unknown>): AssetComponent {
  return {
    componentId: row.component_id as string,
    packageId: row.package_id as string,
    artifactId: row.artifact_id as string,
    group: row.group_name as AssetGroup,
    kind: row.kind as string,
    title: row.title as string,
    status: row.status as string,
    legacyPath: String(row.legacy_path ?? ""),
    storageUri: String(row.storage_uri ?? ""),
    sourceRefs: jsonArray(row.source_refs),
    quality: jsonObject(row.quality)
  };
}

export function mapReviewTask(row: Record<string, unknown>): ReviewTask {
  return {
    taskId: row.task_id as string,
    packageId: row.package_id as string,
    componentId: row.component_id as string,
    severity: row.severity as ReviewTask["severity"],
    status: row.status as ReviewTask["status"],
    taskKind: String(row.task_kind ?? "review") === "annotation" ? "annotation" : "review",
    ruleId: String(row.rule_id ?? ""),
    title: row.title as string,
    description: row.description as string,
    suggestedAction: row.suggested_action as string,
    candidates: jsonCandidateArray(row.candidates),
    confidence: Number(row.confidence ?? 0),
    contextSnapshot: jsonObject(row.context_snapshot),
    annotationValue: jsonObject(row.annotation_value),
    annotatedBy: String(row.annotated_by ?? ""),
    annotatedAt: row.annotated_at ? String(row.annotated_at) : null,
    createdAt: String(row.created_at),
    resolvedBy: (row.resolved_by as string) ?? "",
    resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
    resolutionNote: (row.resolution_note as string) ?? "",
    learning: {
      recurrenceCount: 0,
      openSimilarCount: 0,
      exampleCount: 0,
      buildExamplesInjected: 0,
      lastAnnotation: null
    }
  };
}

function jsonCandidateArray(value: unknown): ReviewTask["candidates"] {
  let raw: unknown = [];
  if (Array.isArray(value)) {
    raw = value;
  } else if (typeof value === "string" && value.length > 0) {
    try {
      raw = JSON.parse(value) as unknown;
    } catch {
      raw = [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry, index) => {
    const item = jsonObject(entry);
    if (Object.keys(item).length === 0) return [];
    return [{
      id: String(item.id ?? `candidate_${index + 1}`),
      label: String(item.label ?? item.id ?? `候选 ${index + 1}`),
      value: item.value ?? item,
      confidence: typeof item.confidence === "number" ? item.confidence : undefined,
      rationale: typeof item.rationale === "string" ? item.rationale : undefined
    }];
  });
}

export function mapEvidenceRecord(row: Record<string, unknown>): EvidenceRecord {
  return {
    evidenceId: row.evidence_id as string,
    packageId: row.package_id as string,
    componentId: row.component_id as string,
    sourceVersionId: row.source_version_id as string,
    quote: row.quote as string,
    note: row.note as string,
    confidence: row.confidence as number,
    createdAt: String(row.created_at)
  };
}

export function mapRelease(row: Record<string, unknown>): ReleaseRecord {
  return {
    releaseId: row.release_id as string,
    parentReleaseId: row.parent_release_id ? String(row.parent_release_id) : null,
    version: row.version as string,
    status: row.status as ReleaseRecord["status"],
    packageIds: jsonArray(row.package_ids),
    note: String(row.note ?? ""),
    publishedAt: row.published_at ? String(row.published_at) : null,
    publishedBy: String(row.published_by ?? ""),
    createdBy: String(row.created_by ?? ""),
    createdAt: String(row.created_at ?? ""),
    manifestHash: String(row.manifest_hash ?? ""),
    manifest: jsonObject(row.manifest_json),
    qualityGate: jsonObject(row.quality_gate)
  };
}

export function mapAgentEvent(row: Record<string, unknown>): AgentEvent {
  return {
    eventId: row.event_id as string,
    releaseId: row.release_id as string,
    query: row.query as string,
    hitComponentIds: jsonArray(row.hit_component_ids),
    qualityFlags: jsonArray(row.quality_flags),
    status: row.status as AgentEvent["status"],
    feedbackType: String(row.feedback_type ?? "hit") as AgentEvent["feedbackType"],
    suggestedAction: String(row.suggested_action ?? ""),
    taskId: String(row.task_id ?? ""),
    createdAt: String(row.created_at),
    components: []
  };
}

export function mapMcpAudit(row: Record<string, unknown>): McpAuditRecord {
  return {
    auditId: row.audit_id as string,
    sessionId: String(row.session_id ?? ""),
    agentRole: String(row.agent_role ?? ""),
    toolName: row.tool_name as string,
    releaseId: row.release_id ? String(row.release_id) : null,
    queryPayload: jsonObject(row.query_payload),
    hitComponentIds: jsonArray(row.hit_component_ids),
    qualityFlags: jsonArray(row.quality_flags),
    status: row.status as McpAuditRecord["status"],
    latencyMs: Number(row.latency_ms ?? 0),
    createdAt: String(row.created_at)
  };
}

export function jsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.length > 0) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string" && value.length > 0) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}
