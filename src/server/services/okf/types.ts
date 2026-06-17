// src/server/services/okf/types.ts
// P1 subset of the OKF contracts defined in docs/OKF开发文档.md §3.

export type OkfIssueLayer = "okf_conformance" | "kh_publish_quality";

export type OkfIssueType =
  | "missing_frontmatter"
  | "unparseable_yaml"
  | "missing_type"
  | "obsidian_link"
  | "broken_link"
  | "missing_description"
  | "missing_tags"
  | "missing_timestamp"
  | "missing_resource"
  | "missing_citation";

export interface OkfIssue {
  okfPath: string; // POSIX, leading slash, e.g. /systems/成就.md
  issueType: OkfIssueType;
  layer: OkfIssueLayer;
  blocking: boolean;
  message: string;
}

export interface ConformanceReport {
  okfVersion: "0.1";
  exporterVersion: number;
  scannedAt: string; // ISO 8601, injected by caller
  conceptCount: number;
  referenceCount: number;
  issues: OkfIssue[];
  summary: { blocking: number; warning: number; info: number };
  linkSummary: { resolved: number; ambiguous: number; unresolved: number };
  citationSummary: { required: number; present: number };
}

export const OKF_EXPORTER_VERSION = 1;
