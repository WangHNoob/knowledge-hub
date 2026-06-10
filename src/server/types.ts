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
  path: string;
  sqlite: import("node:sqlite").DatabaseSync;
  close(): void;
}

export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  displayName: string;
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
