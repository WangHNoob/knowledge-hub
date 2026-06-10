export interface LoginResponse {
  token: string;
  user: { id: string; username: string; role: string; displayName: string };
}

export interface DashboardSummary {
  sources: { total: number; active: number };
  packages: { total: number; byStatus: Record<string, number> };
  components: { total: number; byGroup: Record<string, number> };
  review: { open: number; blocking: number; warning: number };
  release: { current: ReleaseRecord | null; total: number };
  agent: { recentQueries: number; misses: number; lowQualityHits: number };
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

export interface ReleaseRecord {
  releaseId: string;
  version: string;
  status: string;
  packageIds: string[];
  publishedAt: string | null;
  qualityGate: Record<string, unknown>;
}

export interface AgentEvent {
  eventId: string;
  releaseId: string;
  query: string;
  hitComponentIds: string[];
  qualityFlags: string[];
  status: "hit" | "miss";
  createdAt: string;
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

export async function listReleases(): Promise<ReleaseRecord[]> {
  return (await getJson<{ releases: ReleaseRecord[] }>("/api/releases")).releases;
}

export async function listAgentEvents(): Promise<AgentEvent[]> {
  return (await getJson<{ events: AgentEvent[] }>("/api/agent/events")).events;
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
