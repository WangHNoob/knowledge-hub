export interface LoginResponse {
  token: string;
  user: { id: string; username: string; role: string; displayName: string; currentProjectId?: string };
}

export interface ProjectRecord {
  projectId: string;
  name: string;
  description: string;
  status: "active" | "archived";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
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
  projectId: string;
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

export interface SourcePreviewNode {
  name: string;
  path: string;
  kind: "directory" | "file";
  category?: "gamedata" | "gamedocs";
  byteSize?: number;
  contentHash?: string;
  fileType?: "markdown" | "spreadsheet" | "json" | "text" | "binary";
  changeKind?: "added" | "modified" | "removed" | "unchanged";
  children?: SourcePreviewNode[];
}

export interface SourceFilePreview {
  logicalPath: string;
  category: "gamedata" | "gamedocs";
  byteSize: number;
  contentHash: string;
  fileType: SourcePreviewNode["fileType"];
  preview: string[];
  sheet?: string;
  rows?: unknown[][];
  truncated: boolean;
}

export interface SourceBuildPlan {
  recommendedMode: "incremental" | "full";
  targets: string[];
  reason: string;
  affectedKnowledge: Array<{ componentId: string; packageId: string; title: string; kind: string; legacyPath: string }>;
  warnings: string[];
}

export interface ImportBundleResult {
  bundle: SourceBundle;
  version: SourceBundleVersion;
  changes: SourceFileChange[];
  newBlobCount: number;
  sync?: FlywheelSyncResult;
}

export interface AssetPackage {
  packageId: string;
  projectId: string;
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

export interface TrustScoreBreakdown {
  evidence: number;
  completeness: number;
  auditFreshness: number;
  consistency: number;
}

export interface TrustScoreCap {
  id: string;
  label: string;
  maxScore: number;
}

export interface TrustScore {
  version: "v2-lite";
  score: number;
  status: "trusted" | "usable_with_risk" | "needs_review" | "blocked";
  breakdown: TrustScoreBreakdown;
  caps: TrustScoreCap[];
  reasons: string[];
  lastTrustedAuditAt: string | null;
  auditHalfLifeDays: number;
  evidenceRequired: boolean;
}

export interface KnowledgeEnvelopeTrustScore {
  version: TrustScore["version"];
  score: number;
  status: TrustScore["status"];
  lastTrustedAuditAt: string | null;
  evidenceRequired: boolean;
}

export interface TrustPolicyDimension {
  key: keyof TrustScoreBreakdown;
  label: string;
  weight: number;
  source: string;
  formula: string;
  intent: string;
}

export interface TrustPolicyStatusBand {
  status: TrustScore["status"];
  label: string;
  minScore: number;
  description: string;
}

export interface TrustPolicyCap extends TrustScoreCap {
  trigger: string;
}

export interface TrustPolicyAuditHalfLife {
  matcher: string;
  days: number;
  label: string;
}

export interface TrustPolicy {
  version: TrustScore["version"];
  editable: boolean;
  owner: string;
  position: string;
  dimensions: TrustPolicyDimension[];
  statusBands: TrustPolicyStatusBand[];
  caps: TrustPolicyCap[];
  auditHalfLifeDays: TrustPolicyAuditHalfLife[];
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
  taskKind: "review" | "annotation";
  ruleId: string;
  title: string;
  description: string;
  suggestedAction: string;
  candidates: Array<{ id: string; label: string; value: unknown; confidence?: number; rationale?: string }>;
  confidence: number;
  contextSnapshot: Record<string, unknown>;
  annotationValue: Record<string, unknown>;
  annotatedBy: string;
  annotatedAt: string | null;
  createdAt: string;
  resolvedBy: string;
  resolvedAt: string | null;
  resolutionNote: string;
  learning: ReviewLearningSummary;
  writeback: ReviewWritebackSummary | null;
  autoFixed: boolean;
  llmAnalysis: LlmAnalysis | null;
}

export interface LlmAnalysis {
  diagnosis: string;
  confidence: number;
  rationale: string;
  fixType: "annotation_override" | "needs_human" | "no_fix";
  modelProvider: string;
  modelName: string;
  generatedAt: string;
}

export interface ReviewLearningSummary {
  recurrenceCount: number;
  openSimilarCount: number;
  exampleCount: number;
  buildExamplesInjected: number;
  lastAnnotation: {
    exampleId: string;
    correctValue: Record<string, unknown>;
    createdBy: string;
    createdAt: string;
  } | null;
}

export interface ReviewWritebackSummary {
  requestedAt: string;
  requestedEventId: string;
  startedAt: string | null;
  startedEventId: string;
  sourcePath: string;
  exampleId: string;
  runId: string;
  runStatus: string;
  runPackageId: string;
  only: string;
  buildCompletedAt: string | null;
  releaseId: string;
  releaseStatus: string;
  releaseAt: string | null;
  autoPublishStatus: "none" | "published" | "skipped";
  autoPublishReason: string;
}

export interface BuildRunWritebackTrace extends ReviewWritebackSummary {
  taskId: string;
  taskTitle: string;
  taskStatus: string;
  taskSeverity: string;
  taskRuleId: string;
  componentId: string;
  packageId: string;
}

export interface AnnotationExample {
  exampleId: string;
  packageId: string;
  componentId: string;
  taskId: string;
  ruleId: string;
  applyMode: "hint" | "override";
  pageType: string;
  contextHash: string;
  contextSnapshot: Record<string, unknown>;
  correctValue: Record<string, unknown>;
  active: boolean;
  injectedBuildCount: number;
  lastInjectedAt: string | null;
  lastInjectedRunId: string;
  effect: AnnotationExampleEffect;
  lifecycle: AnnotationExampleLifecycle;
  createdBy: string;
  createdAt: string;
}

export interface SourceCorrection {
  correctionId: string;
  bundleId: string;
  sourcePath: string;
  ruleId: string;
  pageType: string;
  factKey: string | null;
  boundSourceHash: string;
  state: "active" | "pending_review" | "retired" | string;
  correctValue: Record<string, unknown>;
  componentId: string | null;
  packageId: string | null;
  exampleId: string;
  taskId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AnnotationExampleEffect {
  tasksBefore: number;
  tasksAfter: number;
  openTasksAfter: number;
  openTaskIds: string[];
  agentNegativeAfter: number;
  status: "converging" | "watch" | "needs_review";
  reviewTaskId: string;
  summary: string;
}

export interface AnnotationExampleLifecycle {
  lastReviewAction: string;
  lastReviewedBy: string;
  lastReviewedAt: string | null;
  reviewTaskId: string;
  writebackRequested: boolean;
  writebackTaskId: string;
  writebackRequestedAt: string | null;
  writeback: ReviewWritebackSummary | null;
  summary: string;
}

export interface KnowledgeBuildRun {
  runId: string;
  projectId: string;
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
  writebackTraces: BuildRunWritebackTrace[];
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
  governanceRules: KnowledgeGovernanceRules;
}

export type RuleSeverity = "blocking" | "warning" | "info";

export interface KnowledgeGovernanceRules {
  schema: {
    requireFrontmatter: boolean;
    requireOkfType: boolean;
    requireDescription: boolean;
    requireTags: boolean;
    allowObsidianLinks: boolean;
    linkMode: "okf_absolute";
  };
  evidence: {
    requiredComponentKinds: string[];
    citationRequiredOkfTypes: string[];
    autoBackfillOnPublish: boolean;
    missingEvidenceSeverity: RuleSeverity;
  };
  trust: {
    policyVersion: TrustScore["version"];
    trustedMinScore: number;
    usableMinScore: number;
    reviewMinScore: number;
    blockBelowScore: number;
    warnBelowScore: number;
    blockOnLowTrust: boolean;
  };
  lint: {
    enabledDomains: string[];
    blockingDomains: string[];
    failPublishOnBlocking: boolean;
  };
  agent: {
    includeTrustInMcp: boolean;
    includeEvidenceInMcp: boolean;
    recordUnresolvedQueries: boolean;
    repeatedMissBlockingThreshold: number;
  };
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
  releaseVersion?: string;
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
  projectId: string;
  parentReleaseId: string | null;
  version: string;
  status: string;
  packageIds: string[];
  note: string;
  publishedAt: string | null;
  publishedBy: string;
  createdBy: string;
  createdAt: string;
  manifestHash: string;
  manifest: Record<string, unknown>;
  qualityGate: Record<string, unknown>;
}

export interface ReleaseAuditSummary {
  version: 1;
  generatedAt: string;
  release: {
    releaseId: string;
    version: string;
    publishedAt: string;
    publishedBy: string;
  };
  sources: {
    sourceVersionIds: string[];
    packageCount: number;
    componentCount: number;
    packages: Array<{ packageId: string; name: string; status: string; sourceVersionIds: string[] }>;
  };
  build: {
    runCount: number;
    completed: number;
    failed: number;
    running: number;
    cachedStages: number;
    runs: Array<{
      runId: string;
      sourceVersionId: string;
      status: string;
      stages: string[];
      completedStages: string[];
      startedAt: string;
      finishedAt: string | null;
      durationMs: number | null;
    }>;
  };
  assets: {
    byGroup: Record<string, number>;
    byKind: Record<string, number>;
  };
  evidence: {
    requiredComponents: number;
    coveredComponents: number;
    missingComponents: number;
    evidenceRecords: number;
    coverageRate: number;
  };
  trust: {
    averageScore: number | null;
    minScore: number | null;
    statusCounts: Record<string, number>;
    lowTrustComponents: Array<{
      componentId: string;
      title: string;
      artifactId: string;
      kind: string;
      score: number | null;
      status: string;
      reasons: string[];
    }>;
  };
  review: {
    open: number;
    blocking: number;
    warning: number;
    info: number;
    resolvedSincePreviousRelease: number;
    topOpenTasks: Array<{
      taskId: string;
      componentId: string;
      severity: string;
      title: string;
      suggestedAction: string;
    }>;
  };
  agentFeedback: {
    windowStart: string | null;
    windowEnd: string;
    mcpCalls: number;
    mcpMisses: number;
    mcpErrors: number;
    feedbackEvents: number;
    feedbackByType: Record<string, number>;
    topQueries: Array<{ query: string; count: number }>;
  };
  qualityGate: Record<string, unknown>;
  legislationProfileHash: string;
  okf?: {
    summary: { blocking: number; warning: number; info: number };
    linkSummary: { resolved: number; ambiguous: number; unresolved: number };
    citationSummary: { required: number; present: number };
    conceptCount: number;
    reportUri: string;
    reportMarkdownUri: string;
  };
}

export interface KnowledgeLintSummary {
  score: number;
  blocking: number;
  warning: number;
  info: number;
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
  components: AgentEventComponent[];
}

export interface AgentEventComponent {
  componentId: string;
  packageId: string;
  title: string;
  kind: string;
  artifactId: string;
  legacyPath: string;
  quality: Record<string, unknown>;
  confidence: number | null;
  trust: TrustScore | null;
  evidenceRecords: number;
}

export type FlywheelWorkbenchView =
  | "dashboard"
  | "sources"
  | "legislation"
  | "builder"
  | "assets"
  | "aliases"
  | "review"
  | "release"
  | "agent"
  | "storage"
  | "diagnostics"
  | "maintenance";

export interface FlywheelWorkbenchTarget {
  view: FlywheelWorkbenchView;
  params?: Record<string, string>;
}

export interface FlywheelWorkbenchAction extends FlywheelWorkbenchTarget {
  label: string;
}

export interface FlywheelRiskItem extends FlywheelWorkbenchTarget {
  key: string;
  label: string;
  tone?: "hot" | "warn" | "ok";
  title: string;
  body: string;
  code: string;
  meta: string;
}

export interface FlywheelWorkbench {
  state: "attention" | "publish" | "clear";
  headline: string;
  summary: string;
  primary: FlywheelWorkbenchAction;
  annotationTasks: ReviewTask[];
  retestItems: AgentEvent[];
  publishItems: ReleaseRecord[];
  riskItems: FlywheelRiskItem[];
  runningRuns: KnowledgeBuildRun[];
}

export type FlywheelState =
  | "idle"
  | "source_changed"
  | "building"
  | "ready_to_publish"
  | "published"
  | "needs_attention";

export type FlywheelPrimaryActionType =
  | "sync_and_publish"
  | "open_exceptions"
  | "open_sources"
  | "open_release"
  | "retest_agent";

export interface FlywheelPrimaryAction {
  label: string;
  action: FlywheelPrimaryActionType;
  params?: Record<string, string>;
}

export interface FlywheelMetrics {
  sourceChanges: number;
  runningBuilds: number;
  pendingExceptions: number;
  currentReleaseVersion: string;
  agentFeedbackOpen: number;
  autoGovernedToday: number;
}

export type FlywheelAttentionType = "exception" | "feedback" | "publish_blocker" | "lint";
export type FlywheelAttentionLevel = "blocking" | "needs_decision" | "watch";

export interface HumanException {
  id: string;
  type: FlywheelAttentionType;
  attentionLevel: FlywheelAttentionLevel;
  severity: "blocking" | "warning" | "info";
  title: string;
  body: string;
  whyHumanNeeded: string;
  recommendedAction: string;
  primaryAction: {
    label: string;
    type: "annotate" | "approve" | "reject" | "open_asset" | "rerun";
  };
  target?: { page: FlywheelWorkbenchView; params?: Record<string, string> };
  technicalIds?: { componentId?: string; packageId?: string; releaseId?: string; taskId?: string; eventId?: string };
  createdAt: string;
}

export interface FlywheelAutomationItem {
  id: string;
  title: string;
  status: "running" | "completed" | "skipped" | "failed";
  createdAt: string;
}

export interface DismissedException {
  dismissalId: string;
  projectId: string;
  dedupKey: string;
  exceptionType: string;
  title: string;
  reason: string;
  dismissedBy: string;
  dismissedAt: string;
  restoredBy: string;
  restoredAt: string | null;
}

export type LintRemediationActionType = "auto_remediation" | "rebuild" | "manual_review" | "monitor";
export type LintRemediationStatus = "pending" | "running" | "completed" | "failed" | "needs_human";

export interface KnowledgeLintRemediation {
  remediationId: string;
  projectId: string;
  releaseId: string;
  issueId: string;
  domain: "links" | "evidence" | "graph" | "trust" | "table_dependencies" | "mcp_feedback";
  severity: "blocking" | "warning" | "info";
  actionType: LintRemediationActionType;
  confidence: number;
  autoEligible: boolean;
  status: LintRemediationStatus;
  title: string;
  diagnosis: string;
  remediation: string;
  targetComponentId: string;
  targetOkfPath: string;
  runId: string;
  error: string;
  createdAt: string;
  finishedAt: string | null;
}

export interface LintRemediationSummary {
  releaseId: string;
  total: number;
  autoGoverned: number;
  needsHuman: number;
  failed: number;
  pending: number;
  byStatus: Record<LintRemediationStatus, number>;
}

export type FeedbackClusterType = "knowledge_gap" | "bad_hit" | "stale_knowledge" | "low_trust_hit";

export interface AgentFeedbackCluster {
  clusterId: string;
  projectId: string;
  type: FeedbackClusterType;
  title: string;
  queryExamples: string[];
  affectedComponents: Array<{ componentId: string; title: string }>;
  count: number;
  severity: "blocking" | "warning" | "info";
  recommendedAction: string;
  status: "open" | "auto_governing" | "needs_human" | "resolved" | "ignored";
  primaryAction: { label: string; type: "rerun" | "annotate" | "ignore" };
  lastSeenAt: string;
}

export interface FlywheelStatus {
  state: FlywheelState;
  headline: string;
  summary: string;
  primaryAction: FlywheelPrimaryAction;
  metrics: FlywheelMetrics;
  attentionItems: HumanException[];
  recentAutomation: FlywheelAutomationItem[];
  remediation: LintRemediationSummary;
}

export interface FlywheelSyncResult {
  syncId: string;
  status: "started" | "completed" | "needs_attention" | "failed";
  buildRunIds: string[];
  packageIds: string[];
  releaseId?: string;
  published: boolean;
  mode: "incremental" | "full";
  message: string;
  attentionItems: HumanException[];
  automationEvents: string[];
}

export interface FlywheelEvent {
  eventId: string;
  eventType: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;  createdAt: string;
}

export interface KnowledgeGovernanceProfile {
  projectId: string;
  trust: { minAutoPublishScore: number; requireEvidence: boolean };
  lint: { autoGovernanceEnabled: boolean; autoEligibleThreshold: number };
  release: {
    autoPublishRevisions: boolean;
    blockOnDeletes: boolean;
    blockOnTrustDecline: boolean;
    blockOnPendingCorrections: boolean;
  };
  feedback: { autoClusterEnabled: boolean; highFrequencyThreshold: number };
  eval: {
    enabled: boolean;
    goldPath: string;
    minHitAtK: number;
    minCitationCoverage: number;
    blockOnRegression: boolean;
  };
  source: "default" | "project";
  updatedBy: string;
  updatedAt: string;
}

export type KnowledgeGovernanceProfileInput = {
  trust?: Partial<KnowledgeGovernanceProfile["trust"]>;
  lint?: Partial<KnowledgeGovernanceProfile["lint"]>;
  release?: Partial<KnowledgeGovernanceProfile["release"]>;
  feedback?: Partial<KnowledgeGovernanceProfile["feedback"]>;
  eval?: Partial<KnowledgeGovernanceProfile["eval"]>;
};

export interface FlywheelConvergenceSummary {
  annotations: {
    examples: number;
    components: number;
    rules: number;
    recent7d: number;
    latestAt: string | null;
  };
  dismissals: {
    active: number;
    components: number;
    rules: number;
    latestAt: string | null;
  };
  feedback: {
    total: number;
    negative: number;
    recent7d: number;
    generatedTasks: number;
    openGeneratedTasks: number;
    latestAt: string | null;
  };
  rebuilds: {
    scoped: number;
    running: number;
    completed: number;
    failed: number;
    latestAt: string | null;
  };
  automation: {
    revisionsProposed: number;
    autoPublished: number;
    autoSkipped: number;
    latestAt: string | null;
  };
  reviewLoad: {
    openBlocking: number;
    openAnnotation: number;
    openFeedback: number;
    interventionLoad: number;
  };
  pilot?: {
    exceptionRate: number;
    pendingExceptionsProxy: number;
    autoGoverned: number;
    dismissedActive: number;
    openGapCandidates: number;
    skipReasonDistribution: Array<{ code: string; label: string; count: number; pct: number }>;
    aliasRemediation: {
      attempts: number;
      applied: number;
      noAction: number;
      successRate: number | null;
    };
    attribution: {
      totalSegments: number;
      creationSegments: number;
      ungroundedSegments: number;
      creationRatio: number;
      ungroundedRatio: number;
    };
    windowDays: number;
  };
}

export interface McpConnectInfo {
  transport: "streamable_http";
  url: string;
  auth: {
    type: "bearer";
    header: string;
    valueTemplate: string;
  };
  currentUser: {
    username: string;
    role: string;
    currentProjectId?: string;
  };
  project?: {
    projectId: string;
    defaultToolPayload: Record<string, unknown>;
  };
  capabilities?: {
    unified: string[];
    hardBoundaries: string[];
  };
  examples: {
    generic: Record<string, unknown>;
    stdioLocal: Record<string, unknown>;
  };
  notes: string[];
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
  components: AgentEventComponent[];
  qualityFlags: string[];
  status: "hit" | "miss" | "error";
  latencyMs: number;
  createdAt: string;
}

export interface KnowledgeEnvelope<T = unknown> {
  contract: {
    schemaVersion: "knowledge-envelope/v1";
    toolName: string;
    stableFields: string[];
    capabilities: {
      trust: "included";
      evidence: "linked" | "none";
      graph: "available" | "not_applicable";
      tables: "available" | "not_applicable";
      feedback: "auto_recorded" | "explicit_report" | "none";
    };
  };
  release: {
    releaseId: string;
    version: string;
    publishedAt: string | null;
    manifestHash: string;
  };
  result: T;
  qualityFlags: string[];
  trust: {
    averageScore: number | null;
    minScore: number | null;
    summary?: {
      level: "high" | "medium" | "low" | "unknown";
      evidenceCount: number;
      sourceRefs: string[];
      lastReviewedAt: string | null;
      lastPublishedAt: string | null;
      negativeFeedbackCount: number;
      lintStatus: "passed" | "warning" | "failed" | "unknown";
      correctionStatus: "none" | "pending" | "applied" | "published";
      ruleProfileHash: string;
    };
    components: Array<{
      componentId: string;
      artifactId: string;
      title: string;
      kind: string;
      trust: KnowledgeEnvelopeTrustScore | null;
    }>;
    componentsSummary?: {
      count: number;
      sampleComponentIds: string[];
      truncated: boolean;
    };
  };
  trace: {
    releaseId: string;
    componentIds: string[];
    artifactIds: string[];
    sourceVersionIds: string[];
    evidenceIds: string[];
    componentIdSummary?: CollectionSample<string>;
    artifactIdSummary?: CollectionSample<string>;
    sourceVersionIdSummary?: CollectionSample<string>;
    evidenceIdSummary?: CollectionSample<string>;
  };
}

export interface CollectionSample<T = string> {
  count: number;
  sample: T[];
  truncated: boolean;
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
