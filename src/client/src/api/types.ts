export interface LoginResponse {
  token: string;
  user: { id: string; username: string; role: string; displayName: string };
}

export interface SourceBundleDashboard {
  bundles: number;
  versions: number;
  blobs: number;
  totalBytes: number;
  latest: { versionId: string; label: string; createdAt: string; fileCount: number } | null;
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
  category: "gamedata" | "gamedocs";
  contentHash: string;
  byteSize: number;
}

export type SourceFileChange =
  | { kind: "added"; logicalPath: string; category: string; contentHash: string }
  | { kind: "modified"; logicalPath: string; category: string; contentHash: string; previousHash: string }
  | { kind: "removed"; logicalPath: string; category: string; previousHash: string };

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
  status: string;
  description: string;
  createdByRunId: string;
  sourceVersionIds: string[];
  legacyPaths: string[];
  qualitySummary: Record<string, unknown>;
  createdAt: string;
}

export interface SourceRecord {
  sourceId: string;
  sourceVersionId: string;
  title: string;
  sourceType: string;
  status: string;
  contentHash: string;
  storageUri: string;
}

export interface LegacyImportResult {
  created: boolean;
  package: AssetPackage;
  importedSources: number;
  createdComponents: number;
  detail: PackageDetail;
}

export interface AssetComponent {
  componentId: string;
  packageId: string;
  artifactId: string;
  group: string;
  kind: string;
  title: string;
  status: string;
  legacyPath: string;
  storageUri: string;
  sourceRefs: string[];
  quality: Record<string, unknown>;
}

export interface PackageDetail {
  package: AssetPackage;
  components: AssetComponent[];
  reviewTasks: ReviewTask[];
  evidenceRecords: EvidenceRecord[];
  evidenceCoverage: EvidenceCoverage;
}

export interface ComponentContent {
  componentId: string;
  kind: string;
  legacyPath: string;
  storageUri: string;
  content: string;
  truncated: boolean;
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
  severity: "blocking" | "warning" | "info";
  status: string;
  title: string;
  description: string;
  suggestedAction: string;
  createdAt: string;
  resolvedBy: string;
  resolvedAt: string | null;
  resolutionNote: string;
}

export interface KnowledgeBuildRun {
  runId: string;
  sourceVersionId: string;
  packageId: string | null;
  adapter: string;
  stages: string[];
  model: string;
  wikiSpecsHash: string;
  qualityProfileId: string;
  status: string;
  currentStage: string;
  completedStages: string[];
  startedAt: string;
  finishedAt: string | null;
  error: string;
  outputUri: string;
  config: Record<string, unknown>;
}

export interface LocalFileEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
  size: number | null;
  modifiedAt: string;
}

export interface LocalBrowseResult {
  path: string;
  parentPath: string | null;
  entries: LocalFileEntry[];
}

export interface QualityGateProfile {
  profileId: string;
  name: string;
  active: boolean;
  config: Record<string, unknown>;
  createdBy: string;
  updatedAt: string;
}

export interface PageTypeSpec {
  id: string;
  label: string;
  dir: string;
  template: string;
  requiredSections: string[];
  requiredFacts: string[];
  evidenceRequired?: boolean;
  publishable?: boolean;
}

export interface WikiSpecTemplate {
  requiredSections: string[];
  requiredFacts: string[];
  evidenceRequired: boolean;
  guidance: string;
}

export interface DocumentTypeSpec {
  id: string;
  label: string;
  description: string;
  defaultPageTypeId: string;
  wikiSpecTemplate: WikiSpecTemplate;
  publishable?: boolean;
}

export interface EntityTypeSpec {
  id: string;
  label: string;
  publishable: boolean;
}

export interface RelationTypeSpec {
  id: string;
  label: string;
  direction: "source_to_target" | "bidirectional";
  publishable: boolean;
  autoGenerated: boolean;
}

export interface KnowledgeRuleConfig {
  documentTypes: Record<string, DocumentTypeSpec>;
  pageTypes: Record<string, PageTypeSpec>;
  entityTypes: EntityTypeSpec[];
  relationTypes: RelationTypeSpec[];
  tableRules: {
    autoConfirmFieldIdSuffixes: string[];
    candidateFieldIdSuffixes: string[];
  };
  qualityRules: Record<string, Record<string, unknown>>;
}

export interface KnowledgeRuleProfile {
  profileId: string;
  name: string;
  active: boolean;
  hash: string;
  config: KnowledgeRuleConfig;
  createdBy: string;
  updatedAt: string;
}

export interface BuildRequest {
  stages: string[];
  model: string;
  modelConfig?: BuildModelConfig;
  force: boolean;
  only: string | null;
  qualityProfileId: string;
  generateAliases?: boolean;
}

export type BuildModelConfig =
  | { provider: "deterministic"; model: "deterministic" }
  | { provider: "openai-compatible"; baseUrl: string; model: string; apiKey?: string }
  | { provider: "anthropic"; baseUrl: string; model: string; apiKey?: string };

export interface BuildResponse {
  run: KnowledgeBuildRun;
}

export interface ModelConnectivityResult {
  ok: boolean;
  provider: string;
  model: string;
  message: string;
}

export interface ReleaseRecord {
  releaseId: string;
  version: string;
  status: string;
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
  feedbackType: string;
  suggestedAction: string;
  taskId: string;
  createdAt: string;
}

export interface AttributionSegment {
  segmentId: string;
  text: string;
  attributionType: "引用" | "推导" | "创作" | "无法判断";
  trace: Partial<KnowledgeEnvelope["trace"]>;
  derivedFrom: string[];
  risk: string;
}

export interface AttributionAudit {
  auditId: string;
  releaseId: string;
  title: string;
  segments: AttributionSegment[];
  createdBy: string;
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

export interface KnowledgeEnvelope<T = unknown> {
  release: {
    releaseId: string;
    version: string;
    publishedAt: string | null;
    manifestHash: string;
  };
  result: T;
  qualityFlags: string[];
  trace: {
    releaseId: string;
    componentIds: string[];
    artifactIds: string[];
    sourceVersionIds: string[];
    evidenceIds: string[];
  };
}

export type DiagnosticLogLevel = "debug" | "info" | "warn" | "error";
export type DiagnosticLogCategory = "http" | "source_import" | "kb_build" | "llm" | "release" | "mcp" | "db" | "system";
export type DiagnosticLogStatus = "started" | "completed" | "failed" | "event";

export interface DiagnosticLogRecord {
  logId: string;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  level: DiagnosticLogLevel;
  category: DiagnosticLogCategory;
  message: string;
  status: DiagnosticLogStatus;
  durationMs: number | null;
  actor: string;
  route: string;
  method: string;
  entityType: string;
  entityId: string;
  runId: string;
  releaseId: string;
  requestPayload: Record<string, unknown>;
  context: Record<string, unknown>;
  errorName: string;
  errorMessage: string;
  errorStack: string;
  createdAt: string;
}

export interface DiagnosticSummary {
  errors24h: number;
  slowRequests24h: number;
  failedBuilds24h: number;
  mcpErrors24h: number;
  llmErrors24h: number;
}

export interface DiagnosticLogQuery {
  level?: string;
  category?: string;
  status?: string;
  traceId?: string;
  runId?: string;
  releaseId?: string;
  entityId?: string;
  q?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface LegacyScanSummary {
  root: string;
  recommendedPackageId: string;
  sources: { total: number; files: string[] };
  wiki: { pages: number; files: string[] };
  index: { files: number; paths: string[] };
  graph: { files: number; paths: string[] };
  tables: { files: number; paths: string[] };
  warnings: string[];
}

export interface DashboardSummary {
  sources: SourceBundleDashboard;
  packages: { total: number; byStatus: Record<string, number> };
  components: { total: number; byGroup: Record<string, number> };
  review: { open: number; blocking: number; warning: number };
  release: { current: ReleaseRecord | null; total: number };
  agent: { recentQueries: number; misses: number; lowQualityHits: number };
  evidence: EvidenceCoverage;
}

// --- Storage maintenance ---

export type StorageCategory = "blobs" | "kb_build_runs" | "web_imports" | "releases" | "logs";

export interface StorageEntry {
  category: StorageCategory;
  key: string;
  bytes: number;
  fileCount: number;
  oldestMs: number | null;
  newestMs: number | null;
  status: "live" | "reclaimable";
  reason: string;
}

export interface StorageCategorySummary {
  category: StorageCategory;
  totalBytes: number;
  fileCount: number;
  entryCount: number;
  liveBytes: number;
  reclaimableBytes: number;
  reclaimableEntries: number;
  oldestMs: number | null;
  newestMs: number | null;
}

export interface StorageOverview {
  categories: StorageCategorySummary[];
  totalBytes: number;
  reclaimableBytes: number;
  scannedAt: string;
}

export interface StorageScanReport extends StorageOverview {
  entries: StorageEntry[];
}

export interface ReclaimResult {
  deletedEntries: number;
  reclaimedBytes: number;
  perCategory: Partial<Record<StorageCategory, { count: number; bytes: number }>>;
}

// --- Cross-entity search ---

export type SearchHitKind = "package" | "component" | "source_version" | "release";

export interface SearchHit {
  kind: SearchHitKind;
  id: string;
  title: string;
  subtitle: string;
  packageId?: string;
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
}

export interface TableAliasEntry {
  canonical: string;
  aliases: string[];
  source: "manual" | "llm";
  updatedBy: string;
  updatedAt: string;
}
