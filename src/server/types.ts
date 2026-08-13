export type UserRole = "admin" | "developer" | "maintainer" | "viewer";

export type AssetGroup =
  | "wiki"
  | "index"
  | "graph"
  | "table"
  | "evidence"
  | "quality"
  | "release";

export interface LlmAnalysis {
  diagnosis: string;
  confidence: number;
  rationale: string;
  fixType: "annotation_override" | "document_rewrite" | "needs_human" | "no_fix";
  modelProvider: string;
  modelName: string;
  generatedAt: string;
}

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
  currentProjectId: string;
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

export type SourceCategory = "gamedata" | "gamedocs";

export interface SourceBlob {
  contentHash: string;
  byteSize: number;
  storageUri: string;
  firstSeenAt: string;
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
  category: SourceCategory;
  contentHash: string;
  byteSize: number;
}

export type SourceFileChange =
  | { kind: "added"; logicalPath: string; category: SourceCategory; contentHash: string }
  | { kind: "modified"; logicalPath: string; category: SourceCategory; contentHash: string; previousHash: string }
  | { kind: "removed"; logicalPath: string; category: SourceCategory; previousHash: string };

export interface SourcePreviewNode {
  name: string;
  path: string;
  kind: "directory" | "file";
  category?: SourceCategory;
  byteSize?: number;
  contentHash?: string;
  fileType?: "markdown" | "spreadsheet" | "json" | "text" | "binary";
  changeKind?: SourceFileChange["kind"] | "unchanged";
  children?: SourcePreviewNode[];
}

export interface SourceFilePreview {
  logicalPath: string;
  category: SourceCategory;
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

export interface TrustScoreBreakdown {
  evidence: number;
  completeness: number;
  auditFreshness: number;
  consistency: number;
  /** 消费维度（flywheel 02-P4）：引用率/点击率/反馈纠偏；无消费数据时缺省。 */
  consumption?: number;
}

export interface TrustScoreCap {
  id: string;
  label: string;
  maxScore: number;
}

export interface TrustScore {
  version: "v2-lite" | "v3-consumption";
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
  taskStatus: ReviewStatus | "";
  taskSeverity: ReviewSeverity | "";
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
  autoGenerated: boolean;
  llmAnalysis: LlmAnalysis | null;
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

export interface RuleDismissal {
  dismissalId: string;
  packageId: string;
  componentId: string;
  componentRef: string;
  ruleId: string;
  reason: string;
  active: boolean;
  createdBy: string;
  createdAt: string;
}

export interface ReleaseRecord {
  releaseId: string;
  projectId: string;
  parentReleaseId: string | null;
  version: string;
  status: "draft" | "published";
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

export interface AgentEvent {
  eventId: string;
  releaseId: string;
  query: string;
  hitComponentIds: string[];
  qualityFlags: string[];
  status: "hit" | "miss";
  feedbackType: "hit" | "miss" | "low_quality_hit" | "repeated_query" | "evidence_insufficient" | "relation_inference_failed" | "knowledge_gap" | "bad_hit" | "stale_knowledge" | "tool_error";
  suggestedAction: string;
  taskId: string;
  /** 语义反馈聚类键（flywheel 02-P3）：同 feedback_type 内 embedding 相似度 ≥ 0.85 归并；空 = 未聚类。 */
  clusterKey: string;
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

/**
 * 轻量知识运营台的总控台状态机。区别于 FlywheelWorkbench（4 泳道任务队列），
 * FlywheelStatus 只回答「当前一句话状态 + 下一步一个主动作」，把细节降级为 metrics / attentionItems。
 */
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

/**
 * 例外中心的一条待人工处理项。requiresHuman=false 的问题不会进入这里。
 * attentionLevel 决定排序与首页曝光：blocking > needs_decision > watch。
 */
export type FlywheelAttentionType = "exception" | "feedback" | "publish_blocker" | "lint";
export type FlywheelAttentionLevel = "blocking" | "needs_decision" | "watch";

export interface HumanException {
  id: string;
  type: FlywheelAttentionType;
  attentionLevel: FlywheelAttentionLevel;
  severity: ReviewSeverity;
  /** 用户视角的问题标题（业务对象优先，避免裸技术 ID） */
  title: string;
  /** 影响了哪个知识 + 展开细节 */
  body: string;
  /** 为什么不能自动处理 */
  whyHumanNeeded: string;
  /** 推荐修复方式 */
  recommendedAction: string;
  primaryAction: {
    label: string;
    type: "annotate" | "approve" | "reject" | "open_asset" | "rerun";
  };
  /** 主按钮的导航目标（复用运营台/子页面路由） */
  target?: { page: FlywheelWorkbenchView; params?: Record<string, string> };
  /** 技术 ID（默认降噪，仅排障用） */
  technicalIds?: { componentId?: string; packageId?: string; releaseId?: string; taskId?: string; eventId?: string };
  createdAt: string;
}

export interface FlywheelAutomationItem {
  id: string;
  title: string;
  status: "running" | "completed" | "skipped" | "failed";
  createdAt: string;
}

/**
 * 一条被人工忽略的例外记录（软忽略：从收件箱隐藏但保留可审计痕迹，可恢复）。
 * dedupKey 取例外的稳定 id；restoredAt 为空表示忽略仍然生效。
 */
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

/**
 * 阶段4：Knowledge Lint 自动治理队列。把发布时生成的 lint issue.governance
 * 从「报告里的建议」落成可追踪的治理任务。autoEligible 的进入自动链路（pending/running），
 * 不能自动的进入 needs_human 并被例外中心收纳。
 */
export type LintRemediationActionType = "auto_remediation" | "rebuild" | "manual_review" | "monitor";
export type LintRemediationStatus = "pending" | "running" | "completed" | "failed" | "needs_human";

export interface KnowledgeLintRemediation {
  remediationId: string;
  projectId: string;
  releaseId: string;
  issueId: string;
  domain: "links" | "evidence" | "graph" | "trust" | "table_dependencies" | "mcp_feedback";
  severity: ReviewSeverity;
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

/**
 * 阶段5：把 MCP 原始反馈事件聚合成策划能理解的知识问题。
 * 用户不需要读 MCP payload，只看「哪类知识问题、影响什么、建议怎么做」。
 */
export type FeedbackClusterType = "knowledge_gap" | "bad_hit" | "stale_knowledge" | "low_trust_hit";

export interface AgentFeedbackCluster {
  clusterId: string;
  projectId: string;
  type: FeedbackClusterType;
  title: string;
  queryExamples: string[];
  affectedComponents: Array<{ componentId: string; title: string }>;
  count: number;
  severity: ReviewSeverity;
  recommendedAction: string;
  status: "open" | "auto_governing" | "needs_human" | "resolved" | "ignored";
  primaryAction: { label: string; type: "rerun" | "annotate" | "ignore" };
  lastSeenAt: string;
}

export interface FlywheelEvent {
  eventId: string;
  eventType: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

/**
 * 阶段6：技术 ID 降噪。读模型对外一律以业务对象（标题/路径/类型）示人，
 * 技术 ID 收进 technicalIds，前端只在 tooltip / 折叠详情 / 复制按钮里展示。
 */
export interface KnowledgeDisplayRef {
  title: string;
  path: string;
  kind: string;
  sourcePath?: string;
  projectName?: string;
  technicalIds: {
    componentId?: string;
    packageId?: string;
    runId?: string;
    releaseId?: string;
  };
}

/**
 * 阶段7：项目级治理规则覆盖层。把 trust / lint 自动治理 / 发布策略 / 反馈聚合
 * 四组开关集中到项目级 profile；未设置的项目回退到环境变量默认值。
 * 与既有 KnowledgeGovernanceRules（策划立法 Profile 内的 schema/evidence/trust/lint/agent）
 * 并存：立法 Profile 管「知识规范」，本 profile 管「运营策略」。
 */
export interface GovernanceTrustPolicy {
  minAutoPublishScore: number;
  requireEvidence: boolean;
  /** 组件超过该天数未复审/可信审计即视为过期（新鲜度 SLA）。 */
  maxAuditAgeDays: number;
}

export interface GovernanceLintPolicy {
  autoGovernanceEnabled: boolean;
  autoEligibleThreshold: number;
}

/** 自动发布策略档（flywheel 02-P3）：off=全关；revisions=反馈驱动的修订版自动发布（首次发布/结构性变更仍人工）；revisions_and_new=修订 + 新发布都自动。 */
export type AutoPublishMode = "off" | "revisions" | "revisions_and_new";

export interface GovernanceReleasePolicy {
  /** 兼容旧字段：mode !== "off" 的派生值（新代码读 autoPublishMode）。 */
  autoPublishRevisions: boolean;
  autoPublishMode: AutoPublishMode;
  blockOnDeletes: boolean;
  blockOnTrustDecline: boolean;
  blockOnPendingCorrections: boolean;
  /** 发布级质量回归门禁：quality_gate（averageScore/blockingCount）对比父发布恶化即挡自动发布。 */
  blockOnQualityRegression: boolean;
}

export interface GovernanceFeedbackPolicy {
  autoClusterEnabled: boolean;
  highFrequencyThreshold: number;
}

/** 自动发布前的检索黄金集回归闸（默认关闭，避免空库/演示库误拦）。 */
export interface GovernanceEvalPolicy {
  enabled: boolean;
  goldPath: string;
  minHitAtK: number;
  minCitationCoverage: number;
  blockOnRegression: boolean;
}

export interface KnowledgeGovernanceProfile {
  projectId: string;
  trust: GovernanceTrustPolicy;
  lint: GovernanceLintPolicy;
  release: GovernanceReleasePolicy;
  feedback: GovernanceFeedbackPolicy;
  eval: GovernanceEvalPolicy;
  /** "default"=全部沿用环境变量默认；"project"=存在项目级覆盖。 */
  source: "default" | "project";
  updatedBy: string;
  updatedAt: string;
}

export type KnowledgeGovernanceProfileInput = {
  trust?: Partial<GovernanceTrustPolicy>;
  lint?: Partial<GovernanceLintPolicy>;
  release?: Partial<GovernanceReleasePolicy>;
  feedback?: Partial<GovernanceFeedbackPolicy>;
  eval?: Partial<GovernanceEvalPolicy>;
};

/** 无组件知识缺口的受控补源候选（禁止无证据直接进 release）。 */
export type GapFillCandidateStatus = "open" | "source_linked" | "dismissed";

export interface GapFillCandidate {
  candidateId: string;
  projectId: string;
  releaseId: string;
  queryKey: string;
  queryRaw: string;
  feedbackType: string;
  expected: string;
  reason: string;
  status: GapFillCandidateStatus;
  sourceBundleId: string;
  sourcePath: string;
  eventCount: number;
  lastSeenAt: string;
  createdAt: string;
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

export interface TableRuleSpec {
  autoConfirmFieldIdSuffixes: string[];
  candidateFieldIdSuffixes: string[];
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

export interface KnowledgeRuleConfig {
  documentTypes: Record<string, DocumentTypeSpec>;
  pageTypes: Record<string, PageTypeSpec>;
  entityTypes: EntityTypeSpec[];
  relationTypes: RelationTypeSpec[];
  tableRules: TableRuleSpec;
  qualityRules: Record<string, Record<string, unknown>>;
  governanceRules: KnowledgeGovernanceRules;
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

export type AttributionType = "引用" | "推导" | "创作" | "无法判断";

export interface AttributionSegment {
  segmentId: string;
  text: string;
  attributionType: AttributionType;
  trace: Partial<KnowledgeTrace>;
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

export interface KnowledgeTrace {
  releaseId: string;
  componentIds: string[];
  artifactIds: string[];
  sourceVersionIds: string[];
  evidenceIds: string[];
  componentIdSummary?: CollectionSample<string>;
  artifactIdSummary?: CollectionSample<string>;
  sourceVersionIdSummary?: CollectionSample<string>;
  evidenceIdSummary?: CollectionSample<string>;
}

export interface CollectionSample<T = string> {
  count: number;
  sample: T[];
  truncated: boolean;
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
  trace: KnowledgeTrace;
}

export type DiagnosticLogLevel = "debug" | "info" | "warn" | "error";
export type DiagnosticLogCategory = "http" | "source_import" | "kb_build" | "llm" | "release" | "mcp" | "db" | "system" | "flywheel";
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

export type PipelineStage = "convert" | "extract" | "tables" | "graph" | "viz";
export type BuildRunStatus = "running" | "completed" | "failed";
export type QualitySeverity = "blocking" | "warning" | "info";

export interface KnowledgeBuildRun {
  runId: string;
  projectId: string;
  sourceVersionId: string;
  packageId: string | null;
  adapter: "native";
  stages: PipelineStage[];
  model: string;
  wikiSpecsHash: string;
  qualityProfileId: string;
  status: BuildRunStatus;
  currentStage: string;
  completedStages: string[];
  startedAt: string;
  finishedAt: string | null;
  error: string;
  outputUri: string;
  config: Record<string, unknown>;
  writebackTraces: BuildRunWritebackTrace[];
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

// --- Storage maintenance (disk GC) ---

export type TableAliasSource = "manual" | "llm";

export interface TableAliasEntry {
  canonical: string;
  aliases: string[];
  source: TableAliasSource;
  updatedBy: string;
  updatedAt: string;
}

export type StorageCategory = "blobs" | "kb_build_runs" | "web_imports" | "releases" | "logs";

export type StorageEntryStatus = "live" | "reclaimable";

export interface StorageEntry {
  category: StorageCategory;
  key: string;            // dir / file name, e.g. runId, releaseId, blob filename, log filename
  bytes: number;
  fileCount: number;
  oldestMs: number | null;
  newestMs: number | null;
  status: StorageEntryStatus;
  reason: string;         // human-readable liveness reason
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

export interface ReclaimRequest {
  categories: StorageCategory[];
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
  id: string;             // packageId / componentId / versionId / releaseId
  title: string;
  subtitle: string;
  packageId?: string;     // for component -> Assets navigation + its owning package
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
}
