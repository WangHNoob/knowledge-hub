export interface LoginResponse {
  token: string;
  user: { id: string; username: string; role: string; displayName: string };
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

export interface BuildRequest {
  stages: string[];
  model: string;
  modelConfig?: BuildModelConfig;
  force: boolean;
  only: string | null;
  qualityProfileId: string;
}

export type BuildModelConfig =
  | { provider: "deterministic"; model: "deterministic" }
  | { provider: "openai-compatible"; baseUrl: string; model: string; apiKey?: string }
  | { provider: "anthropic-compatible"; baseUrl: string; model: string; apiKey?: string };

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

const TOKEN_KEY = "kh_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export async function login(username: string, password: string): Promise<LoginResponse> {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  return parseResponse(response);
}

export async function getDashboard(): Promise<DashboardSummary> {
  return getJson("/api/dashboard");
}

export async function listSourceBundles(): Promise<SourceBundle[]> {
  return (await getJson<{ bundles: SourceBundle[] }>("/api/source-bundles")).bundles;
}

export async function listBundleVersions(bundleId: string): Promise<SourceBundleVersion[]> {
  return (
    await getJson<{ versions: SourceBundleVersion[] }>(
      `/api/source-bundles/${encodeURIComponent(bundleId)}/versions`
    )
  ).versions;
}

export async function getBundleVersion(
  bundleId: string,
  versionId: string
): Promise<{ version: SourceBundleVersion; files: SourceFileEntry[]; changes: SourceFileChange[] }> {
  return getJson(
    `/api/source-bundles/${encodeURIComponent(bundleId)}/versions/${encodeURIComponent(versionId)}`
  );
}

export async function importSourceBundle(
  bundleId: string,
  rootPath: string,
  note?: string
): Promise<ImportBundleResult> {
  const response = await fetch(`/api/source-bundles/${encodeURIComponent(bundleId)}/versions`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json"
    },
    body: JSON.stringify({ rootPath, note })
  });
  return parseResponse(response);
}

export async function buildKnowledgePackage(bundleId: string, versionId: string, payload: BuildRequest): Promise<BuildResponse> {
  const response = await fetch(`/api/source-bundles/${encodeURIComponent(bundleId)}/versions/${encodeURIComponent(versionId)}/build`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  return parseResponse(response);
}

export async function listPackages(): Promise<AssetPackage[]> {
  return (await getJson<{ packages: AssetPackage[] }>("/api/packages")).packages;
}

export async function getPackage(packageId: string): Promise<PackageDetail> {
  return getJson(`/api/packages/${encodeURIComponent(packageId)}`);
}

export async function listReviewTasks(severity?: string): Promise<ReviewTask[]> {
  const suffix = severity ? `?severity=${encodeURIComponent(severity)}` : "";
  return (await getJson<{ tasks: ReviewTask[] }>(`/api/review/tasks${suffix}`)).tasks;
}

export async function listBuildRuns(): Promise<KnowledgeBuildRun[]> {
  return (await getJson<{ runs: KnowledgeBuildRun[] }>("/api/build-runs")).runs;
}

export async function stopBuildRun(runId: string): Promise<KnowledgeBuildRun> {
  const response = await fetch(`/api/build-runs/${encodeURIComponent(runId)}/stop`, {
    method: "POST",
    headers: authHeaders()
  });
  return (await parseResponse<{ run: KnowledgeBuildRun }>(response)).run;
}

export async function deleteBuildRun(runId: string): Promise<boolean> {
  const response = await fetch(`/api/build-runs/${encodeURIComponent(runId)}`, {
    method: "DELETE",
    headers: authHeaders()
  });
  return (await parseResponse<{ deleted: boolean }>(response)).deleted;
}

export async function browseLocalFiles(path?: string): Promise<LocalBrowseResult> {
  const suffix = path ? `?path=${encodeURIComponent(path)}` : "";
  return getJson(`/api/local-files/browse${suffix}`);
}

export async function testModelConnectivity(modelConfig: BuildModelConfig): Promise<ModelConnectivityResult> {
  const response = await fetch("/api/model-connectivity/test", {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json"
    },
    body: JSON.stringify({ modelConfig })
  });
  return parseResponse(response);
}

export async function uploadSourceBundle(
  bundleId: string,
  files: File[],
  note?: string
): Promise<ImportBundleResult> {
  const form = new FormData();
  if (note) form.set("note", note);
  for (const file of files) {
    const relativePath = webkitRelativePath(file) || file.name;
    form.append("files", file, relativePath);
  }
  const response = await fetch(`/api/source-bundles/${encodeURIComponent(bundleId)}/uploads`, {
    method: "POST",
    headers: authHeaders(),
    body: form
  });
  return parseResponse(response);
}

export async function getQualityProfile(): Promise<QualityGateProfile> {
  return (await getJson<{ profile: QualityGateProfile }>("/api/quality-gate/profile")).profile;
}

export async function updateQualityProfile(config: Record<string, unknown>): Promise<QualityGateProfile> {
  const response = await fetch("/api/quality-gate/profile", {
    method: "PUT",
    headers: {
      ...authHeaders(),
      "content-type": "application/json"
    },
    body: JSON.stringify({ config })
  });
  return (await parseResponse<{ profile: QualityGateProfile }>(response)).profile;
}

export async function listEvidence(packageId: string): Promise<{ records: EvidenceRecord[]; coverage: EvidenceCoverage }> {
  return getJson(`/api/evidence?packageId=${encodeURIComponent(packageId)}`);
}

export async function listReleases(): Promise<ReleaseRecord[]> {
  return (await getJson<{ releases: ReleaseRecord[] }>("/api/releases")).releases;
}

export async function getCurrentRelease(): Promise<ReleaseRecord | null> {
  return (await getJson<{ release: ReleaseRecord | null }>("/api/releases/current")).release;
}

export async function createRelease(version: string, packageIds: string[]): Promise<ReleaseRecord> {
  const response = await fetch("/api/releases", {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json"
    },
    body: JSON.stringify({ version, packageIds })
  });
  return (await parseResponse<{ release: ReleaseRecord }>(response)).release;
}

export async function publishRelease(releaseId: string): Promise<ReleaseRecord> {
  const response = await fetch(`/api/releases/${encodeURIComponent(releaseId)}/publish`, {
    method: "POST",
    headers: authHeaders()
  });
  return (await parseResponse<{ release: ReleaseRecord }>(response)).release;
}

export async function rollbackRelease(releaseId: string): Promise<ReleaseRecord> {
  const response = await fetch("/api/releases/rollback", {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json"
    },
    body: JSON.stringify({ releaseId })
  });
  return (await parseResponse<{ release: ReleaseRecord }>(response)).release;
}

export async function listAgentEvents(): Promise<AgentEvent[]> {
  return (await getJson<{ events: AgentEvent[] }>("/api/agent/events")).events;
}

export async function listMcpAudit(): Promise<McpAuditRecord[]> {
  return (await getJson<{ audit: McpAuditRecord[] }>("/api/mcp/audit")).audit;
}

export async function simulateMcpQuery(toolName: string, payload: Record<string, unknown>): Promise<KnowledgeEnvelope> {
  const response = await fetch("/api/mcp/query", {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json"
    },
    body: JSON.stringify({ toolName, payload })
  });
  return (await parseResponse<{ envelope: KnowledgeEnvelope }>(response)).envelope;
}

export async function getDiagnosticSummary(): Promise<DiagnosticSummary> {
  return (await getJson<{ summary: DiagnosticSummary }>("/api/diagnostics/summary")).summary;
}

export async function listDiagnosticLogs(query: DiagnosticLogQuery = {}): Promise<DiagnosticLogRecord[]> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && String(value).trim() !== "") params.set(key, String(value));
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return (await getJson<{ logs: DiagnosticLogRecord[] }>(`/api/diagnostics/logs${suffix}`)).logs;
}

export async function getDiagnosticTrace(traceId: string): Promise<DiagnosticLogRecord[]> {
  return (await getJson<{ logs: DiagnosticLogRecord[] }>(`/api/diagnostics/logs/${encodeURIComponent(traceId)}`)).logs;
}

export async function scanLegacy(path: string): Promise<LegacyScanSummary> {
  const response = await fetch("/api/legacy/scan", {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json"
    },
    body: JSON.stringify({ path })
  });
  return parseResponse(response);
}

export async function importLegacy(path: string): Promise<LegacyImportResult> {
  const response = await fetch("/api/legacy/import", {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json"
    },
    body: JSON.stringify({ path })
  });
  return parseResponse(response);
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: authHeaders()
  });
  return parseResponse(response);
}

function authHeaders(): HeadersInit {
  const token = getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function parseResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  return payload as T;
}

function webkitRelativePath(file: File): string {
  return typeof (file as File & { webkitRelativePath?: string }).webkitRelativePath === "string"
    ? (file as File & { webkitRelativePath: string }).webkitRelativePath
    : "";
}
