import type { SourceFileEntry, PipelineStage, QualityFinding } from "../../types";
import type { PipelineModelConfig } from "./modelConfig";

export interface RunWorkspace {
  runId: string;
  workspaceDir: string;
  dataDir: string;
  files: SourceFileEntry[];
}

export interface BuildPipelineOptions {
  versionId: string;
  bundleId: string;
  requestedBy: string;
  stages: PipelineStage[];
  model: string;
  modelConfig?: PipelineModelConfig;
  force: boolean;
  only: string | null;
  qualityProfileId: string;
  traceId?: string;
  rebuildTaskId?: string;
  /** Explicit maintenance mode: may write LLM-drafted aliases into the persistent translation table. Off by default. */
  generateAliases?: boolean;
}

export interface StageResult {
  stage: PipelineStage;
  status: "completed" | "skipped";
  outputPaths: string[];
  warnings: string[];
}

export interface CollectedArtifact {
  artifactId: string;
  group: "wiki" | "index" | "graph" | "table" | "evidence" | "quality" | "release";
  kind: string;
  title: string;
  legacyPath: string;
  storageUri: string;
  sourceRefs: string[];
  quality: Record<string, unknown>;
}

export interface QualityGateResult {
  overallScore: number;
  blockingCount: number;
  warningCount: number;
  findings: QualityFinding[];
  componentQuality: Record<string, Record<string, unknown>>;
  dismissedRules?: Array<{ ruleId: string; componentRef: string }>;
}
