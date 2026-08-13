import type { AssetComponent, ReleaseRecord, TrustScore } from "../../types";

/** MCP 工具调用上下文（sessionId/agentRole/traceId/projectId）。 */
export interface KnowledgeQueryContext {
  sessionId?: string;
  agentRole?: string;
  traceId?: string;
  projectId?: string;
}

export interface ToolResult {
  result: unknown;
  componentIds: string[];
  artifactIds?: string[];
  sourceVersionIds?: string[];
  evidenceIds?: string[];
  qualityFlags?: string[];
  forceHit?: boolean;
}

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  wiki_page?: string;
  source?: string;
  table?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  edge_kind?: string;
  from_doc?: string;
  field?: string;
}

export interface TableSchema {
  table_name: string;
  rel_path: string;
  fields: string[];
  row_count: number;
  sheets?: string[];
}

export interface TableFieldMapping {
  rawKey: string;
  columnIndex: number;
  headerValue: string;
  matchMethod: "header" | "schema_order";
}

export interface TableMappedRow extends Record<string, unknown> {
  row: Record<string, unknown>;
  rawRow: Record<string, unknown>;
  fieldMap: Record<string, TableFieldMapping>;
}

export interface TableReadResult {
  sheet: string;
  rows: TableMappedRow[];
  fieldMap: Record<string, TableFieldMapping>;
  mappedFields: string[];
  missingFields: string[];
  unmappedRawColumns: string[];
  headerRowGuess: number;
  dataStartRow: number;
  rowCount: { schema: number; data: number };
  diagnostics: string[];
}

export interface KnowledgeAssetRef {
  componentId: string;
  artifactId: string;
  title?: string;
  trust?: TrustScore | null;
}

export type TableSchemaEntry = { component: KnowledgeAssetRef; schema: TableSchema; sourceVersionIds?: string[] };

export interface OkfGraphAsset {
  componentId: string;
  artifactId: string;
  trust?: TrustScore | null;
  nodes?: GraphNode[];
  edges?: GraphEdge[];
}

export interface OkfTableSchemaEntry {
  componentId: string;
  artifactId: string;
  trust?: TrustScore | null;
  sourceVersionIds?: string[];
  schema: TableSchema;
}

export interface OkfTableAliasEntry {
  table?: string;
  canonical?: string;
  canonicalName?: string;
  aliases?: string[];
}

export interface OkfPage {
  okfPath: string;
  markdown: string;
  body: string;
  title: string;
  description: string;
  type: string;
  componentId: string;
  packageId: string;
  artifactId: string;
  kind: string;
  trust: TrustScore | null;
  citations: OkfCitation[];
}

export interface OkfCitation {
  evidenceId: string;
  componentId: string;
  sourceVersionId: string;
  quote: string;
  note: string;
  confidence: number | null;
  okfPath: string;
}

export interface SourceCorrectionView {
  correctionId: string;
  projectId: string;
  bundleId: string;
  sourcePath: string;
  ruleId: string;
  pageType: string;
  factKey: string | null;
  boundSourceHash: string;
  state: string;
  correctValue: Record<string, unknown>;
  componentId: string | null;
  packageId: string | null;
  exampleId: string;
  taskId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type CorrectionAnchorMatchMethod = "componentId" | "knowledgePath" | "sourcePath_unique" | "component_fallback";

export interface CorrectionAnchorExplanation {
  componentId: string;
  sourcePath: string;
  matchMethod: CorrectionAnchorMatchMethod;
  candidates: Array<Record<string, unknown>>;
  confidence: "high" | "medium" | "low";
}

export interface CorrectionTarget {
  component: AssetComponent;
  sourcePath: string;
  anchor: CorrectionAnchorExplanation;
}

export interface SearchMatchClassification {
  status: "hit" | "near_miss" | "low_confidence_hit";
  qualityFlags: string[];
  coreTerms: string[];
  matchedCoreTerms: string[];
  missingCoreTerms: string[];
}

export interface PublishTarget {
  runId: string;
  packageId: string;
  only: string;
  componentIds: string[];
}

export interface HealthComponentSummary {
  componentId: string;
  artifactId: string;
  title: string;
  kind: string;
  score: number | null;
  status: string;
  lastTrustedAuditAt: string | null;
}

export interface HealthCorrectionSummary {
  correctionId: string;
  state: string;
  componentId: string;
  packageId: string;
  sourcePath: string;
  ruleId: string;
  factKey: string | null;
  updatedAt: string;
}

export type { ReleaseRecord };
