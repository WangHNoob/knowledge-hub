export type UserRole = "admin" | "developer" | "maintainer" | "viewer";

export type AssetGroup =
  | "wiki"
  | "index"
  | "graph"
  | "table"
  | "evidence"
  | "quality"
  | "release";

export type PackageStatus = "draft" | "reviewing" | "approved" | "published" | "stale";
export type ReviewSeverity = "blocking" | "warning" | "info";
export type ReviewStatus = "open" | "resolved" | "dismissed";

export interface DatabaseHandle {
  adapter: import("./db-adapter").DatabaseAdapter;
  schema: string;
  close(): Promise<void>;
}

export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  displayName: string;
}

export type SourceCategory = "gamedata" | "gamedocs";

export interface SourceBlob {
  contentHash: string;
  byteSize: number;
  storageUri: string;
  firstSeenAt: string;
}

export interface SourceBundle {
  bundleId: string;
  name: string;
  description: string;
  createdAt: string;
}

export interface SourceBundleVersion {
  versionId: string;
  bundleId: string;
  parentVersionId: string | null;
  label: string;
  note: string;
  createdBy: string;
  createdAt: string;
  fileCount: number;
  addedCount: number;
  modifiedCount: number;
  removedCount: number;
  unchangedCount: number;
  totalBytes: number;
}

export interface SourceFileEntry {
  versionId: string;
  logicalPath: string;
  category: SourceCategory;
  contentHash: string;
  byteSize: number;
}

export type SourceFileChange =
  | { kind: "added"; logicalPath: string; category: SourceCategory; contentHash: string }
  | { kind: "modified"; logicalPath: string; category: SourceCategory; contentHash: string; previousHash: string }
  | { kind: "removed"; logicalPath: string; category: SourceCategory; previousHash: string };

export interface ImportBundleResult {
  bundle: SourceBundle;
  version: SourceBundleVersion;
  changes: SourceFileChange[];
  newBlobCount: number;
}

export interface AssetPackage {
  packageId: string;
  name: string;
  kind: string;
  status: PackageStatus;
  description: string;
  createdByRunId: string;
  sourceVersionIds: string[];
  legacyPaths: string[];
  qualitySummary: Record<string, unknown>;
  createdAt: string;
}

export interface AssetComponent {
  componentId: string;
  packageId: string;
  artifactId: string;
  group: AssetGroup;
  kind: string;
  title: string;
  status: string;
  legacyPath: string;
  storageUri: string;
  sourceRefs: string[];
  quality: Record<string, unknown>;
}

export interface EvidenceRecord {
  evidenceId: string;
  packageId: string;
  componentId: string;
  sourceVersionId: string;
  quote: string;
  note: string;
  confidence: number;
  createdAt: string;
}

export interface EvidenceCoverage {
  totalComponents: number;
  coveredComponents: number;
  missingComponents: number;
  evidenceRecords: number;
  coverageRate: number;
}

export interface ReviewTask {
  taskId: string;
  packageId: string;
  componentId: string;
  severity: ReviewSeverity;
  status: ReviewStatus;
  title: string;
  description: string;
  suggestedAction: string;
  createdAt: string;
}

export interface ReleaseRecord {
  releaseId: string;
  version: string;
  status: "draft" | "published";
  packageIds: string[];
  publishedAt: string | null;
  publishedBy: string;
  createdBy: string;
  createdAt: string;
  manifestHash: string;
  manifest: Record<string, unknown>;
  qualityGate: Record<string, unknown>;
}

export interface AgentEvent {
  eventId: string;
  releaseId: string;
  query: string;
  hitComponentIds: string[];
  qualityFlags: string[];
  status: "hit" | "miss";
  feedbackType: "hit" | "miss" | "low_quality_hit" | "repeated_query" | "evidence_insufficient" | "relation_inference_failed";
  suggestedAction: string;
  taskId: string;
  createdAt: string;
}

export interface McpAuditRecord {
  auditId: string;
  sessionId: string;
  agentRole: string;
  toolName: string;
  releaseId: string | null;
  queryPayload: Record<string, unknown>;
  hitComponentIds: string[];
  qualityFlags: string[];
  status: "hit" | "miss" | "error";
  latencyMs: number;
  createdAt: string;
}

export interface KnowledgeTrace {
  releaseId: string;
  componentIds: string[];
  artifactIds: string[];
  sourceVersionIds: string[];
  evidenceIds: string[];
}

export interface KnowledgeEnvelope<T = unknown> {
  release: {
    releaseId: string;
    version: string;
    publishedAt: string | null;
    manifestHash: string;
  };
  result: T;
  qualityFlags: string[];
  trace: KnowledgeTrace;
}

export type PipelineStage = "convert" | "extract" | "tables" | "graph" | "viz";
export type BuildRunStatus = "running" | "completed" | "failed";
export type QualitySeverity = "blocking" | "warning" | "info";

export interface KnowledgeBuildRun {
  runId: string;
  sourceVersionId: string;
  packageId: string | null;
  adapter: "native";
  stages: PipelineStage[];
  model: string;
  wikiSpecsHash: string;
  qualityProfileId: string;
  status: BuildRunStatus;
  startedAt: string;
  finishedAt: string | null;
  error: string;
  outputUri: string;
  config: Record<string, unknown>;
}

export interface QualityGateProfile {
  profileId: string;
  name: string;
  active: boolean;
  config: QualityGateConfig;
  createdBy: string;
  updatedAt: string;
}

export interface QualityGateConfig {
  minPackageScore: number;
  rules: Record<string, Record<string, unknown>>;
}

export interface QualityFinding {
  ruleId: string;
  severity: QualitySeverity;
  componentId?: string;
  title: string;
  description: string;
  suggestedAction: string;
  scoreImpact: number;
}
